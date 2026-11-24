/**
 * 池的核心流程（PRD working-copy-pool「执行工具」「切换流程」「新建流程」「中断恢复」）。
 * 约定：锁内只做 state.json 的读改写；svn、删除、释放占用都在锁外，用 phase 与 op 占位。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { UsageError } from "../../../shared/cli";
import { prepareExclusiveAccess } from "../../../shared/occupants";
import { appendLog } from "../../../shared/svn-run";
import { svnCheckAndUpdate } from "../../../shared/svn-update";
import { displayTime } from "../../../shared/time";
import type { ToolRunContext } from "../../../shared/types";
import { archiveChanges, createLink, isLink, linkExists, linkTarget, removeLink, samePath } from "./archive";
import { branchFromUrl, branchUrl, isBranchName, leaseUntil, loadConfig, sameUrl, type PoolConfig } from "./config";
import {
  appendHistory,
  branchDirName,
  branchLink,
  ensureLayout,
  isIdle,
  isInterrupted,
  isResident,
  laterLease,
  leaseActive,
  mutate,
  nextSlotId,
  pidAlive,
  poolPaths,
  readState,
  slotDir,
  type Lease,
  type PoolPaths,
  type PoolState,
  type Slot,
  type SlotOp,
} from "./state";
import { applySparse, behindCount, Cancelled, isObstruction, sparseCheckout, svn, svnBusy, svnInfo, svnStatus, SvnError, type SvnCtx } from "./svn";
import { describeSparse, isFullCheckout } from "./sparse";
import { assertStorageParent, checkCreationSpace, selectSlotPath, StorageOwnershipError } from "./storage";
import { runBeforeUpdate } from "./hooks";

export type Pool = {
  root: string;
  paths: PoolPaths;
  config: PoolConfig;
  ctx: ToolRunContext;
  now: () => Date;
};

export function openPool(ctx: ToolRunContext, now: () => Date = () => new Date()): Pool {
  const root = path.resolve(ctx.cwd);
  const config = loadConfig(root);
  const paths = poolPaths(root);
  ensureLayout(paths);
  return { root, paths, config, ctx, now };
}

function svnCtx(pool: Pool): SvnCtx {
  return { ...pool.ctx, cwd: pool.root };
}

function stage(pool: Pool, message: string): void {
  pool.ctx.onProgress?.(message, null);
  appendLog(pool.ctx.logFile, `[workingCopyPool] ${message}`);
}

export function timeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function fmtTime(iso: string | undefined): string {
  if (!iso) return "";
  if (iso === "forever") return "永久";
  return displayTime(iso, timeZone()).slice(5, 16);
}

export function describeLease(lease: Lease | null | undefined, now: Date): string {
  if (!leaseActive(lease, now)) return "";
  const until = lease!.until === "forever" ? "永久" : `到 ${fmtTime(lease!.until)}`;
  return `${until}${lease!.tag ? `（${lease!.tag}）` : ""}`;
}

// ---------------------------------------------------------------- 结构化状态

export type SlotView = {
  id: string;
  branch: string;
  /** 推导后的状态。 */
  state: "occupied" | "resident" | "idle" | "switching" | "blocked" | "retiring" | "interrupted";
  phase: Slot["phase"];
  lease: Lease | null;
  lastUsed: string | null;
  behind: number | null;
  blockedReason: string | null;
  path: string;
  link: string | null;
  target: string | null;
};

export function slotState(slot: Slot, config: PoolConfig, now: Date): SlotView["state"] {
  if (slot.op && !pidAlive(slot.op.pid)) return "interrupted";
  if (slot.phase === "switching") return "switching";
  if (slot.phase === "retiring") return "retiring";
  if (slot.phase === "blocked") return "blocked";
  if (leaseActive(slot.lease, now)) return "occupied";
  if (isResident(slot, config)) return "resident";
  return "idle";
}

export function viewSlots(pool: Pool, state: PoolState): SlotView[] {
  const now = pool.now();
  return state.slots.map((slot) => ({
    id: slot.id,
    branch: slot.branch,
    state: slotState(slot, pool.config, now),
    phase: slot.phase,
    lease: leaseActive(slot.lease, now) ? slot.lease! : null,
    lastUsed: slot.lastUsed ?? null,
    behind: typeof slot.behind === "number" ? slot.behind : null,
    blockedReason: slot.blockedReason ?? null,
    path: slotDir(pool.paths, slot),
    link: slot.branch ? branchLink(pool.paths, slot.branch) : null,
    target: slot.op?.target ?? null,
  }));
}

