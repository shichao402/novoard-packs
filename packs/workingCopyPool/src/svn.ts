/**
 * 池用到的 svn 操作：统一的子进程调用（取消协议 ADR-0019 §5）、info/status 解析、
 * 稀疏检出与重新排除、落后 revision。所有命令以池根为 cwd、以绝对路径指定槽位，
 * 这样中断恢复时能按命令行认出还在跑的 svn 进程。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { runCommand, spawnCaptured } from "../../../shared/exec";
import { listOccupants } from "../../../shared/occupants";
import { cleanupAfterInterrupt, SVN_GRACEFUL_MS, tailLines } from "../../../shared/svn-run";
import { createUpdateProgress } from "../../../shared/svn-status";
import type { ToolRunContext } from "../../../shared/types";
import { isDepth, isFullCheckout, joinRel, SparsePlan, type Depth, type DirDepth, type SparseSpec } from "./sparse";

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
  /** 进度前缀；给了就按 update 输出计数（输出量大，捕获的 stdout 只留末尾）。 */
  progress?: string;
  /** stdout 逐行回调。输出很大、不需要整份 stdout 时用；给了就只留 stdout 末尾，不完整保留。 */
  onLine?: (line: string) => void;
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
    onStdoutLine: options.onLine ?? counter?.line,
    // info/status/ls/log/diff 都要整份解析：只留末尾会丢掉开头的条目（ls 两千多个分支只剩一半）
    fullStdout: !options.onLine && !counter,
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
  const resolved = Boolean(cwd) && !path.isAbsolute(p);
  const norm = (resolved ? path.resolve(cwd!, p) : p).replace(/\\/g, "/");
  // 相对路径 resolve 后带盘符（win32），根目录也同样 resolve 才能比较
  const root = (resolved ? path.resolve(wc) : wc).replace(/\\/g, "/").replace(/\/+$/, "");
  if (norm === root) return ".";
  if (norm.startsWith(`${root}/`)) return norm.slice(root.length + 1);
  return norm;
}

/** svn 报的工作副本阻碍类错误（未纳管文件挡路、树冲突），切换遇到时把槽位标为 blocked。 */
export function isObstruction(text: string): boolean {
  return /E155000|E155037|E195016|obstruct|tree conflict|树冲突|阻碍/i.test(text);
}

/** 稀疏执行（PRD「稀疏」）：规划见 sparse.ts。 */

function abs(wc: string, rel: string): string {
  return rel ? path.join(wc, ...rel.split("/")) : wc;
}

const DEPTH_LABEL: Record<Depth, string> = { exclude: "排除", empty: "空壳", files: "检出", immediates: "展开", infinity: "检出" };

async function setDepth(ctx: SvnCtx, wc: string, depth: Depth, rels: string[]): Promise<void> {
  // 一次带太多目标会撞命令行长度上限，分批
  for (let i = 0; i < rels.length; i += 50) {
    const batch = rels.slice(i, i + 50).map((rel) => abs(wc, rel));
    await svn(ctx, ["update", "--set-depth", depth, ...batch], { wc, progress: DEPTH_LABEL[depth] });
  }
}

/** 新建流程第 2 步：按规格检出，根目录先以规划的 depth 检出，再逐层调整，不需要的目录从头到尾不下载。 */
export async function sparseCheckout(ctx: SvnCtx, url: string, wc: string, spec: SparseSpec): Promise<void> {
  if (isFullCheckout(spec)) {
    await svn(ctx, ["checkout", url, wc], { wc, progress: "检出" });
    return;
  }
  const plan = new SparsePlan(spec);
  await svn(ctx, ["checkout", "--depth", plan.wcDepth("", spec.root), url, wc], { wc, progress: "检出" });
  await applySparse(ctx, wc, spec);
}

/**
 * 按规格把工作副本调整到位，新建、switch、update 之后都调用：
 * 列出的目录设到规划 depth；infinity 展开节点下新增的子目录补成 infinity；
 * 非 infinity 目录下需要的空壳和列出目录逐个带下来，不需要的排除。
 * 列出了但当前分支上没有的路径跳过并记一条说明。返回调整说明。
 */
