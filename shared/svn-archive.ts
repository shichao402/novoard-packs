/**
 * 改动存档的公共部分：时间戳目录名、补丁路径改写。
 * workingCopyPool 的 archiveChanges 与 svn-resolve 的规则存档共用。
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

/** 本地时间 YYYYMMDD-HHMMSS。 */
export function archiveStamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** 在 root 下建 `<stamp>` 目录，已存在时依次加 `_2`、`_3`…；返回新建的目录。 */
export function createArchiveDir(root: string, now: Date): string {
  const base = path.join(root, archiveStamp(now));
  let dir = base;
  for (let i = 2; existsSync(dir); i++) dir = `${base}_${i}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** svn diff 以绝对路径为目标时 Index 行是绝对路径；改成相对工作副本根，svn patch 才能在别处应用。 */
export function toRelativePatch(diff: string, wc: string): string {
  const variants = [wc, wc.replace(/\\/g, "/")].map((p) => p.replace(/[\\/]+$/, ""));
  let out = diff;
  for (const v of new Set(variants)) {
    out = out.split(`${v}/`).join("").split(`${v}\\`).join("");
  }
  return out;
}
