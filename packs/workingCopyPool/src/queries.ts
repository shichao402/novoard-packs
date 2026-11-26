/**
 * 查询工具（kind: query，ADR-0020）：candidates、occupied、status。
 * 只读：不建池目录、不推进中断恢复、不拿池锁；15 秒内返回。唯一的写是 .pool/cache 里的远端列表缓存。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Choice, ToolRunContext } from "../../../shared/types";
import { branchFromPath, loadConfig, type PoolConfig } from "./config";
import { describeLease, describeSlot, fmtTime, poolView, type Pool, type SlotView } from "./pool";
import { isIdle, leaseActive, poolPaths, readState, recentBranches, type PoolState } from "./state";
import { Cancelled, svn, svnStatus, type SvnCtx } from "./svn";

/** 远端列表缓存有效期（PRD：10 分钟内直接用缓存）。 */
export const LIST_CACHE_MS = 10 * 60_000;
/** 单次 svn ls 的上限，留出余量让整个查询在 15 秒内返回。 */
export const LIST_TIMEOUT_MS = 10_000;
/** status 统计改动的总预算。 */
export const STATUS_BUDGET_MS = 12_000;

/** 只读打开池：不创建目录。 */
export function peekPool(ctx: ToolRunContext, now: () => Date = () => new Date()): Pool {
  const root = path.resolve(ctx.cwd);
  return { root, paths: poolPaths(root), config: loadConfig(root), ctx, now };
}

function readOnlyCtx(pool: Pool, timeoutMs: number): SvnCtx {
  return { cwd: pool.root, timeoutMs, logFile: pool.ctx.logFile, abortSignal: pool.ctx.abortSignal };
}

// ---------------------------------------------------------------- listFrom

export type RemoteBranch = { branch: string; date: string };
type ListCache = { at: string; key: string; entries: RemoteBranch[] };

/** `svn ls --xml` 的目录条目：名字与最后提交时间。 */
export function parseListXml(xml: string): { name: string; date: string }[] {
  const out: { name: string; date: string }[] = [];
  for (const m of xml.matchAll(/<entry\b[^>]*kind="dir"[^>]*>([\s\S]*?)<\/entry>/g)) {
    const name = /<name>([\s\S]*?)<\/name>/.exec(m[1])?.[1];
    const date = /<date>([\s\S]*?)<\/date>/.exec(m[1])?.[1];
    if (name) out.push({ name: unescape(name), date: date ?? "" });
  }
  return out;
}

