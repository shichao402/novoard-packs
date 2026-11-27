/**
 * 池的目录、状态文件、锁与历史（PRD working-copy-pool「目录与状态」「并发」）。
 * 所有读写 state.json 的操作都在 `.pool/lock` 内完成，锁内只做读改写；
 * 耗时操作放在锁外，用槽位 phase 与 op 占位。
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import type { PoolConfig } from "./config";

export type Lease = { until: string; tag?: string };

export type SlotPhase = "ready" | "switching" | "blocked" | "retiring";

/** 进行中的耗时操作；pid 已不存在时由中断恢复接手。 */
export type SlotOp = {
  kind: "create" | "switch" | "update" | "delete";
  /** create/switch 的目标分支。 */
  target?: string;
  pid: number;
  at: string;
  /** 完成后要写入的租约（acquire）；只准备不占用时没有。 */
  lease?: Lease | null;
  /** 切换前所在分支；释放占用失败时据此恢复。 */
  from?: string;
  /** 新建流程 exclusive mkdir 成功后记录；未确认所有权的目录不可在恢复时删除。 */
  created?: boolean;
};

export type Slot = {
  id: string;
  /** 新建时选定的实际绝对路径（在 [storage].roots 之一下面），不随配置迁移。 */
  path: string;
  /** 当前所在分支；空串表示刚建或中断后状态不明，需要重新切换。 */
  branch: string;
  url: string;
  phase: SlotPhase;
  lease?: Lease | null;
  lastUsed?: string;
  blockedReason?: string;
  /** 无法确认新建目录归属时禁止自动解锁，须人工确认。 */
  ownershipUnconfirmed?: boolean;
  /** 最近一次读到的落后 revision 数。 */
  behind?: number;
  op?: SlotOp;
  /**
   * 持有保护（hold / unhold）：键为调用方给的 holdId。有任一持有时槽位不算空闲，
   * 不会被切换、缩容或 refresh 更新；不随租约到期或进程退出消失，只能由对应 holdId 的 unhold 清除。
   */
  holds?: Record<string, Hold>;
};

/** 一条持有记录：何时建立、给人看的说明、建立时校验过的物理目录。 */
export type Hold = { at: string; label?: string; path: string };

export type PoolState = { version: 1; slots: Slot[] };

/** 池定义目录的布局：配置、状态、入口与存档；槽位本身不在这里。 */
export type PoolPaths = {
  root: string;
  branch: string;
  patches: string;
  meta: string;
  state: string;
  lock: string;
  cache: string;
  history: string;
};

export function poolPaths(root: string): PoolPaths {
  const meta = path.join(root, ".pool");
  return {
    root,
    branch: path.join(root, "branch"),
    patches: path.join(root, "patches"),
    meta,
    state: path.join(meta, "state.json"),
    lock: path.join(meta, "lock"),
    cache: path.join(meta, "cache"),
    history: path.join(meta, "history.jsonl"),
  };
}

export function slotDir(paths: PoolPaths, value: string | Pick<Slot, "id" | "path">): string {
  const slot = typeof value === "string" ? readState(paths).slots.find((s) => s.id === value) : value;
  if (!slot) throw new Error(`槽位 ${value as string} 不在状态文件里`);
  if (!/^s\d{2,3}$/.test(slot.id)) throw new Error(`槽位编号不合法：${slot.id}`);
  if (slot.path === undefined || slot.path === null) {
    throw new Error(`槽位 ${slot.id} 没有记录 path：池定义目录里的 slots/ 布局已不再支持，请在 ${paths.state} 里写入它的实际绝对目录，并把所在目录加进 [storage].roots`);
  }
  if (typeof slot.path !== "string" || !path.isAbsolute(slot.path) || path.basename(path.normalize(slot.path)) !== slot.id
    || (process.platform === "win32" && !/^[a-z]:[\\/]/i.test(slot.path)) || /[\u0000-\u001f]/.test(slot.path)) {
    throw new Error(`槽位 ${slot.id} 的 path 必须是以槽位编号结尾的本机绝对目录`);
  }
  return path.normalize(slot.path);
}