export function poolView(pool: Pool, state: PoolState): { root: string; maxSlots: number; resident: string[]; storage: PoolConfig["storage"]; slots: SlotView[] } {
  return { root: pool.root, maxSlots: pool.config.maxSlots, resident: pool.config.resident,
    storage: { ...pool.config.storage, roots: pool.config.storage.roots.length ? pool.config.storage.roots : [pool.paths.slots] },
    slots: viewSlots(pool, state) };
}

const STATE_TEXT: Record<SlotView["state"], string> = {
  occupied: "占用",
  resident: "常驻",
  idle: "空闲",
  switching: "切换中",
  blocked: "阻塞",
  retiring: "删除中",
  interrupted: "中断待恢复",
};

export function describeSlot(view: SlotView, now: Date): string {
  const parts = [`${view.id} ${view.branch || "(未定)"}`, STATE_TEXT[view.state]];
  if (view.lease) parts.push(`租约${describeLease(view.lease, now)}`);
  if (view.target && (view.state === "switching" || view.state === "interrupted")) parts.push(`→ ${view.target}`);
  if (view.behind !== null && view.behind > 0) parts.push(`落后 ${view.behind}`);
  if (view.blockedReason) parts.push(view.blockedReason);
  if (view.lastUsed) parts.push(`最后使用 ${fmtTime(view.lastUsed)}`);
  return parts.join("，");
}

// ---------------------------------------------------------------- 释放占用

/** Windows 上释放槽位目录的占用进程（IDE 只请求正常关闭）；其他平台什么都不做。 */
async function releaseSlotOccupants(pool: Pool, wc: string): Promise<string | undefined> {
  if (process.platform !== "win32" || !existsSync(wc)) return undefined;
  stage(pool, `释放 ${path.basename(wc)} 的占用`);
  const prepared = await prepareExclusiveAccess({ target: wc, abortSignal: pool.ctx.abortSignal, includeUnityByName: false });
  if (prepared.remaining.length > 0) {
    throw new Error(`无法释放占用：${prepared.remaining.map((o) => `${o.name}(${o.pid})`).join(", ")}，请先关闭后再试`);
  }
  if (prepared.closed.length === 0) return undefined;
  return `已关闭 ${prepared.closed.map((o) => `${o.name}(${o.pid})`).join(", ")}`;
}

/** 删链接；Windows 上目录被 IDE 打开时可能失败，释放占用后重试一次（PRD「风险」）。 */
async function dropLink(pool: Pool, link: string, wc: string, notes: string[]): Promise<void> {
  try {
    removeLink(link);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    const released = await releaseSlotOccupants(pool, wc);
    if (released) notes.push(released);
    removeLink(link);
  }
}

function restoreLink(pool: Pool, slot: Slot): void {
  if (!slot.branch) return;
  try {
    createLink(slotDir(pool.paths, slot), branchLink(pool.paths, slot.branch));
  } catch (error) {
    appendLog(pool.ctx.logFile, `[workingCopyPool] 恢复链接失败 ${slot.branch}: ${String(error)}`);
  }
}

function findSlot(state: PoolState, id: string): Slot {
  const slot = state.slots.find((s) => s.id === id);
  if (!slot) throw new Error(`槽位 ${id} 不在状态文件里（被其他进程删了？）`);
  return slot;
}

function ourOp(slot: Slot): boolean {
  return slot.op?.pid === process.pid;
}

// ---------------------------------------------------------------- 中断恢复

/**
 * 工具启动时调用：接手所有 op 记录的进程已不存在的槽位。
 * 1. 工作副本被锁且没有 svn 进程占用：svn cleanup；有 svn 在跑就跳过，不 cleanup。
 * 2. URL 与目标一致且没有未完成的操作：补建链接设 ready；否则设 ready，branch 记为实际分支（不完整时记空），留给下次 acquire。
 * 3. 读不出 svn info（新建中断）：删除槽位目录。
 */
export async function recover(pool: Pool): Promise<string[]> {
  const claimed = await mutate(pool.paths, (state) => {
    const out: Array<{ id: string; op: SlotOp; branch: string }> = [];
    for (const slot of state.slots) {
      if (!isInterrupted(slot)) continue;
      out.push({ id: slot.id, op: { ...slot.op! }, branch: slot.branch });
      slot.op = { ...slot.op!, pid: process.pid, at: pool.now().toISOString() };
    }
    return out;
  });
  const notes: string[] = [];
  for (const item of claimed) {
    try {
      notes.push(await recoverSlot(pool, item.id, item.op, item.branch));
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      const message = error instanceof Error ? error.message : String(error);
      await mutate(pool.paths, (state) => {
        const slot = state.slots.find((s) => s.id === item.id);
        if (slot && ourOp(slot)) {
          slot.phase = "blocked";
          slot.blockedReason = `中断恢复失败：${message}`;
          if (error instanceof StorageOwnershipError) slot.ownershipUnconfirmed = true;
          slot.op = undefined;
        }
      });
      notes.push(`${item.id} 中断恢复失败，已标为阻塞：${message}`);
    }
  }
  return notes;
}

