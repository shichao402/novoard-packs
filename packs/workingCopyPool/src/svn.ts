/**
 * 池用到的 svn 操作：统一的子进程调用（取消协议 ADR-0019 §5）、info/status 解析、
 * 稀疏检出与重新排除、落后 revision。所有命令以池根为 cwd、以绝对路径指定槽位，
 * 这样中断恢复时能按命令行认出还在跑的 svn 进程。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { runCommand, spawnCaptured } from "../../../shared/exec";
import { listOccupants } from "../../../shared/occupants";
import { cleanupAfterInterrupt, SVN_GRACEFUL_MS, tailLines } from "../../../shared/svn-run";
import { createUpdateProgress } from "../../../shared/svn-status";
import type { ToolRunContext } from "../../../shared/types";

export class SvnError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
  }
}

export class Cancelled extends Error {}

export type SvnRunOptions = {
  /** 被中断时对哪个工作副本补跑 cleanup；缺省不 cleanup。 */
  wc?: string;
  allowFail?: boolean;
  timeoutMs?: number;
  /** 进度前缀；给了就按 update 输出计数。 */
  progress?: string;
};

export type SvnCtx = Pick<ToolRunContext, "cwd" | "timeoutMs" | "logFile" | "abortSignal" | "onProgress">;

export async function svn(ctx: SvnCtx, args: string[], options: SvnRunOptions = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (ctx.abortSignal.aborted) throw new Cancelled("已取消");
  const counter = options.progress
    ? createUpdateProgress({ total: 0, emit: (message, percent) => ctx.onProgress?.(`${options.progress}：${message}`, percent) })
    : undefined;
  const result = await runCommand({
    command: "svn",
    args: [...args, "--non-interactive"],
    cwd: ctx.cwd,
    timeoutMs: options.timeoutMs ?? ctx.timeoutMs,
    logFile: ctx.logFile,
    abortSignal: ctx.abortSignal,
    gracefulMs: SVN_GRACEFUL_MS,
    onStdoutLine: counter?.line,
  }).done;
  if (result.cancelled) {
    const note = options.wc && existsSync(path.join(options.wc, ".svn")) ? await cleanupAfterInterrupt(args, { cwd: options.wc, logFile: ctx.logFile }) : "";
    if (result.timedOut && !ctx.abortSignal.aborted) throw new SvnError(`svn ${args[0]} 超时${note}`, result.stderr);
    throw new Cancelled(`已取消${note}`);
  }
  if (!options.allowFail && result.code !== 0) {
    throw new SvnError(tailLines(result.stderr || result.stdout) || `svn ${args[0]} 退出码 ${result.code}`, `${result.stdout}\n${result.stderr}`);
  }
  if (counter && result.code === 0) counter.finish();
  return result;
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export type SvnInfoEntry = { path: string; kind: string; revision: number; url: string; depth?: string; lastChangedRev?: number };

export function parseInfoXml(xml: string): SvnInfoEntry[] {
  const out: SvnInfoEntry[] = [];
  const re = /<entry\b([^>]*)>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    const attrs = match[1];
    const body = match[2];
    const attr = (name: string): string | undefined => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
    const url = /<url>([\s\S]*?)<\/url>/.exec(body)?.[1];
    const commit = /<commit\b[^>]*\brevision="(\d+)"/.exec(body)?.[1];
    out.push({
      path: unescapeXml(attr("path") ?? "").replace(/\\/g, "/"),
      kind: attr("kind") ?? "",
      revision: Number(attr("revision") ?? -1),
      url: unescapeXml(url ?? ""),
      depth: /<depth>([\s\S]*?)<\/depth>/.exec(body)?.[1],
      lastChangedRev: commit ? Number(commit) : undefined,
    });
  }
  return out;
}

export async function svnInfo(ctx: SvnCtx, target: string, extra: string[] = []): Promise<SvnInfoEntry | undefined> {
  const result = await svn(ctx, ["info", "--xml", ...extra, target], { allowFail: true, timeoutMs: Math.min(ctx.timeoutMs, 60_000) });
  if (result.code !== 0) return undefined;
  return parseInfoXml(result.stdout)[0];
}

export type StatusItem = {
  path: string;
  item: string;
  props: string;
  treeConflicted: boolean;
  wcLocked: boolean;
  switched: boolean;
  /** 本工作副本持有 svn lock 令牌（外部锁）。 */
  locked: boolean;
};

export function parseStatusXml(xml: string): StatusItem[] {
  const out: StatusItem[] = [];
  const re = /<entry\b([^>]*)>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    const p = /\bpath="([^"]*)"/.exec(match[1])?.[1];
    const wc = /<wc-status\b([^>]*)>([\s\S]*?)<\/wc-status>|<wc-status\b([^>]*)\/>/.exec(match[2]);
    if (p === undefined || !wc) continue;
    const attrs = wc[1] ?? wc[3] ?? "";
    const body = wc[2] ?? "";
    const attr = (name: string): string | undefined => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
    out.push({
      path: unescapeXml(p).replace(/\\/g, "/"),
      item: attr("item") ?? "normal",
      props: attr("props") ?? "none",
      treeConflicted: attr("tree-conflicted") === "true",
      wcLocked: attr("wc-locked") === "true",
      switched: attr("switched") === "true",
      locked: /<lock>/.test(body),
    });
  }
  return out;
}

