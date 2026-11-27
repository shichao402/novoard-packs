/**
 * 池的核心流程（PRD working-copy-pool「执行工具」「切换流程」「新建流程」「中断恢复」）。
 * 约定：锁内只做 state.json 的读改写；svn、删除、释放占用都在锁外，用 phase 与 op 占位。
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { UsageError } from "../../../shared/cli";
import { prepareExclusiveAccess } from "../../../shared/occupants";
import { appendLog } from "../../../shared/svn-run";
import { applySvnRules, describeBlocked, reportRules, RULE_HINT, RulesBlockedError, type RulesOutcome } from "../../../shared/svn-resolve";
import { discardSet, loadSvnRules, type SvnRules } from "../../../shared/svn-rules";
import { svnCheckAndUpdate } from "../../../shared/svn-update";
import { displayTime } from "../../../shared/time";
import type { ToolRunContext } from "../../../shared/types";
import { archiveChanges, archiveRootFor, createLink, isLink, linkExists, linkTarget, removeLink, samePath } from "./archive";
import { branchFromUrl, branchUrl, isBranchName, leaseUntil, loadConfig, sameUrl, type PoolConfig } from "./config";
import {
  appendHistory,
  branchDirName,
  branchLink,
  ensureLayout,
  isHeld,
  isIdle,
  isInterrupted,
  isProject,
  laterLease,
  leaseActive,
  mutate,
  nextSlotId,
  pidAlive,
  poolPaths,
  readState,
  slotDir,
  type Hold,
  type Lease,
  type PoolPaths,
  type PoolState,
  type Slot,
  type SlotOp,
} from "./state";
import { applySparse, behindCount, Cancelled, isObstruction, sparseCheckout, svn, svnBusy, svnInfo, svnStatus, SvnError, type SvnCtx } from "./svn";
import { describeSparse, isFullCheckout } from "./sparse";
import { assertStorageParent, checkCreationSpace, minFreeFor, selectSlotPath, StorageOwnershipError } from "./storage";

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

const loadedRules = new WeakMap<Pool, { rules: SvnRules; enable: string[] }>();

/** 池配置了 [svnRules] 时读取并校验规则文件（每次运行读一次）；没配置返回 undefined。 */
export function poolRules(pool: Pool): { rules: SvnRules; enable: string[] } | undefined {
  const cfg = pool.config.svnRules;
  if (!cfg) return undefined;
  let loaded = loadedRules.get(pool);
  if (!loaded) {
    const rules = loadSvnRules(cfg.file);
    discardSet(rules, cfg.enable);
    loaded = { rules, enable: cfg.enable };
    loadedRules.set(pool, loaded);
  }
  return loaded;
}

/** 按项目 SVN 规则处理槽位工作副本；存档放在 `patches/<分支>/<时间戳>`。没配置规则返回 undefined。 */
async function runPoolRules(pool: Pool, wc: string, branch: string, phase: string, archiveDir?: string): Promise<RulesOutcome | undefined> {
  const loaded = poolRules(pool);
  if (!loaded) return undefined;
  const sctx = svnCtx(pool);
  return applySvnRules({
    wc,
    cwd: sctx.cwd,
    run: (args, o) => svn(sctx, args, { wc, allowFail: o?.allowFail, timeoutMs: o?.timeoutMs }),
    rules: loaded.rules,
    enable: loaded.enable,
    archiveRoot: archiveRootFor(pool.paths, branch),
    archiveDir,
    now: pool.now(),
    phase,
    cleanupLocks: true,
    onStage: (message) => stage(pool, `${path.basename(wc)} ${message}`),
  });
}

/** 阻塞原因写进状态文件前截短，完整清单在存档 rules.json 里。 */
function shortReason(text: string): string {
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
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
  state: "occupied" | "held" | "idle" | "switching" | "blocked" | "retiring" | "interrupted";
  phase: Slot["phase"];
  lease: Lease | null;
  lastUsed: string | null;
  behind: number | null;
  blockedReason: string | null;
  path: string;
  link: string | null;
  target: string | null;
  /** 持有保护，按建立时间排序。 */
  holds: Array<{ id: string } & Hold>;
};

export function slotState(slot: Slot, now: Date): SlotView["state"] {
  if (slot.op && !pidAlive(slot.op.pid)) return "interrupted";
  if (slot.phase === "switching") return "switching";
  if (slot.phase === "retiring") return "retiring";
  if (slot.phase === "blocked") return "blocked";
  if (isHeld(slot)) return "held";
  if (leaseActive(slot.lease, now)) return "occupied";
  return "idle";
}