async function recoverSlot(pool: Pool, id: string, op: SlotOp, branch: string): Promise<string> {
  const slot = findSlot(readState(pool.paths), id);
  const wc = slotDir(pool.paths, slot);
  if (slot.path) assertStorageParent(wc);
  if (slot.path && op.kind === "create" && !op.created && existsSync(wc)) {
    throw new StorageOwnershipError(`新建目录所有权未确认：${wc}；保留目录与槽位记录，请人工检查`);
  }
  const sctx = svnCtx(pool);
  const removeSlot = async (why: string): Promise<string> => {
    if (existsSync(wc)) rmSync(wc, { recursive: true, force: true, maxRetries: 3 });
    await mutate(pool.paths, (state) => {
      state.slots = state.slots.filter((s) => s.id !== id);
    });
    return `${id} ${why}，已删除槽位`;
  };

  if (op.kind === "delete") return removeSlot("删除中断");
  if (!existsSync(path.join(wc, ".svn"))) return removeSlot(op.kind === "create" ? "新建中断" : "工作副本缺失");

  if (await svnBusy(wc, pool.ctx.abortSignal)) {
    // 有别的 svn 进程在操作这个工作副本：不 cleanup，交还给下一次运行
    await mutate(pool.paths, (state) => {
      const slot = state.slots.find((s) => s.id === id);
      if (slot && ourOp(slot)) slot.op = op;
    });
    return `${id} 有 svn 进程正在操作，暂不恢复`;
  }

  let info = await svnInfo(sctx, wc);
  const st0 = info ? await svnStatus(sctx, wc).catch(() => undefined) : undefined;
  if (!info || !st0 || st0.wcLocked) {
    stage(pool, `${id} svn cleanup`);
    await svn(sctx, ["cleanup", wc], { allowFail: true });
    info = await svnInfo(sctx, wc);
  }
  if (!info) {
    if (op.kind === "create") return removeSlot("新建中断");
    throw new Error("读不出 svn info");
  }
  const st = await svnStatus(sctx, wc);
  const actual = branchFromUrl(pool.config, info.url) ?? "";
  const target = op.kind === "create" || op.kind === "switch" ? op.target : branch;
  let complete = Boolean(target) && sameUrl(info.url, branchUrl(pool.config, target!)) && !st.incomplete && !st.wcLocked;
  if (complete && op.kind === "create" && !isFullCheckout(pool.config.sparse)) {
    // 新建可能停在逐层展开的中途：补齐深度
    await applySparse(sctx, wc, pool.config.sparse);
  }
  const done = await mutate(pool.paths, (state) => {
    const slot = findSlot(state, id);
    if (!ourOp(slot)) return false;
    slot.url = info!.url;
    slot.branch = complete ? target! : st.incomplete ? "" : actual;
    slot.phase = "ready";
    slot.blockedReason = undefined;
    slot.op = undefined;
    return true;
  });
  if (!done) return `${id} 已被其他进程接手`;
  const fresh = findSlot(readState(pool.paths), id);
  if (fresh.branch) restoreLink(pool, fresh);
  complete = complete && Boolean(fresh.branch);
  return complete ? `${id} 中断前已完成 ${target}，已补建入口` : `${id} 中断时未完成${target ? ` ${target}` : ""}，当前 ${fresh.branch || "状态不明"}，下次占用时重新切换`;
}

// ---------------------------------------------------------------- acquire

export type AcquireOutcome = {
  slot: string;
  branch: string;
  mode: "hit" | "switch" | "create";
  behind?: number;
  notes: string[];
};

type Claim =
  | { kind: "hit"; slot: Slot }
  | { kind: "switch"; slot: Slot }
  | { kind: "create"; slot: Slot }
  | { kind: "busy"; slot: Slot }
  | { kind: "full"; slots: Slot[] };