export type StatusSummary = {
  /** 受版本控制的改动（修改、添加、删除、替换、丢失、属性改动）。 */
  versioned: StatusItem[];
  unversioned: StatusItem[];
  /** 需要人处理、不能自动存档的问题；空表示可以存档。 */
  problems: string[];
  incomplete: boolean;
  switched: boolean;
  wcLocked: boolean;
};

const VERSIONED_CHANGE = new Set(["modified", "added", "deleted", "replaced", "missing"]);

export function summarizeStatus(items: StatusItem[]): StatusSummary {
  const versioned: StatusItem[] = [];
  const unversioned: StatusItem[] = [];
  const conflicted: string[] = [];
  const tree: string[] = [];
  const obstructed: string[] = [];
  const locks: string[] = [];
  let incomplete = false;
  let switched = false;
  let wcLocked = false;
  for (const it of items) {
    if (it.item === "conflicted" || it.props === "conflicted") conflicted.push(it.path);
    if (it.treeConflicted) tree.push(it.path);
    if (it.item === "obstructed") obstructed.push(it.path);
    if (it.locked) locks.push(it.path);
    if (it.item === "incomplete") incomplete = true;
    if (it.switched) switched = true;
    if (it.wcLocked) wcLocked = true;
    if (it.item === "unversioned") unversioned.push(it);
    else if (VERSIONED_CHANGE.has(it.item) || it.props === "modified") versioned.push(it);
  }
  const list = (xs: string[]): string => xs.slice(0, 5).join("、") + (xs.length > 5 ? ` 等 ${xs.length} 个` : "");
  const problems: string[] = [];
  if (conflicted.length) problems.push(`冲突：${list(conflicted)}`);
  if (tree.length) problems.push(`树冲突：${list(tree)}`);
  if (obstructed.length) problems.push(`路径被阻碍：${list(obstructed)}`);
  if (locks.length) problems.push(`持有 svn 锁：${list(locks)}`);
  return { versioned, unversioned, problems, incomplete, switched, wcLocked };
}

export async function svnStatus(ctx: SvnCtx, wc: string, timeoutMs?: number): Promise<StatusSummary> {
  const result = await svn(ctx, ["status", "--xml", wc], { timeoutMs: timeoutMs ?? Math.min(ctx.timeoutMs, 10 * 60_000) });
  return summarizeStatus(parseStatusXml(result.stdout).map((it) => ({ ...it, path: relTo(wc, it.path, ctx.cwd) })));
}

/** svn 输出的路径（绝对，或在 cwd 之下时相对 cwd）转成相对工作副本根、正斜杠。 */
export function relTo(wc: string, p: string, cwd?: string): string {
  const norm = (cwd && !path.isAbsolute(p) ? path.resolve(cwd, p) : p).replace(/\\/g, "/");
  const root = wc.replace(/\\/g, "/").replace(/\/+$/, "");
  if (norm === root) return ".";
  if (norm.startsWith(`${root}/`)) return norm.slice(root.length + 1);
  return norm;
}

/** svn 报的工作副本阻碍类错误（未纳管文件挡路、树冲突），切换遇到时把槽位标为 blocked。 */
export function isObstruction(text: string): boolean {
  return /E155000|E155037|E195016|obstruct|tree conflict|树冲突|阻碍/i.test(text);
}

/**
 * 稀疏规划：被排除目录的各级父目录展开到 immediates，被排除目录 exclude，其余 infinity。
 * 返回父目录集合（相对路径，"" 为根）。
 */
export function sparseParents(exclude: string[]): Set<string> {
  const parents = new Set<string>();
  for (const item of exclude) {
    const parts = item.split("/");
    for (let i = 0; i < parts.length; i++) parents.add(parts.slice(0, i).join("/"));
  }
  return parents;
}