export function holdList(slot: Slot): SlotView["holds"] {
  return Object.entries(slot.holds ?? {})
    .map(([id, hold]) => ({ id, ...hold }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/** 持有者的可读名字：有 label 用 label，并带上 holdId 便于人工 unhold。 */
export function holdNames(slot: Pick<Slot, "holds"> | SlotView): string {
  const list = Array.isArray(slot.holds) ? slot.holds : holdList(slot as Slot);
  return list.map((h) => (h.label ? `${h.label}（${h.id}）` : h.id)).join("、");
}

export function viewSlots(pool: Pool, state: PoolState): SlotView[] {
  const now = pool.now();
  return state.slots.map((slot) => ({
    id: slot.id,
    branch: slot.branch,
    state: slotState(slot, now),
    phase: slot.phase,
    lease: leaseActive(slot.lease, now) ? slot.lease! : null,
    lastUsed: slot.lastUsed ?? null,
    behind: typeof slot.behind === "number" ? slot.behind : null,
    blockedReason: slot.blockedReason ?? null,
    path: slotDir(pool.paths, slot),
    link: slot.branch ? branchLink(pool.paths, slot.branch) : null,
    target: slot.op?.target ?? null,
    holds: holdList(slot),
  }));
}

export type PoolView = { root: string; maxSlots: number; projects: string[]; storage: PoolConfig["storage"]; slots: SlotView[] };

/** 结构化状态：projects 是工程清单（消费方据此生成工程卡片），slots 是槽位明细。 */
export function poolView(pool: Pool, state: PoolState): PoolView {
  return { root: pool.root, maxSlots: pool.config.maxSlots, projects: pool.config.projects, storage: pool.config.storage, slots: viewSlots(pool, state) };
}

const STATE_TEXT: Record<SlotView["state"], string> = {
  occupied: "占用",
  held: "保护中",
  idle: "空闲",
  switching: "切换中",
  blocked: "阻塞",
  retiring: "删除中",
  interrupted: "中断待恢复",
};

export function describeSlot(view: SlotView, now: Date): string {
  const parts = [`${view.id} ${view.branch || "(未定)"}`, STATE_TEXT[view.state]];
  if (view.holds.length) parts.push(`持有者 ${holdNames(view)}`);
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
 * 最后校正池外改动（reconcile）：外部切换、目录被删，并同步 branch/ 入口。
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
  notes.push(...await reconcile(pool));
  return notes;
}

async function recoverSlot(pool: Pool, id: string, op: SlotOp, branch: string): Promise<string> {
  const slot = findSlot(readState(pool.paths), id);
  const wc = slotDir(pool.paths, slot);
  assertStorageParent(wc);
  if (op.kind === "create" && !op.created && existsSync(wc)) {
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
    // 中断时可能留下冲突（更新/规则处理到一半）：保持阻塞，交给 refresh / gc 复查按规则再处理
    slot.phase = st.problems.length ? "blocked" : "ready";
    slot.blockedReason = st.problems.length ? `中断后遗留：${st.problems.join("；")}` : undefined;
    slot.op = undefined;
    return true;
  });
  if (!done) return `${id} 已被其他进程接手`;
  const fresh = findSlot(readState(pool.paths), id);
  if (fresh.branch) restoreLink(pool, fresh);
  complete = complete && Boolean(fresh.branch);
  return complete ? `${id} 中断前已完成 ${target}，已补建入口` : `${id} 中断时未完成${target ? ` ${target}` : ""}，当前 ${fresh.branch || "状态不明"}，下次占用时重新切换`;
}

// ---------------------------------------------------------------- 校正池外改动

function missingDir(wc: string): boolean {
  try {
    lstatSync(wc);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * 校正池外的改动，让记录和 branch/ 入口跟着真实工作副本走。只读 svn info，不切换、不删工作副本：
 * - 目录已不存在（存储目录本身可访问）：没有持有保护就移除槽位记录，有保护标为阻塞；
 * - 目录还在但不是工作副本：标为阻塞，内容留给人处理；
 * - 被人在池外切到别的分支：按实际分支记录，租约与保护跟着目录走（还有人在用）；
 *   实际分支已在别的槽位上时标为阻塞。
 * 只看没有进行中操作、所有权已确认的就绪或阻塞槽位（阻塞的只查目录是否还在）；给了 ids 时只看这些槽位。最后同步入口。
 */
export async function reconcile(pool: Pool, ids?: ReadonlySet<string>): Promise<string[]> {
  const notes: string[] = [];
  const sctx = svnCtx(pool);
  const list = readState(pool.paths).slots.filter((s) => (s.phase === "ready" || s.phase === "blocked") && !s.op && !s.ownershipUnconfirmed && (!ids || ids.has(s.id)));
  for (const seen of list) {
    const wc = slotDir(pool.paths, seen);
    const name = `${seen.id} ${seen.branch || "(未定)"}`;
    // 锁内复核：期间被别的进程改过就不动
    const same = (slot: Slot | undefined): slot is Slot => Boolean(slot) && slot!.phase === seen.phase && !slot!.op && slot!.branch === seen.branch && slot!.url === seen.url;
    try {
      assertStorageParent(wc);
    } catch (error) {
      if (seen.phase === "ready") notes.push(`${name}：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (missingDir(wc)) {
      const result = await mutate(pool.paths, (state) => {
        const slot = state.slots.find((s) => s.id === seen.id);
        if (!same(slot)) return "";
        if (isHeld(slot)) {
          if (slot.phase === "blocked") return "";
          slot.phase = "blocked";
          slot.blockedReason = `工作副本目录不存在：${wc}；仍有持有保护（${holdNames(slot)}），解除后下次运行移除记录`;
          return `${name}：目录不存在，仍受保护，已标为阻塞`;
        }
        state.slots = state.slots.filter((s) => s.id !== seen.id);
        return `${name}：目录已不存在，已移除槽位记录`;
      });
      if (result) notes.push(result);
      continue;
    }
    if (seen.phase !== "ready") continue;
    if (!existsSync(path.join(wc, ".svn"))) {
      const done = await mutate(pool.paths, (state) => {
        const slot = state.slots.find((s) => s.id === seen.id);
        if (!same(slot)) return false;
        slot.phase = "blocked";
        slot.blockedReason = `目录不是 svn 工作副本：${wc}；内容保留，请人工处理`;
        return true;
      });
      if (done) notes.push(`${name}：目录不是工作副本，已标为阻塞`);
      continue;
    }
    if (!seen.branch) continue;
    let info: Awaited<ReturnType<typeof svnInfo>>;
    try {
      info = await svnInfo(sctx, wc);
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      info = undefined;
    }
    if (!info) {
      notes.push(`${name}：读不出 svn info，暂不校正`);
      continue;
    }
    if (sameUrl(info.url, seen.url) || sameUrl(info.url, branchUrl(pool.config, seen.branch))) continue;
    const url = info.url;
    const actual = branchFromUrl(pool.config, url) ?? "";
    const oldLink = branchLink(pool.paths, seen.branch);
    try {
      if (linkExists(oldLink) && samePath(linkTarget(oldLink), wc)) removeLink(oldLink);
    } catch (error) {
      notes.push(`${seen.id}：删除旧入口 branch/${branchDirName(seen.branch)} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const result = await mutate(pool.paths, (state) => {
      const slot = state.slots.find((s) => s.id === seen.id);
      if (!same(slot)) return "";
      const other = actual ? state.slots.find((s) => s.id !== seen.id && (s.branch === actual || s.op?.target === actual)) : undefined;
      slot.url = url;
      slot.behind = undefined;
      if (other) {
        slot.branch = "";
        slot.phase = "blocked";
        slot.blockedReason = `被池外切换到 ${actual}，但 ${actual} 已在 ${other.id} 上；请把其中一个切回原分支，或解除保护后交给池回收`;
        return `${name}：被池外切换到 ${actual}，与 ${other.id} 重复，已标为阻塞`;
      }
      slot.branch = actual;
      return `${name}：被池外切换到 ${actual || url}，已按实际${actual ? `分支 ${actual} ` : "情况（不符合分支规则，记为未定）"}记录`;
    });
    if (result) notes.push(result);
  }
  notes.push(...syncLinks(pool));
  return notes;
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

/**
 * 选槽位（锁内调用）：已在该分支 → 空闲且不在工程清单（projects）里的槽位 → 没满就新建 → 空闲的工程槽位 → 池满。
 * 有效租约、持有保护的槽位都不算空闲；同类按 lastUsed 最早。工程清单里的分支在容量允许时保持挂槽。
 * 新建时由 allocate 选定实际目录。
 */
export function claimSlot(state: PoolState, config: PoolConfig, branch: string, lease: Lease | null, now: Date, allocate: (id: string) => string, excluded: ReadonlySet<string> = new Set()): Claim {
  const existing = state.slots.find((s) => s.branch === branch && (s.phase === "ready" || s.phase === "blocked") && !s.op);
  if (existing) {
    if (lease) existing.lease = laterLease(leaseActive(existing.lease, now) ? existing.lease : null, lease);
    existing.lastUsed = now.toISOString();
    return { kind: "hit", slot: { ...existing } };
  }
  const moving = state.slots.find((s) => s.op && (s.op.target === branch || s.branch === branch) && pidAlive(s.op.pid));
  if (moving) return { kind: "busy", slot: { ...moving } };

  const idle = state.slots
    .filter((s) => isIdle(s, now) && !s.op && !excluded.has(s.id))
    .sort((a, b) => (a.lastUsed ?? "").localeCompare(b.lastUsed ?? "") || a.id.localeCompare(b.id));
  const op = (kind: SlotOp["kind"], from?: string): SlotOp => ({ kind, target: branch, pid: process.pid, at: now.toISOString(), lease, from });
  const switchTo = (slot: Slot): Claim => {
    slot.phase = "switching";
    slot.op = op("switch", slot.branch);
    return { kind: "switch", slot: { ...slot } };
  };
  const spare = idle.find((s) => !isProject(s, config));
  if (spare) return switchTo(spare);
  if (state.slots.length < config.maxSlots) {
    const id = nextSlotId(state);
    const slot: Slot = { id, path: allocate(id), branch: "", url: "", phase: "switching", lease: null, op: op("create") };
    state.slots.push(slot);
    return { kind: "create", slot: { ...slot } };
  }
  // 没有余量才换出工程清单里的空闲槽位
  if (idle.length > 0) return switchTo(idle[0]);
  return { kind: "full", slots: state.slots.map((s) => ({ ...s })) };
}

export function describeFull(pool: Pool, slots: Slot[]): string {
  const now = pool.now();
  const lines = viewSlots(pool, { version: 1, slots }).map((v) => `  ${describeSlot(v, now)}`);
  return `池满（${slots.length}/${pool.config.maxSlots}），没有可用槽位：\n${lines.join("\n")}\n可以释放一个分支、等租约到期，或调大 pool.toml 的 maxSlots`;
}

/**
 * 占用或准备一个分支。lease 为 null 表示只准备不加租约。
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
    const claim = await mutate(pool.paths, (state) => claimSlot(state, pool.config, branch, lease, now,
      (id) => selectSlotPath(pool.paths, state, id, pool.config.storage), skipped));
    if (claim.kind === "full") throw new Error(describeFull(pool, claim.slots));
    if (claim.kind === "busy") throw new Error(`${branch} 正在 ${claim.slot.id} 上被另一个任务处理，稍后再试`);
    if (claim.kind === "hit") {
      const wc = slotDir(pool.paths, claim.slot);
      assertStorageParent(wc);
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
  try { assertStorageParent(wc); } catch (error) {
    await back({ phase: "blocked", blockedReason: error instanceof Error ? error.message : String(error) });
    throw error;
  }

  stage(pool, `${claimed.id}：${from || "(未定)"} → ${branch}`);
  if (from) {
    const link = branchLink(pool.paths, from);
    if (linkExists(link) && samePath(linkTarget(link), wc)) await dropLink(pool, link, wc, notes);
  }

  try {
    stage(pool, `${claimed.id}：存档本地改动`);
    const ruled = await runPoolRules(pool, wc, from, "切换前");
    if (ruled && ruled.blocked.length > 0) {
      const reason = shortReason(describeBlocked(ruled));
      await back({ phase: "blocked", blockedReason: reason });
      notes.push(`${claimed.id}（${from}）有需要人处理的问题，已标为阻塞：${reason}`);
      return "blocked";
    }
    const ruleNote = ruled ? reportRules(ruled) : "";
    if (ruleNote) notes.push(`${from} ${ruleNote}`);
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
    await svn(sctx, ["switch", "--ignore-ancestry", "--accept", "postpone", url, wc], { wc, progress: "切换" });
    // 切换撞上未纳管文件等会留下冲突：有规则按规则处理，没有规则或处理不了就标阻塞，不当成就绪交出去
    const ruled = await runPoolRules(pool, wc, branch, "切换后");
    let leftover: string | undefined;
    if (ruled) {
      if (ruled.blocked.length > 0) leftover = describeBlocked(ruled);
      const ruleNote = reportRules(ruled);
      if (ruleNote) notes.push(`${branch} ${ruleNote}`);
    } else {
      const st = await svnStatus(sctx, wc);
      if (st.problems.length > 0) leftover = `切换后有冲突：${st.problems.join("；")}`;
    }
    if (leftover) {
      const reason = shortReason(leftover);
      const info = await svnInfo(sctx, wc).catch(() => undefined);
      await back({ phase: "blocked", blockedReason: reason, branch, url: info?.url ?? url });
      notes.push(`${claimed.id} 切换到 ${branch} 后有需要人处理的问题，已标为阻塞：${reason}`);
      return "blocked";
    }
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
    checkCreationSpace(wc, minFreeFor(pool.config.storage, wc));
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
    // 只清租约，不碰持有保护：保护只能由对应 holdId 的 unhold 解除
    const held = isHeld(slot) ? `；仍有持有保护（${holdNames(slot)}），槽位不会被切换或回收` : "";
    if (!leaseActive(slot.lease, now)) {
      slot.lease = null;
      return { released: false, slot: slot.id, detail: `${branch}（${slot.id}）没有有效租约${held}` };
    }
    slot.lease = null;
    return { released: true, slot: slot.id, detail: `已释放 ${branch}（${slot.id}），工作副本留在原分支${held}` };
  });
  if (result.released) appendHistory(pool.paths, { at: now.toISOString(), action: "release", branch, slot: result.slot });
  return result;
}

// ---------------------------------------------------------------- hold / unhold

/** holdId：1–200 个可见字符，首尾不能有空白（解除时要逐字一致）。 */
export function checkHoldId(value: unknown): string {
  const id = typeof value === "string" ? value : "";
  if (!id || id !== id.trim() || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new UsageError(`holdId 不合法：${JSON.stringify(value)}（1–200 个可见字符，首尾不能有空白）`);
  }
  return id;
}

function realPath(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}

export type HoldOutcome = { slot: string; renewed: boolean; holders: number; detail: string };

/**
 * 给分支所在槽位加保护。锁内一次完成：找到槽位、确认就绪、确认实际目录就是调用方看到的 expectedPath，再写入 holds。
 * 同一 holdId 重复调用只刷新时间与说明。保护不看租约、不看进程是否还活着，只能由 unhold 解除。
 */
export async function holdSlot(pool: Pool, branch: string, holdId: string, expectedPath: string, label?: string): Promise<HoldOutcome> {
  if (!path.isAbsolute(expectedPath)) throw new UsageError(`expectedPath 必须是绝对路径：${expectedPath}`);
  // 先校正：槽位在池外被切走或目录没了时，不能按旧记录加保护
  const ids = new Set(readState(pool.paths).slots.filter((s) => s.branch === branch).map((s) => s.id));
  if (ids.size) await reconcile(pool, ids);
  const now = pool.now();
  return mutate(pool.paths, (state) => {
    const slot = state.slots.find((s) => s.branch === branch);
    if (!slot) throw new Error(`${branch} 不在池里，请先占用（acquire）再保护`);
    if (slot.op || slot.phase !== "ready") {
      throw new Error(`${branch}（${slot.id}）未就绪：${slot.op ? "正在被另一个任务处理" : slot.blockedReason ?? slot.phase}，不能保护`);
    }
    const wc = slotDir(pool.paths, slot);
    const actual = realPath(wc);
    if (!actual) throw new Error(`${branch}（${slot.id}）的实际目录不存在：${wc}`);
    if (!samePath(actual, realPath(expectedPath) ?? expectedPath)) {
      throw new Error(`${branch} 现在位于 ${slot.id}（${actual}），与调用方确认的 ${expectedPath} 不一致，未加保护；请刷新后重新确认`);
    }
    const holds = slot.holds ?? {};
    const renewed = Object.prototype.hasOwnProperty.call(holds, holdId);
    holds[holdId] = { at: now.toISOString(), path: actual, ...(label ? { label } : {}) };
    slot.holds = holds;
    slot.lastUsed = now.toISOString();
    const holders = Object.keys(holds).length;
    return {
      slot: slot.id,
      renewed,
      holders,
      detail: `${renewed ? "已刷新" : "已建立"} ${branch}（${slot.id}）的保护 ${holdId}；当前 ${holders} 个持有者，切换、缩容、refresh 更新都会跳过这个槽位`,
    };
  });
}

export type UnholdOutcome = { slot?: string; removed: boolean; leaseReleased: boolean; holders: number; detail: string };

/**
 * 解除 holdId 的保护，其他持有者不受影响。必须由调用方确认相关应用已关闭。
 * releaseLease 时顺带清除租约（等同 release）；其他持有者还在时槽位仍受保护。
 * 分支不在池里或该 holdId 不存在时什么都不改，视为已解除（可重复调用）。
 * 先找该分支上带这个 holdId 的槽位，再找任意带它的槽位（分支被池外切走后仍能解除），最后按分支找。
 */
export async function unholdSlot(pool: Pool, branch: string, holdId: string, confirmClosed: boolean, releaseLease: boolean): Promise<UnholdOutcome> {
  if (!confirmClosed) throw new UsageError("解除保护前须确认用到该工作副本的应用已关闭（--confirm-closed）");
  const now = pool.now();
  const result = await mutate(pool.paths, (state): UnholdOutcome => {
    const has = (s: Slot): boolean => Boolean(s.holds) && Object.prototype.hasOwnProperty.call(s.holds, holdId);
    const slot = state.slots.find((s) => s.branch === branch && has(s)) ?? state.slots.find(has) ?? state.slots.find((s) => s.branch === branch);
    if (!slot) return { removed: false, leaseReleased: false, holders: 0, detail: `${branch} 不在池里，无需解除` };
    const label = slot.branch === branch ? branch : `${branch}（现为 ${slot.branch || "未定"}）`;
    const holds = slot.holds ?? {};
    const removed = Object.prototype.hasOwnProperty.call(holds, holdId);
    if (removed) delete holds[holdId];
    slot.holds = Object.keys(holds).length ? holds : undefined;
    const leaseReleased = releaseLease && leaseActive(slot.lease, now);
    if (releaseLease) slot.lease = null;
    const holders = Object.keys(holds).length;
    const parts = [removed ? `已解除 ${label}（${slot.id}）的保护 ${holdId}` : `${label}（${slot.id}）上没有 ${holdId} 的保护`];
    if (releaseLease) parts.push(leaseReleased ? "已释放租约" : "没有有效租约");
    parts.push(holders ? `仍有 ${holders} 个持有者（${holdNames(slot)}），继续受保护` : "槽位已不受保护");
    return { slot: slot.id, removed, leaseReleased, holders, detail: parts.join("；") };
  });
  if (result.leaseReleased) appendHistory(pool.paths, { at: now.toISOString(), action: "release", branch, slot: result.slot });
  return result;
}

// ---------------------------------------------------------------- gc

export type GcReport = { recovered: string[]; unblocked: string[]; blocked: string[]; retired: string[]; pendingShrink: string[]; links: string[]; patches: number; errors: string[] };

export async function gc(pool: Pool): Promise<GcReport> {
  const report: GcReport = { recovered: await recover(pool), unblocked: [], blocked: [], retired: [], pendingShrink: [], links: [], patches: 0, errors: [] };
  const sctx = svnCtx(pool);

  // 复查阻塞槽位：配置了规则时先按规则处理（受保护、被租用、有 svn 进程、所有权未确认的不碰）
  for (const slot of readState(pool.paths).slots.filter((s) => s.phase === "blocked" && !s.op)) {
    const wc = slotDir(pool.paths, slot);
    try {
      if (slot.ownershipUnconfirmed) {
        report.blocked.push(`${slot.id} ${slot.branch}：${slot.blockedReason ?? "目录所有权需要人工确认"}`);
        continue;
      }
      assertStorageParent(wc);
      const info = await svnInfo(sctx, wc);
      if (!info) {
        report.blocked.push(`${slot.id} ${slot.branch}：工作副本不可访问，保留阻塞与记录`);
        continue;
      }
      let ruleNote = "";
      if (poolRules(pool)) {
        const reviewed = await reviewByRules(pool, slot, wc, info.url);
        if (reviewed.blocked) {
          report.blocked.push(`${slot.id} ${slot.branch}：${reviewed.blocked}`);
          continue;
        }
        ruleNote = reviewed.note ?? "";
      }
      const st = await svnStatus(sctx, wc);
      if (st.problems.length > 0 || st.wcLocked) {
        report.blocked.push(`${slot.id} ${slot.branch}：${st.problems.join("；") || "工作副本被锁"}`);
        continue;
      }
      // 实际分支已在别的槽位上（多半是池外切换造成）：保持阻塞，等人切回或交给池回收，不当成空闲槽位换出
      const outcome = await mutate(pool.paths, (state) => {
        const s = state.slots.find((x) => x.id === slot.id);
        if (!s || s.phase !== "blocked" || s.op) return undefined;
        const actual = st.incomplete ? "" : branchFromUrl(pool.config, info.url) ?? "";
        const other = actual ? state.slots.find((x) => x.id !== s.id && (x.branch === actual || x.op?.target === actual)) : undefined;
        s.url = info.url;
        if (other) {
          s.branch = "";
          s.blockedReason = `工作副本在 ${actual} 上，但 ${actual} 已在 ${other.id} 上；请把其中一个切回原分支，或解除保护后交给池回收`;
          return { blocked: s.blockedReason };
        }
        s.phase = "ready";
        s.blockedReason = undefined;
        s.branch = actual;
        return { branch: actual };
      });
      if (!outcome) continue;
      if ("blocked" in outcome) report.blocked.push(`${slot.id} (未定)：${outcome.blocked}`);
      else report.unblocked.push(`${slot.id} ${outcome.branch || "(未定)"}${ruleNote ? `：${ruleNote}` : ""}`);
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
        .filter((s) => isIdle(s, now) && !s.op && !tried.has(s.id))
        .sort((a, b) => Number(isProject(a, pool.config)) - Number(isProject(b, pool.config)) || (a.lastUsed ?? "").localeCompare(b.lastUsed ?? "") || b.id.localeCompare(a.id));
      if (idle.length === 0) return { none: state.slots.length - pool.config.maxSlots };
      const slot = idle[0];
      slot.phase = "retiring";
      slot.op = { kind: "delete", pid: process.pid, at: now.toISOString(), from: slot.branch };
      return { slot: { ...slot } };
    });
    if (!pick) break;
    if ("none" in pick) {
      report.pendingShrink.push(`还需缩减 ${pick.none} 个槽位，等租约结束、保护解除或阻塞处理后再回收`);
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

/**
 * gc 复查：占住槽位（op=update）按规则处理一次，再交还。
 * blocked 是仍要阻塞的原因；没有 blocked 表示规则处理完了，交给后面的常规复查判断能否解除阻塞，note 是处理摘要和提示。
 */
async function reviewByRules(pool: Pool, slot: Slot, wc: string, url: string): Promise<{ blocked?: string; note?: string }> {
  const now = pool.now();
  const claim = await mutate(pool.paths, (state) => {
    const s = state.slots.find((x) => x.id === slot.id);
    if (!s || s.phase !== "blocked" || s.op) return "已被其他任务处理";
    if (isHeld(s)) return `受保护（${holdNames(s)}），不按规则处理`;
    if (leaseActive(s.lease, now)) return `被占用${describeLease(s.lease, now)}，不按规则处理`;
    if (s.ownershipUnconfirmed) return "目录所有权未确认";
    s.op = { kind: "update", target: s.branch, pid: process.pid, at: now.toISOString() };
    return undefined;
  });
  if (claim) return { blocked: `${claim}：${slot.blockedReason ?? ""}` };
  const release = async (patch: Partial<Slot>): Promise<void> => {
    await mutate(pool.paths, (state) => {
      const s = state.slots.find((x) => x.id === slot.id);
      if (s && ourOp(s)) Object.assign(s, { op: undefined }, patch);
    });
  };
  try {
    if (await svnBusy(wc, pool.ctx.abortSignal)) {
      await release({});
      return { blocked: `有 SVN 进程正在处理，下次再复查：${slot.blockedReason ?? ""}` };
    }
    const branch = slot.branch || branchFromUrl(pool.config, url) || "";
    const ruled = await runPoolRules(pool, wc, branch, "复查");
    if (ruled && ruled.blocked.length > 0) {
      const reason = shortReason(describeBlocked(ruled));
      await release({ blockedReason: reason });
      return { blocked: reason };
    }
    await release({});
    const note = ruled ? reportRules(ruled) : "";
    if (note) appendLog(pool.ctx.logFile, `[workingCopyPool] ${slot.id} ${note}`);
    return note ? { note } : {};
  } catch (error) {
    await release({});
    throw error;
  }
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
  try { assertStorageParent(wc); } catch (error) {
    await back({ phase: "blocked", blockedReason: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  if (claimed.branch) {
    const link = branchLink(pool.paths, claimed.branch);
    if (linkExists(link) && samePath(linkTarget(link), wc)) await dropLink(pool, link, wc, notes);
  }
  if (existsSync(path.join(wc, ".svn"))) {
    const fail = async (error: unknown): Promise<never> => {
      if (error instanceof Cancelled) throw error;
      await back({});
      throw error;
    };
    const ruled = await runPoolRules(pool, wc, claimed.branch, "回收前").catch(fail);
    if (ruled && ruled.blocked.length > 0) {
      const reason = shortReason(describeBlocked(ruled));
      await back({ phase: "blocked", blockedReason: reason });
      return `${claimed.id} 有需要人处理的问题，暂不删除：${reason}`;
    }
    const ruleNote = ruled ? reportRules(ruled) : "";
    if (ruleNote) notes.push(ruleNote);
    const archived = await archiveChanges(svnCtx(pool), pool.paths, wc, claimed.branch, pool.now()).catch(fail);
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

/**
 * 让 branch/ 入口与槽位一致：只有分支挂在槽位上（就绪或阻塞）且目录还在时入口才存在；
 * 补建缺失的入口，删除指向不存在槽位、目录已不在或与状态不符的链接。只删链接，不碰真实目录。
 */
export function syncLinks(pool: Pool): string[] {
  const state = readState(pool.paths);
  const notes: string[] = [];
  const wanted = new Map<string, string>();
  for (const slot of state.slots) {
    if (!slot.branch || slot.op || (slot.phase !== "ready" && slot.phase !== "blocked")) continue;
    const dir = slotDir(pool.paths, slot);
    if (!existsSync(dir)) continue;
    wanted.set(branchDirName(slot.branch), dir);
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

/** 更新工程清单里已挂在槽位上的分支；没挂槽的跳过（按需占用时再分配），不为它们抢槽位。 */
export async function refresh(pool: Pool): Promise<{ recovered: string[]; items: RefreshItem[] }> {
  const recovered = await recover(pool);
  const items: RefreshItem[] = [];
  for (const branch of pool.config.projects) {
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
    if (isHeld(slot)) return { kind: "skip" as const, why: `${slot.id} 受保护（${holdNames(slot)}），不更新` };
    if (slot.ownershipUnconfirmed) return { kind: "skip" as const, why: `${slot.id} 目录所有权未确认，需人工检查` };
    const rulesOn = Boolean(pool.config.svnRules);
    const retryBlocked = slot.phase === "blocked" && rulesOn;
    if (slot.phase === "blocked" && !retryBlocked) return { kind: "skip" as const, why: `${slot.id} 阻塞：${slot.blockedReason ?? ""}` };
    if (slot.phase !== "ready" && !retryBlocked) return { kind: "skip" as const, why: `${slot.id} ${slot.phase}` };
    if (leaseActive(slot.lease, now)) return { kind: "skip" as const, why: `${slot.id} 被占用${describeLease(slot.lease, now)}，不抢` };
    slot.op = { kind: "update", target: branch, pid: process.pid, at: now.toISOString() };
    return { kind: "update" as const, slot: { ...slot } };
  });

  if (claim.kind === "skip") return { branch, ok: true, skipped: true, detail: `跳过：${claim.why}` };
  if (claim.kind === "absent") return { branch, ok: true, skipped: true, detail: "跳过：未挂槽（按需占用时分配）" };

  const wc = slotDir(pool.paths, claim.slot);
  const sctx = svnCtx(pool);
  stage(pool, `更新 ${branch}（${claim.slot.id}）`);
  try {
    assertStorageParent(wc);
    const loaded = poolRules(pool);
    if (loaded) {
      if (await svnBusy(wc, pool.ctx.abortSignal)) throw new Error("有 SVN 进程正在处理槽位，未按规则处理");
      const released = await releaseSlotOccupants(pool, wc);
      if (released) appendLog(pool.ctx.logFile, `[workingCopyPool] ${claim.slot.id} ${released}`);
    }
    const result = await svnCheckAndUpdate({
      workingCopy: wc,
      timeoutMs: pool.ctx.timeoutMs,
      logFile: pool.ctx.logFile,
      abortSignal: pool.ctx.abortSignal,
      skipUpdate: false,
      onConflict: loaded ? "rules" : "fail",
      ...(loaded ? { rules: { rules: loaded.rules, enable: loaded.enable, archiveRoot: archiveRootFor(pool.paths, branch), now: pool.now() } } : {}),
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
    const ruleNote = result.detail.split("；").filter((part) => part.includes("规则处理") || part.startsWith(RULE_HINT)).join("；");
    return {
      branch,
      ok: true,
      detail: `已更新（${claim.slot.id}，落后 ${behind ?? "未知"}）${sparse.length ? `；稀疏：${sparse.join("；")}` : ""}${ruleNote && !last.includes(ruleNote) ? `；${ruleNote}` : ""}；${last}`,
    };
  } catch (error) {
    if (error instanceof Cancelled || pool.ctx.abortSignal.aborted) throw error;
    const blockedReason = error instanceof RulesBlockedError ? shortReason(error.message) : undefined;
    await mutate(pool.paths, (state) => {
      const slot = state.slots.find((s) => s.id === claim.slot.id);
      if (!slot || !ourOp(slot)) return;
      slot.op = undefined;
      if (blockedReason) {
        slot.phase = "blocked";
        slot.blockedReason = blockedReason;
      }
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