/** 分支名转目录名：`/`、`\`、`:` 等 Windows 不允许或有歧义的字符换成 `_`。 */
export function branchDirName(branch: string): string {
  return branch.replace(/[\\/:*?"<>|\s]/g, "_");
}

export function branchLink(paths: PoolPaths, branch: string): string {
  return path.join(paths.branch, branchDirName(branch));
}

/** 第一次执行任何池工具时建出目录与状态文件（US1）。 */
export function ensureLayout(paths: PoolPaths): void {
  for (const dir of [paths.branch, paths.patches, paths.meta, paths.cache]) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(paths.state)) {
    writeJsonAtomic(paths.state, { version: 1, slots: [] } satisfies PoolState);
  }
}

export function readState(paths: PoolPaths): PoolState {
  if (!existsSync(paths.state)) return { version: 1, slots: [] };
  const value = JSON.parse(readFileSync(paths.state, "utf8")) as PoolState;
  if (!value || !Array.isArray(value.slots)) throw new Error(`${paths.state} 格式不对`);
  const ids = new Set<string>();
  const locations = new Set<string>();
  for (const slot of value.slots) {
    const wc = slotDir(paths, slot);
    const location = process.platform === "win32" ? wc.toLowerCase() : wc;
    if (ids.has(slot.id) || locations.has(location)) throw new Error(`${paths.state} 存在重复槽位或目录：${slot.id}`);
    ids.add(slot.id);
    locations.add(location);
  }
  return value;
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

export function pidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 锁只在短暂的读改写期间持有；超过这个时长一定是残留。 */
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_WAIT_MS = 15_000;

type LockInfo = { pid: number; at: string };

/** 锁文件是否残留：持有进程不存在、内容读不出且已有一会儿、或持有过久。 */
export function isStaleLock(file: string, now = Date.now()): boolean {
  let info: LockInfo | undefined;
  try {
    info = JSON.parse(readFileSync(file, "utf8")) as LockInfo;
  } catch {
    try {
      return now - statSync(file).mtimeMs > 10_000;
    } catch {
      return true;
    }
  }
  if (!pidAlive(info?.pid)) return true;
  const at = Date.parse(info?.at ?? "");
  return Number.isFinite(at) && now - at > LOCK_STALE_MS;
}

function tryLock(file: string): boolean {
  try {
    const fd = openSync(file, "wx");
    writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() } satisfies LockInfo));
    closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export async function acquireLock(file: string, waitMs = LOCK_WAIT_MS): Promise<() => void> {
  const deadline = Date.now() + waitMs;
  while (true) {
    if (tryLock(file)) {
      return () => {
        try {
          unlinkSync(file);
        } catch {
          // 已被接管或删除
        }
      };
    }
    if (isStaleLock(file)) {
      try {
        unlinkSync(file);
      } catch {
        // 别的进程先接管了，再抢一次
      }
      continue;
    }
    if (Date.now() >= deadline) {
      let holder = "";
      try {
        holder = readFileSync(file, "utf8");
      } catch {
        // ignore
      }
      throw new Error(`池状态锁被占用超过 ${Math.round(waitMs / 1000)} 秒：${holder || file}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** 在锁内读改写 state.json。fn 必须是同步的，不做耗时操作。 */
export async function mutate<T>(paths: PoolPaths, fn: (state: PoolState) => T): Promise<T> {
  const release = await acquireLock(paths.lock);
  try {
    const state = readState(paths);
    const result = fn(state);
    writeJsonAtomic(paths.state, state);
    return result;
  } finally {
    release();
  }
}

export function leaseActive(lease: Lease | null | undefined, now: Date): boolean {
  if (!lease) return false;
  if (lease.until === "forever") return true;
  const until = Date.parse(lease.until);
  return Number.isFinite(until) && until > now.getTime();
}

/** 槽位上有没有持有保护。 */
export function isHeld(slot: Slot): boolean {
  return Boolean(slot.holds) && Object.keys(slot.holds!).length > 0;
}

/** 空闲是推导出来的：ready、没有有效租约、没有持有保护（租约过期不依赖 gc）。 */
export function isIdle(slot: Slot, now: Date): boolean {
  return slot.phase === "ready" && !leaseActive(slot.lease, now) && !isHeld(slot);
}

/** 槽位当前分支在不在工程清单里；换出空闲槽位时先换不在清单里的。 */
export function isProject(slot: Slot, config: PoolConfig): boolean {
  return Boolean(slot.branch) && config.projects.includes(slot.branch);
}

/** 进行中的操作是否已中断：有 op 且记录的进程已不存在。 */
export function isInterrupted(slot: Slot): boolean {
  return Boolean(slot.op) && !pidAlive(slot.op!.pid);
}

/** 较晚的租约；forever 最大。 */
export function laterLease(a: Lease | null | undefined, b: Lease): Lease {
  if (!a) return b;
  if (a.until === "forever" || b.until === "forever") return { until: "forever", tag: b.tag ?? a.tag };
  return Date.parse(a.until) >= Date.parse(b.until) ? { until: a.until, tag: b.tag ?? a.tag } : { until: b.until, tag: b.tag ?? a.tag };
}

export function nextSlotId(state: PoolState): string {
  const used = new Set(state.slots.map((s) => s.id));
  for (let i = 1; i < 1000; i++) {
    const id = `s${String(i).padStart(2, "0")}`;
    if (!used.has(id)) return id;
  }
  throw new Error("槽位号用完");
}

export type HistoryEntry = { at: string; action: "acquire" | "release" | "prepare"; branch: string; slot?: string };

export function appendHistory(paths: PoolPaths, entry: HistoryEntry): void {
  try {
    appendFileSync(paths.history, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // 历史只用于候选项排序，写不了不影响操作
  }
}

/** 最近占用过的分支，新的在前，去重。 */
export function recentBranches(paths: PoolPaths, limit = 20): string[] {
  if (!existsSync(paths.history)) return [];
  const lines = readFileSync(paths.history, "utf8").split(/\r?\n/).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const entry = JSON.parse(lines[i]) as HistoryEntry;
      if (entry.action !== "acquire" || !entry.branch || seen.has(entry.branch)) continue;
      seen.add(entry.branch);
      out.push(entry.branch);
    } catch {
      // 坏行跳过
    }
  }
  return out;
}