/** 选槽位（锁内调用）：已在该分支 → 空闲中 lastUsed 最早 → 新建 → 池满。 */
export function claimSlot(state: PoolState, config: PoolConfig, branch: string, lease: Lease | null, now: Date, excluded: Set<string> = new Set(), allocate?: (id: string) => string): Claim {
  const existing = state.slots.find((s) => s.branch === branch && (s.phase === "ready" || s.phase === "blocked") && !s.op);
  if (existing) {
    if (lease) existing.lease = laterLease(leaseActive(existing.lease, now) ? existing.lease : null, lease);
    existing.lastUsed = now.toISOString();
    return { kind: "hit", slot: { ...existing } };
  }
  const moving = state.slots.find((s) => s.op && (s.op.target === branch || s.branch === branch) && pidAlive(s.op.pid));
  if (moving) return { kind: "busy", slot: { ...moving } };

  const idle = state.slots
    .filter((s) => isIdle(s, config, now) && !s.op && !excluded.has(s.id))
    .sort((a, b) => (a.lastUsed ?? "").localeCompare(b.lastUsed ?? "") || a.id.localeCompare(b.id));
  const op = (kind: SlotOp["kind"], from?: string): SlotOp => ({ kind, target: branch, pid: process.pid, at: now.toISOString(), lease, from });
  if (idle.length > 0) {
    const slot = idle[0];
    slot.phase = "switching";
    slot.op = op("switch", slot.branch);
    return { kind: "switch", slot: { ...slot } };
  }
  if (state.slots.length < config.maxSlots) {
    const slot: Slot = { id: nextSlotId(state), branch: "", url: "", phase: "switching", lease: null, op: op("create") };
    if (allocate) slot.path = allocate(slot.id);
    state.slots.push(slot);
    return { kind: "create", slot: { ...slot } };
  }
  return { kind: "full", slots: state.slots.map((s) => ({ ...s })) };
}

export function describeFull(pool: Pool, slots: Slot[]): string {
  const now = pool.now();
  const lines = viewSlots(pool, { version: 1, slots }).map((v) => `  ${describeSlot(v, now)}`);
  return `池满（${slots.length}/${pool.config.maxSlots}），没有可用槽位：\n${lines.join("\n")}\n可以释放一个分支、等租约到期，或调大 pool.toml 的 maxSlots`;
}

/**
 * 占用或准备一个分支。lease 为 null 表示只准备不加租约（refresh 准备常驻分支）。
 * 选中的空闲槽位被阻塞（改动无法存档）时换下一个。
 */
export async function obtain(pool: Pool, branch: string, lease: Lease | null): Promise<AcquireOutcome> {
  if (!isBranchName(branch)) throw new UsageError(`分支名不合法：${branch}`);
  const url = branchUrl(pool.config, branch);
  const sctx = svnCtx(pool);
  const notes: string[] = [];

  const peek = readState(pool.paths).slots.some((s) => s.branch === branch && (s.phase === "ready" || s.phase === "blocked") && !s.op);
  if (!peek) {
    stage(pool, `检查分支 ${branch}`);
    const remote = await svnInfo(sctx, url);
    if (!remote) throw new Error(`分支不存在或仓库不可达：${url}`);
  }

  const skipped = new Set<string>();
  for (;;) {
    const now = pool.now();
    const claim = await mutate(pool.paths, (state) => claimSlot(state, pool.config, branch, lease, now, skipped,
      (id) => selectSlotPath(pool.paths, state, id, pool.config.storage)));
    if (claim.kind === "full") throw new Error(describeFull(pool, claim.slots));
    if (claim.kind === "busy") throw new Error(`${branch} 正在 ${claim.slot.id} 上被另一个任务处理，稍后再试`);
    if (claim.kind === "hit") {
      const wc = slotDir(pool.paths, claim.slot);
      if (claim.slot.path) assertStorageParent(wc);
      restoreLink(pool, claim.slot);
      if (claim.slot.phase === "blocked") notes.push(`注意：${claim.slot.id} 处于阻塞（${claim.slot.blockedReason ?? "原因未记录"}），请先处理`);
      const behind = await behindCount(sctx, wc).catch(() => undefined);
      await mutate(pool.paths, (state) => {
        const slot = state.slots.find((s) => s.id === claim.slot.id);
        if (slot && behind !== undefined) slot.behind = behind;
      });
      if (lease) appendHistory(pool.paths, { at: now.toISOString(), action: "acquire", branch, slot: claim.slot.id });
      return { slot: claim.slot.id, branch, mode: "hit", behind, notes };
    }

    const result = claim.kind === "create" ? await createFlow(pool, claim.slot, branch, url, notes) : await switchFlow(pool, claim.slot, branch, url, notes);
    if (result === "blocked") {
      skipped.add(claim.slot.id);
      continue;
    }
    const wc = slotDir(pool.paths, claim.slot);
    const behind = await behindCount(sctx, wc).catch(() => undefined);
    const done = pool.now();
    await mutate(pool.paths, (state) => {
      const slot = findSlot(state, claim.slot.id);
      slot.phase = "ready";
      slot.branch = branch;
      slot.url = result.url;
      slot.lease = lease;
      slot.lastUsed = done.toISOString();
      slot.behind = behind;
      slot.blockedReason = undefined;
      slot.op = undefined;
    });
    createLink(wc, branchLink(pool.paths, branch));
    appendHistory(pool.paths, { at: done.toISOString(), action: lease ? "acquire" : "prepare", branch, slot: claim.slot.id });
    return { slot: claim.slot.id, branch, mode: claim.kind, behind, notes };
  }
}

