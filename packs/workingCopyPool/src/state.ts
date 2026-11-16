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
  /** 完成后要写入的租约（acquire）；refresh 准备常驻分支时没有。 */
  lease?: Lease | null;
  /** 切换前所在分支；释放占用失败时据此恢复。 */
  from?: string;
};

export type Slot = {
  id: string;
  /** 当前所在分支；空串表示刚建或中断后状态不明，需要重新切换。 */
  branch: string;
  url: string;
  phase: SlotPhase;
  lease?: Lease | null;
  lastUsed?: string;
  blockedReason?: string;
  /** 最近一次读到的落后 revision 数。 */
  behind?: number;
  op?: SlotOp;
};

export type PoolState = { version: 1; slots: Slot[] };

export type PoolPaths = {
  root: string;
  slots: string;
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
    slots: path.join(root, "slots"),
    branch: path.join(root, "branch"),
    patches: path.join(root, "patches"),
    meta,
    state: path.join(meta, "state.json"),
    lock: path.join(meta, "lock"),
    cache: path.join(meta, "cache"),
    history: path.join(meta, "history.jsonl"),
  };
}

export function slotDir(paths: PoolPaths, id: string): string {
  return path.join(paths.slots, id);
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
  for (const dir of [paths.slots, paths.branch, paths.patches, paths.meta, paths.cache]) {
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

export function isResident(slot: Slot, config: PoolConfig): boolean {
  return Boolean(slot.branch) && config.resident.includes(slot.branch);
}

/** 空闲是推导出来的：ready、不是常驻、没有有效租约（租约过期不依赖 gc）。 */
export function isIdle(slot: Slot, config: PoolConfig, now: Date): boolean {
  return slot.phase === "ready" && !isResident(slot, config) && !leaseActive(slot.lease, now);
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
