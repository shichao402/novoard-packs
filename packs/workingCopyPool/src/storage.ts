/**
 * 多盘槽位分配：池定义目录只存配置、状态、入口与存档，槽位放在 [storage].roots 列出的目录里，
 * 落点由 state.json 的 slot.path 固定。分配只读磁盘，不创建目录；新建流程随后用 exclusive mkdir 确认目录所有权。
 */
import { lstatSync, realpathSync, statfsSync, statSync } from "node:fs";
import path from "node:path";
import type { PoolConfig, StorageRoot } from "./config";
import { slotDir, type PoolPaths, type PoolState } from "./state";

export class StorageOwnershipError extends Error {}

export const GIB = 1024 ** 3;
export type StorageInfo = { root: string; volume: string; freeGiB: number };
export type InspectStorage = (root: string) => StorageInfo;

/** 候选根目录必须已经存在；不把未挂载的盘或拼错的目录静默创建到别处。 */
export function inspectStorage(root: string): StorageInfo {
  const physical = realpathSync(root);
  const stat = statSync(physical);
  if (!stat.isDirectory()) throw new Error("不是目录");
  const fs = statfsSync(physical);
  return { root: physical, volume: String(stat.dev), freeGiB: Number(fs.bavail) * Number(fs.bsize) / GIB };
}

/** 外置槽位的盘不可访问时应保留记录，不按“工作副本缺失”删除或换盘重建。 */
export function assertStorageParent(wc: string): void {
  try {
    if (!statSync(path.dirname(wc)).isDirectory()) throw new Error("不是目录");
  } catch (error) {
    throw new Error(`槽位存储目录不可访问：${path.dirname(wc)}；保留槽位记录，请检查磁盘挂载（${error instanceof Error ? error.message : String(error)}）`);
  }
}

function key(p: string): string {
  const normalized = path.resolve(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function physical(p: string): string {
  try { return realpathSync(p); } catch { return path.resolve(p); }
}

function contains(parent: string, child: string): boolean {
  const rel = path.relative(key(parent), key(child));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function existsEntry(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 槽位所在的存储根：按词法路径或物理路径匹配槽位的父目录；配置里已删掉的目录返回 undefined。 */
export function rootOf(storage: PoolConfig["storage"], wc: string): StorageRoot | undefined {
  const parent = path.dirname(wc);
  const lexical = key(parent);
  const real = key(physical(parent));
  return storage.roots.find((r) => key(r.path) === lexical || key(physical(r.path)) === real);
}

/** 在槽位所在目录新建时要求的剩余空间：该目录单独的下限，没有则用 [storage].minFreeGiB。 */
export function minFreeFor(storage: PoolConfig["storage"], wc: string): number {
  return rootOf(storage, wc)?.minFreeGiB ?? storage.minFreeGiB;
}

/**
 * 锁内为新槽位选择落点：剩余空间最多的合格目录优先，同空间按 roots 配置顺序。
 * 每个目录的 minFreeGiB 是在那里新建的准入阈值，不是工程大小预测；同一卷上并发新建按各自下限保守预留。
 * 现有槽位的路径不受 roots 修改影响，候选目录下已有同名内容（含断链）一律不覆盖。
 */
export function selectSlotPath(
  paths: PoolPaths,
  state: PoolState,
  id: string,
  storage: PoolConfig["storage"],
  inspect: InspectStorage = inspectStorage,
): string {
  if (!storage.roots.length) throw new Error(`没有配置槽位存储目录（${id}）：请在 [storage].roots 列出允许放槽位的目录`);
  const notes: string[] = [];
  const candidates: Array<StorageInfo & { wc: string; available: number }> = [];
  const occupied = state.slots.map((s) => physical(slotDir(paths, s)));
  const protectedDirs = [paths.meta, paths.branch, paths.patches].map(physical);
  const physicalPool = physical(paths.root);
  const reservations = new Map<string, number>();
  for (const slot of state.slots) {
    if (slot.op?.kind !== "create") continue;
    try {
      const wc = slotDir(paths, slot);
      const disk = inspect(path.dirname(wc));
      reservations.set(disk.volume, (reservations.get(disk.volume) ?? 0) + minFreeFor(storage, wc));
    } catch {
      // 不可访问的旧落点不参与其他盘的预留；槽位本身仍由恢复流程保留并报告。
    }
  }
  const seen = new Set<string>();
  for (const root of storage.roots) {
    try {
      const disk = inspect(root.path);
      if (!Number.isFinite(disk.freeGiB) || disk.freeGiB < 0) throw new Error("无法读取有效的剩余空间");
      const wc = path.join(disk.root, id);
      if (seen.has(key(wc))) continue;
      seen.add(key(wc));
      if (contains(physicalPool, wc) || contains(wc, physicalPool) || protectedDirs.some((p) => contains(p, wc) || contains(wc, p))) {
        throw new Error("不能把槽位放进池定义目录（配置、入口或存档）");
      }
      if (occupied.some((p) => contains(p, wc) || contains(wc, p))) throw new Error("与已有槽位路径重叠");
      if (existsEntry(wc)) throw new Error(`已有 ${id} 目录或链接，不覆盖`);
      const available = disk.freeGiB - (reservations.get(disk.volume) ?? 0);
      if (available < root.minFreeGiB) {
        throw new Error(`剩余 ${disk.freeGiB.toFixed(1)} GiB，扣除并发预留后 ${available.toFixed(1)} GiB，要求至少 ${root.minFreeGiB} GiB`);
      }
      candidates.push({ ...disk, wc, available });
    } catch (error) {
      notes.push(`${root.path}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  candidates.sort((a, b) => b.available - a.available);
  if (!candidates.length) throw new Error(`没有可用的槽位存储目录（${id}）：\n${notes.join("\n")}\n请检查 [storage].roots 与各目录的 minFreeGiB；不会自动回退到未配置的磁盘`);
  return candidates[0].wc;
}

/** 分配后、检出前再检查一次，以应对别的程序消耗磁盘空间。 */
export function checkCreationSpace(wc: string, minFreeGiB: number): void {
  assertStorageParent(wc);
  const disk = inspectStorage(path.dirname(wc));
  if (disk.freeGiB < minFreeGiB) {
    throw new Error(`槽位 ${wc} 剩余 ${disk.freeGiB.toFixed(1)} GiB，新建要求至少 ${minFreeGiB} GiB；未开始检出`);
  }
}
