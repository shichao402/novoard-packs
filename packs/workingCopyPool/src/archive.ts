/**
 * 改动存档（PRD「改动存档」）与虚拟入口链接。
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { branchDirName, type PoolPaths } from "./state";
import { svn, svnStatus, type StatusSummary, type SvnCtx } from "./svn";

export type ArchiveResult = {
  /** 存档目录；没有改动时为空。 */
  dir?: string;
  versioned: number;
  unversioned: number;
  /** 需要人处理的问题；有值时什么都没动，槽位应标为 blocked。 */
  blocked?: string;
};

export function archiveStamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * 1. svn status 收集改动；冲突、树冲突、阻碍、svn 锁 → 不处理，返回 blocked。
 * 2. 受版本控制的改动：svn diff 写 changes.patch，改动过的文件另拷一份到 files/（二进制改动 patch 装不下），再 revert。
 * 3. 未纳管文件：只写清单 unversioned.txt，不删除。
 */
export async function archiveChanges(
  ctx: SvnCtx,
  paths: PoolPaths,
  wc: string,
  branch: string,
  now: Date,
  status?: StatusSummary,
): Promise<ArchiveResult> {
  const st = status ?? (await svnStatus(ctx, wc));
  if (st.problems.length > 0) {
    return { versioned: st.versioned.length, unversioned: st.unversioned.length, blocked: st.problems.join("；") };
  }
  if (st.versioned.length === 0 && st.unversioned.length === 0) {
    return { versioned: 0, unversioned: 0 };
  }
  const base = path.join(paths.patches, branchDirName(branch || "_unknown"), archiveStamp(now));
  let dir = base;
  for (let i = 2; existsSync(dir); i++) dir = `${base}_${i}`;
  mkdirSync(dir, { recursive: true });

  if (st.versioned.length > 0) {
    const diff = await svn(ctx, ["diff", "--internal-diff", wc], { timeoutMs: Math.min(ctx.timeoutMs, 30 * 60_000) });
    writeFileSync(path.join(dir, "changes.patch"), toRelativePatch(diff.stdout, wc), "utf8");
    const copied: string[] = [];
    for (const it of st.versioned) {
      if (it.item !== "modified" && it.item !== "added" && it.item !== "replaced") continue;
      const from = path.join(wc, ...it.path.split("/"));
      try {
        if (!statSync(from).isFile()) continue;
      } catch {
        continue;
      }
      const to = path.join(dir, "files", ...it.path.split("/"));
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(from, to);
      copied.push(it.path);
    }
    writeFileSync(
      path.join(dir, "versioned.txt"),
      `${st.versioned.map((it) => `${it.item.padEnd(9)} ${it.path}`).join("\n")}\n`,
      "utf8",
    );
    await svn(ctx, ["revert", "-R", wc], { wc, timeoutMs: Math.min(ctx.timeoutMs, 30 * 60_000) });
  }
  if (st.unversioned.length > 0) {
    writeFileSync(path.join(dir, "unversioned.txt"), `${st.unversioned.map((it) => it.path).join("\n")}\n`, "utf8");
  }
  writeFileSync(
    path.join(dir, "README.txt"),
    [
      `分支：${branch}`,
      `时间：${now.toISOString()}`,
      `受版本控制的改动 ${st.versioned.length} 项（changes.patch；改动文件原样拷在 files/）`,
      `未纳管文件 ${st.unversioned.length} 项（unversioned.txt，仅清单，文件仍留在工作副本里）`,
      "恢复：在该分支的工作副本根执行 svn patch <本目录>/changes.patch；二进制文件从 files/ 拷回。",
      "",
    ].join("\n"),
    "utf8",
  );
  return { dir, versioned: st.versioned.length, unversioned: st.unversioned.length };
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

/** 链接是否存在（含断链）。 */
export function linkExists(link: string): boolean {
  try {
    lstatSync(link);
    return true;
  } catch {
    return false;
  }
}

export function isLink(link: string): boolean {
  try {
    return lstatSync(link).isSymbolicLink() || (process.platform === "win32" && isJunction(link));
  } catch {
    return false;
  }
}

function isJunction(link: string): boolean {
  try {
    readlinkSync(link);
    return true;
  } catch {
    return false;
  }
}

export function linkTarget(link: string): string | undefined {
  try {
    return path.resolve(path.dirname(link), readlinkSync(link));
  } catch {
    return undefined;
  }
}

/** 删除链接本身，绝不递归进目标目录；不是链接时报错。 */
export function removeLink(link: string): void {
  if (!linkExists(link)) return;
  if (!isLink(link)) throw new Error(`${link} 不是链接，池子不删除它`);
  try {
    unlinkSync(link);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    // Windows 上目录链接有时只能当目录删；不加 recursive，删不到目标内容
    rmSync(link, { force: true });
  }
}

/** 建 `branch/<分支>` → 槽位；Windows 用 junction（不需要管理员权限），其他平台用符号链接。 */
export function createLink(target: string, link: string): void {
  if (linkExists(link)) {
    if (isLink(link) && samePath(linkTarget(link), target)) return;
    removeLink(link);
  }
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(path.resolve(target), link, process.platform === "win32" ? "junction" : "dir");
}

export function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string): string => {
    const r = path.resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}