/** 本地目录下受版本控制的子目录名（immediates 展开后子目录以 empty 深度出现在磁盘上）。 */
function localChildDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name !== ".svn")
    .filter((name) => {
      try {
        return statSync(path.join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function abs(wc: string, rel: string): string {
  return rel ? path.join(wc, ...rel.split("/")) : wc;
}

async function setDepth(ctx: SvnCtx, wc: string, depth: string, rels: string[], label: string): Promise<void> {
  // 一次带太多目标会撞命令行长度上限，分批
  for (let i = 0; i < rels.length; i += 50) {
    const batch = rels.slice(i, i + 50).map((rel) => abs(wc, rel));
    await svn(ctx, ["update", "--set-depth", depth, ...batch], { wc, progress: label });
  }
}

/** 新建流程第 2 步：根目录 empty 检出后逐层展开，被排除目录从头到尾不下载。 */
export async function sparseCheckout(ctx: SvnCtx, url: string, wc: string, exclude: string[]): Promise<void> {
  if (exclude.length === 0) {
    await svn(ctx, ["checkout", url, wc], { wc, progress: "检出" });
    return;
  }
  await svn(ctx, ["checkout", "--depth", "empty", url, wc], { wc });
  await expandLevel(ctx, wc, "", new Set(exclude), sparseParents(exclude));
}

async function expandLevel(ctx: SvnCtx, wc: string, rel: string, exclude: Set<string>, parents: Set<string>): Promise<void> {
  await svn(ctx, ["update", "--set-depth", "immediates", abs(wc, rel)], { wc });
  const toExclude: string[] = [];
  const toFull: string[] = [];
  const toRecurse: string[] = [];
  for (const name of localChildDirs(abs(wc, rel))) {
    const child = rel ? `${rel}/${name}` : name;
    if (exclude.has(child)) toExclude.push(child);
    else if (parents.has(child)) toRecurse.push(child);
    else toFull.push(child);
  }
  if (toExclude.length) await setDepth(ctx, wc, "exclude", toExclude, "排除");
  if (toFull.length) await setDepth(ctx, wc, "infinity", toFull, "检出");
  for (const child of toRecurse) await expandLevel(ctx, wc, child, exclude, parents);
}

/**
 * switch / update 之后按 sparse.exclude 重新排除：目标分支新增的被排除目录会被拉下来，
 * 父目录下新增的普通子目录只会以 empty 深度出现，要补成 infinity。
 * 返回调整说明（dry-run 与日志用）。
 */
export async function reapplySparse(ctx: SvnCtx, wc: string, exclude: string[]): Promise<string[]> {
  if (exclude.length === 0) return [];
  const excludeSet = new Set(exclude);
  const parents = sparseParents(exclude);
  const notes: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const result = await svn(ctx, ["info", "--xml", "--depth", "immediates", abs(wc, rel)], { allowFail: true });
    if (result.code !== 0) return;
    const entries = parseInfoXml(result.stdout);
    const self = entries.find((e) => relTo(wc, e.path, ctx.cwd) === (rel || "."));
    if (self && self.depth !== "immediates" && self.depth !== "infinity") {
      await svn(ctx, ["update", "--set-depth", "immediates", abs(wc, rel)], { wc });
      notes.push(`展开 ${rel || "."}`);
      return walk(rel);
    }
    const toExclude: string[] = [];
    const toFull: string[] = [];
    const toRecurse: string[] = [];
    for (const entry of entries) {
      const child = relTo(wc, entry.path, ctx.cwd);
      if (child === (rel || ".") || entry.kind !== "dir") continue;
      // 已排除的目录 info 仍会列出（depth=exclude），对它再 set-depth 会报 E155007
      if (entry.depth === "exclude") continue;
      if (excludeSet.has(child)) toExclude.push(child);
      else if (parents.has(child)) toRecurse.push(child);
      else if (entry.depth && entry.depth !== "infinity") toFull.push(child);
    }
    if (toExclude.length) {
      await setDepth(ctx, wc, "exclude", toExclude, "排除");
      notes.push(`排除 ${toExclude.join("、")}`);
    }
    if (toFull.length) {
      await setDepth(ctx, wc, "infinity", toFull, "检出");
      notes.push(`补全 ${toFull.join("、")}`);
    }
    for (const child of toRecurse) await walk(child);
  };
  await walk("");
  return notes;
}

/** 落后多少个 revision：工作副本 revision 之后、这个分支 URL 上的提交数。读不到返回 undefined。 */
export async function behindCount(ctx: SvnCtx, wc: string): Promise<number | undefined> {
  const local = await svnInfo(ctx, wc);
  if (!local) return undefined;
  const remote = await svnInfo(ctx, local.url, ["-r", "HEAD"]);
  if (!remote || remote.lastChangedRev === undefined) return undefined;
  if (remote.lastChangedRev <= local.revision) return 0;
  const log = await svn(ctx, ["log", "-q", "-r", `${local.revision + 1}:HEAD`, local.url], { allowFail: true, timeoutMs: 60_000 });
  if (log.code !== 0) return undefined;
  return log.stdout.split(/\r?\n/).filter((line) => /^r\d+ /.test(line)).length;
}

/**
 * 是否有 svn 进程正在操作这个工作副本（PRD「并发」已知限制）。
 * Windows 查句柄与命令行；其他平台按命令行里出现槽位路径判断（本包的 svn 都以绝对路径传槽位）。
 */
export async function svnBusy(wc: string, abortSignal?: AbortSignal): Promise<boolean> {
  if (process.platform === "win32") {
    const list = await listOccupants(wc, abortSignal);
    return list.some((item) => /(^|[\\/])svn(\.exe)?$/i.test(item.name) || /^svn/i.test(path.parse(item.name).name));
  }
  try {
    const result = await spawnCaptured({ command: "ps", args: ["-Ao", "pid=,command="], timeoutMs: 10_000, abortSignal });
    const needle = path.resolve(wc);
    return result.stdout.split(/\r?\n/).some((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match || Number(match[1]) === process.pid) return false;
      const command = match[2];
      return /(^|\/)svn\s/.test(command) && command.includes(needle);
    });
  } catch {
    return false;
  }
}