function unescape(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function cacheFile(pool: Pool): string {
  return path.join(pool.paths.cache, "list-from.json");
}

/**
 * 缓存 key 的版本。v1 的缓存可能是 svn ls 输出被截断后写下的（分支多时只剩后一半），升版本让它们失效。
 */
const LIST_CACHE_VERSION = 2;

export function listCacheKey(config: PoolConfig): string {
  return JSON.stringify([LIST_CACHE_VERSION, config.svnRoot, config.branches.listFrom, config.branches.pattern, config.aliases]);
}

function readCache(pool: Pool): ListCache | undefined {
  try {
    const value = JSON.parse(readFileSync(cacheFile(pool), "utf8")) as ListCache;
    if (value.key !== listCacheKey(pool.config) || !Array.isArray(value.entries)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function writeCache(pool: Pool, entries: RemoteBranch[]): void {
  try {
    mkdirSync(pool.paths.cache, { recursive: true });
    const value: ListCache = { at: pool.now().toISOString(), key: listCacheKey(pool.config), entries };
    writeFileSync(cacheFile(pool), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch {
    // 缓存写不了只影响下次速度
  }
}

/**
 * listFrom 下的分支（未按 recentDays 过滤），新提交在前。
 * 10 分钟内用缓存；远端失败时退回过期缓存，再没有就返回 error。
 */
export async function listRemoteBranches(pool: Pool): Promise<{ entries: RemoteBranch[]; error?: string; cached: boolean }> {
  const dirs = pool.config.branches.listFrom;
  if (dirs.length === 0 || !existsSync(path.join(pool.root, "pool.toml"))) return { entries: [], cached: false };
  const cache = readCache(pool);
  if (cache && pool.now().getTime() - Date.parse(cache.at) < LIST_CACHE_MS) return { entries: cache.entries, cached: true };

  const ctx = readOnlyCtx(pool, LIST_TIMEOUT_MS);
  const entries: RemoteBranch[] = [];
  // listFrom 列出的是分支根；pattern 带后缀（如 branches/{name}/GameCore）时补上后缀再反推分支名
  const suffix = pool.config.branches.pattern.split("{name}")[1] ?? "";
  try {
    for (const dir of dirs) {
      const result = await svn(ctx, ["ls", "--xml", `${pool.config.svnRoot}/${dir}`]);
      for (const item of parseListXml(result.stdout)) {
        const branch = branchFromPath(pool.config, `${dir}/${item.name}${suffix}`);
        if (branch) entries.push({ branch, date: item.date });
      }
    }
  } catch (error) {
    if (error instanceof Cancelled) throw error;
    const message = error instanceof Error ? error.message.split(/\r?\n/)[0] : String(error);
    if (cache) return { entries: cache.entries, cached: true, error: `远端列不出（${message}），用 ${fmtTime(cache.at)} 的缓存` };
    return { entries: [], cached: false, error: `远端列不出：${message}` };
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));
  writeCache(pool, entries);
  return { entries, cached: false };
}

// ---------------------------------------------------------------- candidates

function slotHint(view: SlotView, now: Date): string {
  const parts: string[] = [];
  switch (view.state) {
    case "occupied":
      parts.push(`已占用${describeLease(view.lease, now)}`);
      break;
    case "resident":
      parts.push("常驻，就绪");
      break;
    case "held":
      parts.push(`受保护（${view.holds.map((h) => h.label ?? h.id).join("、")}）`);
      if (view.lease) parts.push(`已占用${describeLease(view.lease, now)}`);
      break;
    case "idle":
      parts.push("就绪");
      break;
    case "blocked":
      parts.push(`阻塞：${view.blockedReason ?? ""}`);
      break;
    case "switching":
      parts.push("切换中");
      break;
    case "retiring":
      parts.push("删除中");
      break;
    case "interrupted":
      parts.push("中断待恢复");
      break;
  }
  if (view.behind !== null && view.behind > 0) parts.push(`落后 ${view.behind}`);
  return parts.join("，");
}

/** 不在池里的分支要切换还是新建：有空闲槽位就切换，没满就新建，否则池满。 */
export function missHint(state: PoolState, config: PoolConfig, now: Date): string {
  if (state.slots.some((s) => isIdle(s, config, now) && !s.op)) return "需切换";
  if (state.slots.length < config.maxSlots) return "需新建槽位";
  return "池满，需先释放";
}

/**
 * 候选项合并（纯函数，单测用）：池中已有 → 常驻 → 最近使用 → listFrom 最近有提交的，按 value 去重。
 */
export function mergeCandidates(input: {
  views: SlotView[];
  state: PoolState;
  config: PoolConfig;
  recent: string[];
  remote: RemoteBranch[];
  remoteError?: string;
  now: Date;
}): Choice[] {
  const { views, state, config, recent, remote, remoteError, now } = input;
  const out: Choice[] = [];
  const seen = new Set<string>();
  const push = (choice: Choice): void => {
    if (!choice.value || seen.has(choice.value)) return;
    seen.add(choice.value);
    out.push(choice);
  };
  const miss = missHint(state, config, now);
  const known = new Set(remote.map((r) => r.branch));
  const unchecked = remoteError ? "（远端不可达，未核对）" : "";

  for (const view of views) if (view.branch) push({ value: view.branch, hint: slotHint(view, now) });
  for (const branch of config.resident) push({ value: branch, hint: `常驻，${miss}` });
  for (const branch of recent) {
    const gone = !remoteError && remote.length > 0 && config.branches.listFrom.length > 0 && !known.has(branch) && !config.aliases[branch];
    push({ value: branch, hint: `最近使用，${miss}${gone ? "（listFrom 下没找到，可能已删除）" : unchecked}` });
  }
  const cutoff = now.getTime() - config.branches.recentDays * 86_400_000;
  for (const item of remote) {
    const at = Date.parse(item.date);
    if (Number.isFinite(at) && at < cutoff) continue;
    push({ value: item.branch, hint: `${item.date ? `最近提交 ${fmtTime(item.date)}，` : ""}${miss}` });
  }
  return out;
}

export async function candidates(pool: Pool): Promise<{ choices: Choice[]; detail: string }> {
  const now = pool.now();
  const state = readState(pool.paths);
  const views = poolView(pool, state).slots;
  const remote = await listRemoteBranches(pool);
  const choices = mergeCandidates({
    views,
    state,
    config: pool.config,
    recent: recentBranches(pool.paths, 20),
    remote: remote.entries,
    remoteError: remote.error,
    now,
  });
  const lines = [`${choices.length} 个候选分支${remote.cached ? "（远端列表来自缓存）" : ""}`];
  if (remote.error) lines.push(remote.error);
  return { choices, detail: lines.join("\n") };
}

// ---------------------------------------------------------------- occupied

export function occupiedChoices(state: PoolState, now: Date): Choice[] {
  return state.slots
    .filter((s) => s.branch && leaseActive(s.lease, now))
    .map((s) => ({ value: s.branch, hint: `${s.id}，${describeLease(s.lease, now)}` }));
}

export function occupied(pool: Pool): { choices: Choice[]; detail: string } {
  const choices = occupiedChoices(readState(pool.paths), pool.now());
  return { choices, detail: choices.length ? `${choices.length} 个分支被占用` : "没有被占用的分支" };
}

// ---------------------------------------------------------------- status

export type SlotChanges = { versioned: number; unversioned: number; problems: string[] } | null;

export async function status(pool: Pool): Promise<{ detail: string; summary: string; pool: unknown }> {
  const now = pool.now();
  const state = readState(pool.paths);
  const view = poolView(pool, state);
  const deadline = Date.now() + STATUS_BUDGET_MS;
  const changes = new Map<string, SlotChanges>();
  let skipped = 0;
  for (const slot of view.slots) {
    const left = deadline - Date.now();
    // 切换中、删除中的槽位正被别人改，不读；预算用完的标 null
    if (left < 500 || slot.state === "switching" || slot.state === "retiring" || !existsSync(path.join(slot.path, ".svn"))) {
      if (left < 500) skipped += 1;
      changes.set(slot.id, null);
      continue;
    }
    try {
      const st = await svnStatus(readOnlyCtx(pool, left), slot.path, left);
      changes.set(slot.id, { versioned: st.versioned.length, unversioned: st.unversioned.length, problems: st.problems });
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      changes.set(slot.id, null);
    }
  }

  const lines = view.slots.map((v) => {
    const c = changes.get(v.id);
    const text = c ? (c.versioned || c.unversioned ? `，改动 ${c.versioned} / 未纳管 ${c.unversioned}` : "，无改动") : "";
    return `${describeSlot(v, now)}${text}\n  实际目录：${v.path}`;
  });
  const count = (s: SlotView["state"]): number => view.slots.filter((v) => v.state === s).length;
  const summary = `${view.slots.length}/${view.maxSlots} 个槽位：占用 ${count("occupied")}，常驻 ${count("resident")}，空闲 ${count("idle")}${count("held") ? `，保护 ${count("held")}` : ""}${count("blocked") ? `，阻塞 ${count("blocked")}` : ""}${count("interrupted") ? `，中断 ${count("interrupted")}` : ""}`;
  const missingResident = view.resident.filter((b) => !view.slots.some((v) => v.branch === b));
  if (missingResident.length) lines.push(`常驻分支不在池里：${missingResident.join("、")}（下次 refresh 准备）`);
  if (skipped) lines.push(`${skipped} 个槽位超出统计时间，未读改动`);
  return {
    summary,
    detail: [summary, ...lines].join("\n"),
    pool: { ...view, slots: view.slots.map((v) => ({ ...v, changes: changes.get(v.id) ?? null })) },
  };
}