async function finishCheck(pool: Pool, wc: string, url: string): Promise<{ url: string }> {
  const info = await svnInfo(svnCtx(pool), wc);
  if (!info) throw new Error("切换后读不出 svn info");
  if (!sameUrl(info.url, url)) throw new Error(`切换后 URL 不符：${info.url}，应为 ${url}`);
  return { url: info.url };
}

async function switchFlow(pool: Pool, claimed: Slot, branch: string, url: string, notes: string[]): Promise<{ url: string } | "blocked"> {
  const wc = slotDir(pool.paths, claimed);
  const sctx = svnCtx(pool);
  const from = claimed.branch;
  const back = async (patch: Partial<Slot>): Promise<void> => {
    await mutate(pool.paths, (state) => {
      const slot = findSlot(state, claimed.id);
      Object.assign(slot, { phase: "ready", op: undefined }, patch);
    });
    const fresh = findSlot(readState(pool.paths), claimed.id);
    restoreLink(pool, fresh);
  };
  if (claimed.path) {
    try { assertStorageParent(wc); } catch (error) {
      await back({ phase: "blocked", blockedReason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  stage(pool, `${claimed.id}：${from || "(未定)"} → ${branch}`);
  if (from) {
    const link = branchLink(pool.paths, from);
    if (linkExists(link) && samePath(linkTarget(link), wc)) await dropLink(pool, link, wc, notes);
  }

  try {
    stage(pool, `${claimed.id}：存档本地改动`);
    const archived = await archiveChanges(sctx, pool.paths, wc, from, pool.now());
    if (archived.blocked) {
      await back({ phase: "blocked", blockedReason: archived.blocked });
      notes.push(`${claimed.id}（${from}）有需要人处理的问题，已标为阻塞：${archived.blocked}`);
      return "blocked";
    }
    if (archived.dir) notes.push(`${from} 的改动已存档到 ${archived.dir}（受控 ${archived.versioned}，未纳管 ${archived.unversioned}）`);
  } catch (error) {
    if (error instanceof Cancelled) throw error;
    await back({});
    throw error;
  }

  try {
    const released = await releaseSlotOccupants(pool, wc);
    if (released) notes.push(released);
  } catch (error) {
    await back({});
    throw error;
  }

  try {
    stage(pool, `${claimed.id}：svn switch ${url}`);
    await svn(sctx, ["switch", "--ignore-ancestry", url, wc], { wc, progress: "切换" });
    const sparse = await applySparse(sctx, wc, pool.config.sparse);
    if (sparse.length) notes.push(`稀疏：${sparse.join("；")}`);
    return await finishCheck(pool, wc, url);
  } catch (error) {
    if (error instanceof Cancelled) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const info = await svnInfo(sctx, wc).catch(() => undefined);
    const actual = info ? branchFromUrl(pool.config, info.url) ?? "" : "";
    if (error instanceof SvnError && isObstruction(`${message}\n${error.output}`)) {
      await back({ phase: "blocked", blockedReason: `切换到 ${branch} 被阻碍：${message}`, branch: actual, url: info?.url ?? "" });
      notes.push(`${claimed.id} 切换被阻碍，已标为阻塞：${message}`);
      return "blocked";
    }
    await back({ branch: actual === branch ? "" : actual, url: info?.url ?? "" });
    throw error;
  }
}

async function createFlow(pool: Pool, claimed: Slot, branch: string, url: string, notes: string[]): Promise<{ url: string }> {
  const wc = slotDir(pool.paths, claimed);
  const sctx = svnCtx(pool);
  const spec = pool.config.sparse;
  let created = false;
  stage(pool, `${claimed.id}：新建 ${branch}${isFullCheckout(spec) ? "" : `（${describeSparse(spec)[0]}）`}，实际目录 ${wc}`);
  try {
    checkCreationSpace(wc, pool.config.storage.minFreeGiB);
    mkdirSync(wc);
    created = true;
    await mutate(pool.paths, (state) => {
      const slot = findSlot(state, claimed.id);
      if (!ourOp(slot)) throw new Error(`${claimed.id} 新建操作已被其他进程接手`);
      slot.op!.created = true;
    });
    await sparseCheckout(sctx, url, wc, spec);
    notes.push(`新建槽位 ${claimed.id}`);
    return await finishCheck(pool, wc, url);
  } catch (error) {
    if (error instanceof Cancelled && created) throw error;
    if (created) {
      try { assertStorageParent(wc); } catch (storageError) {
        await mutate(pool.paths, (state) => {
          const slot = findSlot(state, claimed.id);
          slot.phase = "blocked";
          slot.blockedReason = storageError instanceof Error ? storageError.message : String(storageError);
          slot.op = undefined;
        });
        throw storageError;
      }
      rmSync(wc, { recursive: true, force: true, maxRetries: 3 });
    }
    await mutate(pool.paths, (state) => {
      state.slots = state.slots.filter((s) => s.id !== claimed.id);
    });
    throw error;
  }
}

export function acquireSummary(outcome: AcquireOutcome): string {
  const mode = { hit: "已在池中", switch: "切换", create: "新建" }[outcome.mode];
  const behind = outcome.behind === undefined ? "落后未知" : `落后 ${outcome.behind}`;
  return `${outcome.branch} 就绪（${outcome.slot}，${mode}，${behind}）`;
}

// ---------------------------------------------------------------- release

export async function releaseBranch(pool: Pool, branch: string): Promise<{ released: boolean; slot?: string; detail: string }> {
  const now = pool.now();
  const result = await mutate(pool.paths, (state) => {
    const slot = state.slots.find((s) => s.branch === branch);
    if (!slot) return { released: false, detail: `${branch} 不在池里` };
    if (!leaseActive(slot.lease, now)) {
      slot.lease = null;
      return { released: false, slot: slot.id, detail: `${branch}（${slot.id}）没有有效租约` };
    }
    slot.lease = null;
    return { released: true, slot: slot.id, detail: `已释放 ${branch}（${slot.id}），工作副本留在原分支` };
  });
  if (result.released) appendHistory(pool.paths, { at: now.toISOString(), action: "release", branch, slot: result.slot });
  return result;
}

// ---------------------------------------------------------------- gc

export type GcReport = { recovered: string[]; unblocked: string[]; blocked: string[]; retired: string[]; pendingShrink: string[]; links: string[]; patches: number; errors: string[] };

export async function gc(pool: Pool): Promise<GcReport> {
  const report: GcReport = { recovered: await recover(pool), unblocked: [], blocked: [], retired: [], pendingShrink: [], links: [], patches: 0, errors: [] };
  const sctx = svnCtx(pool);

  // 复查阻塞槽位
  for (const slot of readState(pool.paths).slots.filter((s) => s.phase === "blocked" && !s.op)) {
    const wc = slotDir(pool.paths, slot);
    try {
      if (slot.ownershipUnconfirmed) {
        report.blocked.push(`${slot.id} ${slot.branch}：${slot.blockedReason ?? "目录所有权需要人工确认"}`);
        continue;
      }
      if (slot.path) assertStorageParent(wc);
      const info = await svnInfo(sctx, wc);
      if (!info) {
        report.blocked.push(`${slot.id} ${slot.branch}：工作副本不可访问，保留阻塞与记录`);
        continue;
      }
      const st = await svnStatus(sctx, wc);
      if (st.problems.length > 0 || st.wcLocked) {
        report.blocked.push(`${slot.id} ${slot.branch}：${st.problems.join("；") || "工作副本被锁"}`);
        continue;
      }
      await mutate(pool.paths, (state) => {
        const s = state.slots.find((x) => x.id === slot.id);
        if (!s || s.phase !== "blocked" || s.op) return;
        s.phase = "ready";
        s.blockedReason = undefined;
        if (info) {
          s.url = info.url;
          s.branch = st.incomplete ? "" : branchFromUrl(pool.config, info.url) ?? "";
        }
      });
      report.unblocked.push(`${slot.id} ${slot.branch}`);
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      report.errors.push(`${slot.id} 复查失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 缩容
  const tried = new Set<string>();
  for (;;) {
    const now = pool.now();
    const pick = await mutate(pool.paths, (state) => {
      if (state.slots.length <= pool.config.maxSlots) return undefined;
      const idle = state.slots
        .filter((s) => isIdle(s, pool.config, now) && !s.op && !tried.has(s.id))
        .sort((a, b) => (a.lastUsed ?? "").localeCompare(b.lastUsed ?? "") || b.id.localeCompare(a.id));
      if (idle.length === 0) return { none: state.slots.length - pool.config.maxSlots };
      const slot = idle[0];
      slot.phase = "retiring";
      slot.op = { kind: "delete", pid: process.pid, at: now.toISOString(), from: slot.branch };
      return { slot: { ...slot } };
    });
    if (!pick) break;
    if ("none" in pick) {
      report.pendingShrink.push(`还需缩减 ${pick.none} 个槽位，等租约结束或阻塞处理后再回收`);
      break;
    }
    tried.add(pick.slot.id);
    try {
      report.retired.push(await retireSlot(pool, pick.slot));
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      report.errors.push(`${pick.slot.id} 删除失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  report.links = syncLinks(pool);
  report.patches = prunePatches(pool);
  return report;
}

async function retireSlot(pool: Pool, claimed: Slot): Promise<string> {
  const wc = slotDir(pool.paths, claimed);
  const notes: string[] = [];
  const back = async (patch: Partial<Slot>): Promise<void> => {
    await mutate(pool.paths, (state) => {
      const slot = findSlot(state, claimed.id);
      Object.assign(slot, { phase: "ready", op: undefined }, patch);
    });
    restoreLink(pool, findSlot(readState(pool.paths), claimed.id));
  };
  if (claimed.path) {
    try { assertStorageParent(wc); } catch (error) {
      await back({ phase: "blocked", blockedReason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
  if (claimed.branch) {
    const link = branchLink(pool.paths, claimed.branch);
    if (linkExists(link) && samePath(linkTarget(link), wc)) await dropLink(pool, link, wc, notes);
  }
  if (existsSync(path.join(wc, ".svn"))) {
    const archived = await archiveChanges(svnCtx(pool), pool.paths, wc, claimed.branch, pool.now()).catch(async (error) => {
      if (error instanceof Cancelled) throw error;
      await back({});
      throw error;
    });
    if (archived.blocked) {
      await back({ phase: "blocked", blockedReason: archived.blocked });
      return `${claimed.id} 有需要人处理的问题，暂不删除：${archived.blocked}`;
    }
    if (archived.dir) notes.push(`改动已存档到 ${archived.dir}`);
  }
  try {
    const released = await releaseSlotOccupants(pool, wc);
    if (released) notes.push(released);
  } catch (error) {
    await back({});
    throw error;
  }
  stage(pool, `删除槽位 ${claimed.id}`);
  rmSync(wc, { recursive: true, force: true, maxRetries: 3 });
  await mutate(pool.paths, (state) => {
    state.slots = state.slots.filter((s) => s.id !== claimed.id);
  });
  return `已删除 ${claimed.id}（${claimed.branch || "未定"}）${notes.length ? `：${notes.join("；")}` : ""}`;
}

/** 补建就绪槽位的入口，清理指向不存在槽位或与状态不符的链接；只删链接，不碰真实目录。 */
export function syncLinks(pool: Pool): string[] {
  const state = readState(pool.paths);
  const notes: string[] = [];
  const wanted = new Map<string, string>();
  for (const slot of state.slots) {
    if (!slot.branch || slot.op || (slot.phase !== "ready" && slot.phase !== "blocked")) continue;
    wanted.set(branchDirName(slot.branch), slotDir(pool.paths, slot));
  }
  const busyDirs = new Set(state.slots.filter((s) => s.op).map((s) => slotDir(pool.paths, s)));
  if (existsSync(pool.paths.branch)) {
    for (const name of readdirSync(pool.paths.branch)) {
      const link = path.join(pool.paths.branch, name);
      if (!isLink(link)) continue;
      const target = linkTarget(link);
      const want = wanted.get(name);
      if (want && samePath(target, want)) continue;
      if (!want && target && [...busyDirs].some((d) => samePath(d, target))) continue;
      try {
        removeLink(link);
        notes.push(`删除失效入口 branch/${name}`);
      } catch (error) {
        notes.push(`删除入口 branch/${name} 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  for (const [name, dir] of wanted) {
    const link = path.join(pool.paths.branch, name);
    if (isLink(link) && samePath(linkTarget(link), dir)) continue;
    if (!existsSync(dir)) continue;
    try {
      createLink(dir, link);
      notes.push(`补建入口 branch/${name}`);
    } catch (error) {
      notes.push(`补建入口 branch/${name} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return notes;
}

/** 删除超过 patchRetentionDays 的存档目录（按目录修改时间），返回删除数。 */
export function prunePatches(pool: Pool): number {
  const cutoff = pool.now().getTime() - pool.config.patchRetentionDays * 86_400_000;
  let removed = 0;
  if (!existsSync(pool.paths.patches)) return 0;
  for (const branch of readdirSync(pool.paths.patches)) {
    const dir = path.join(pool.paths.patches, branch);
    if (!statSync(dir).isDirectory()) continue;
    for (const stamp of readdirSync(dir)) {
      const entry = path.join(dir, stamp);
      try {
        if (statSync(entry).mtimeMs < cutoff) {
          rmSync(entry, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // 跳过
      }
    }
    try {
      if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
    } catch {
      // 跳过
    }
  }
  return removed;
}

// ---------------------------------------------------------------- refresh

export type RefreshItem = { branch: string; ok: boolean; skipped?: boolean; detail: string };

export async function refresh(pool: Pool): Promise<{ recovered: string[]; items: RefreshItem[] }> {
  const recovered = await recover(pool);
  const items: RefreshItem[] = [];
  for (const branch of pool.config.resident) {
    try {
      items.push(await refreshOne(pool, branch));
    } catch (error) {
      if (error instanceof Cancelled || pool.ctx.abortSignal.aborted) throw error instanceof Cancelled ? error : new Cancelled("已取消");
      items.push({ branch, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return { recovered, items };
}

async function refreshOne(pool: Pool, branch: string): Promise<RefreshItem> {
  const now = pool.now();
  const claim = await mutate(pool.paths, (state) => {
    const slot = state.slots.find((s) => s.branch === branch || s.op?.target === branch);
    if (!slot) return { kind: "absent" as const };
    if (slot.op) return { kind: "skip" as const, why: `${slot.id} 正在被另一个任务处理` };
    if (slot.ownershipUnconfirmed) return { kind: "skip" as const, why: `${slot.id} 目录所有权未确认，需人工检查` };
    const retryBlocked = slot.phase === "blocked" && pool.config.hooks?.retryBlocked === true;
    if (slot.phase === "blocked" && !retryBlocked) return { kind: "skip" as const, why: `${slot.id} 阻塞：${slot.blockedReason ?? ""}` };
    if (slot.phase !== "ready" && !retryBlocked) return { kind: "skip" as const, why: `${slot.id} ${slot.phase}` };
    if (leaseActive(slot.lease, now)) return { kind: "skip" as const, why: `${slot.id} 被占用${describeLease(slot.lease, now)}，不抢` };
    slot.op = { kind: "update", target: branch, pid: process.pid, at: now.toISOString() };
    return { kind: "update" as const, slot: { ...slot } };
  });

  if (claim.kind === "skip") return { branch, ok: true, skipped: true, detail: `跳过：${claim.why}` };
  if (claim.kind === "absent") {
    try {
      const outcome = await obtain(pool, branch, null);
      return { branch, ok: true, detail: `已准备（${outcome.slot}，${outcome.mode === "create" ? "新建" : "切换"}）${outcome.notes.length ? `：${outcome.notes.join("；")}` : ""}` };
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("池满")) return { branch, ok: false, detail: "未就绪：池满" };
      throw error;
    }
  }

  const wc = slotDir(pool.paths, claim.slot);
  const sctx = svnCtx(pool);
  stage(pool, `更新 ${branch}（${claim.slot.id}）`);
  try {
    if (claim.slot.path) assertStorageParent(wc);
    if (pool.config.hooks?.beforeUpdate) {
      if (await svnBusy(wc, pool.ctx.abortSignal)) throw new Error("有 SVN 进程正在处理槽位，未执行项目钩子");
      await releaseSlotOccupants(pool, wc);
      await runBeforeUpdate(pool.config, pool.ctx, wc);
      const status = await svnStatus(sctx, wc);
      if (status.problems.length) throw new Error(`项目钩子后仍有需要人工处理的问题：${status.problems.join("；")}`);
      if (status.switched) throw new Error("项目钩子后仍有 switched 路径，保留现场，请人工确认分支归属");
    }
    const result = await svnCheckAndUpdate({
      workingCopy: wc,
      timeoutMs: pool.ctx.timeoutMs,
      logFile: pool.ctx.logFile,
      abortSignal: pool.ctx.abortSignal,
      skipUpdate: false,
      onConflict: "fail",
      releaseOccupants: true,
      onProgress: (message, percent) => pool.ctx.onProgress?.(`${branch}：${message}`, percent),
    });
    const sparse = await applySparse(sctx, wc, pool.config.sparse);
    const behind = await behindCount(sctx, wc).catch(() => undefined);
    await mutate(pool.paths, (state) => {
      const slot = state.slots.find((s) => s.id === claim.slot.id);
      if (!slot || !ourOp(slot)) return;
      slot.op = undefined;
      slot.phase = "ready";
      slot.blockedReason = undefined;
      if (behind !== undefined) slot.behind = behind;
    });
    const last = result.detail.split(/\r?\n/).filter(Boolean).pop() ?? "完成";
    return { branch, ok: true, detail: `已更新（${claim.slot.id}，落后 ${behind ?? "未知"}）${sparse.length ? `；稀疏：${sparse.join("；")}` : ""}；${last}` };
  } catch (error) {
    if (error instanceof Cancelled || pool.ctx.abortSignal.aborted) throw error;
    await mutate(pool.paths, (state) => {
      const slot = state.slots.find((s) => s.id === claim.slot.id);
      if (slot && ourOp(slot)) slot.op = undefined;
    });
    throw error;
  }
}

// ---------------------------------------------------------------- acquire 参数

export function resolveLease(pool: Pool, ttl: unknown, tag: unknown): Lease {
  const value = typeof ttl === "string" && ttl.trim() ? ttl.trim() : pool.config.defaultTtl;
  const lease: Lease = { until: leaseUntil(value, pool.now()) };
  if (typeof tag === "string" && tag.trim()) lease.tag = tag.trim();
  return lease;
}