export async function applySparse(ctx: SvnCtx, wc: string, spec: SparseSpec): Promise<string[]> {
  // 完整检出也走一遍：根目录若还是之前稀疏留下的 immediates/empty，设回 infinity 把排除的目录带回来
  const plan = new SparsePlan(spec);
  const notes: string[] = [];
  const missing: string[] = [];

  const readLevel = async (rel: string): Promise<{ self?: SvnInfoEntry; children: Map<string, SvnInfoEntry> } | undefined> => {
    const result = await svn(ctx, ["info", "--xml", "--depth", "immediates", abs(wc, rel)], { allowFail: true });
    if (result.code !== 0) return undefined;
    const children = new Map<string, SvnInfoEntry>();
    let self: SvnInfoEntry | undefined;
    for (const entry of parseInfoXml(result.stdout)) {
      const r = relTo(wc, entry.path, ctx.cwd);
      if (r === (rel || ".")) self = entry;
      else if (entry.kind === "dir") children.set(r, entry);
    }
    return { self, children };
  };

  const walk = async (rel: string, depth: Depth): Promise<void> => {
    let level = await readLevel(rel);
    if (!level?.self) return;
    if (!plan.satisfied(rel, depth, level.self.depth)) {
      const target = plan.wcDepth(rel, depth);
      await setDepth(ctx, wc, target, [rel]);
      notes.push(`${rel || "(根)"} 设为 ${target}`);
      level = await readLevel(rel);
      if (!level?.self) return;
    }
    if (!plan.hasDescendants(rel)) return;

    const buckets = new Map<Depth, string[]>();
    const push = (d: Depth, child: string): void => void buckets.set(d, [...(buckets.get(d) ?? []), child]);
    const recurse: [string, Depth][] = [];
    const needed = new Set(plan.neededChildren(rel).map((name) => joinRel(rel, name)));
    const shellParent = depth !== "infinity";

    for (const [child, entry] of level.children) {
      let d = plan.depthOf(child, depth);
      // 非 infinity 目录下没列出、也不是列出路径祖先的子目录：empty/files 下本不该在，排除；immediates 下保持 empty
      if (shellParent && !needed.has(child) && !(child in spec.paths) && depth !== "immediates") d = "exclude";
      if (d === "exclude") {
        if (entry.depth !== "exclude") push("exclude", child);
        continue;
      }
      if (plan.hasDescendants(child)) {
        recurse.push([child, d]);
        continue;
      }
      if (entry.depth !== d) push(d, child);
    }

    const toAdd: [string, Depth][] = [];
    for (const child of needed) {
      if (level.children.has(child)) continue;
      const d = plan.depthOf(child, depth);
      if (d === "exclude") continue;
      // infinity / immediates 目录下 info 会列出所有子目录，没列出就是分支上没有
      if (depth === "infinity" || depth === "immediates" || level.self.depth === "infinity" || level.self.depth === "immediates") {
        missing.push(child);
        continue;
      }
      toAdd.push([child, d]);
    }

    const order: Depth[] = ["exclude", "empty", "files", "immediates", "infinity"];
    for (const d of order) {
      const items = buckets.get(d);
      if (!items?.length) continue;
      await setDepth(ctx, wc, d, items);
      notes.push(`${DEPTH_LABEL[d]}（${d}）${items.join("、")}`);
    }
    for (const [child, d] of toAdd) {
      await setDepth(ctx, wc, plan.wcDepth(child, d), [child]);
      // 分支上没有这个路径时 svn update 返回 0 但什么也不建
      if (!existsSync(abs(wc, child))) {
        missing.push(child);
        continue;
      }
      if (plan.hasDescendants(child)) recurse.push([child, d]);
      else notes.push(`${DEPTH_LABEL[d]}（${d}）${child}`);
    }
    for (const [child, d] of recurse) await walk(child, d);
  };

  await walk("", spec.root);
  if (missing.length) notes.push(`分支上没有，已跳过：${missing.join("、")}`);
  return notes;
}

/**
 * 读工作副本每个目录的实际 depth（`svn info -R --show-item depth`，文件的 depth 为空，跳过）。
 * 逐行流式解析，不把整份输出留在内存里。
 */
export async function readDirDepths(ctx: SvnCtx, wc: string): Promise<DirDepth[]> {
  const dirs: DirDepth[] = [];
  await svn(ctx, ["info", "-R", "--show-item", "depth", wc], {
    onLine: (line) => {
      const match = /^(\S+)\s+(.+)$/.exec(line);
      if (!match || !isDepth(match[1])) return;
      const rel = relTo(wc, match[2].trim(), ctx.cwd);
      dirs.push({ rel: rel === "." ? "" : rel, depth: match[1] });
    },
  });
  return dirs;
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
