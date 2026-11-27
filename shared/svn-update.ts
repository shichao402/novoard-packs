/**
 * SVN 更新与整树 revert（含写集预测、Windows 释放占用、冲突策略）。
 * versionControl 的 svn-update/svn-revert 与 workingCopyPool 的 refresh 共用（原在 packs/versionControl/src/svn.ts）。
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runCommand } from "./exec";
import { prepareExclusiveAccess } from "./occupants";
import { appendLog, cleanupAfterInterrupt, INTERRUPT_CLEANUP_MS, SVN_GRACEFUL_MS } from "./svn-run";
import { applySvnRules, RulesBlockedError, summarizeRules } from "./svn-resolve";
import { categoryOf, discardSet, type SvnRules } from "./svn-rules";
import {
  conflictedRelativesFromUpdateOutput,
  createUpdateProgress,
  isSvnLockError,
  parseStatusItems,
  parseSvnStatusXml,
  pathsFromSvnError,
  relativeFromStatusPath,
  relativeTo,
  resolveWriteTargets,
  revertWriteRelatives,
  updateWriteRelatives,
} from "./svn-status";

export { cleanupAfterInterrupt, INTERRUPT_CLEANUP_MS, SVN_GRACEFUL_MS };
export { RulesBlockedError };

/**
 * fail：有冲突就报错保留现场；postpone：挂起；revert：备份后整树还原；
 * rules：按项目 SVN 规则处理（可丢弃类别取远端/还原、命中规则取远端，其余阻塞），先存档再动手。
 */
export type ConflictPolicy = "fail" | "postpone" | "revert" | "rules";

/** onConflict=rules 的输入。 */
export type SvnRulesInput = {
  rules: SvnRules;
  /** 开启的可选类别。 */
  enable: readonly string[];
  /** 存档根；需要存档时在下面建 `<时间戳>` 目录。 */
  archiveRoot: string;
  now?: Date;
};

export async function svnCheckAndUpdate(options: {
  workingCopy: string;
  timeoutMs: number;
  logFile: string;
  abortSignal: AbortSignal;
  skipUpdate: boolean;
  onConflict?: ConflictPolicy;
  /** onConflict=rules 时必填。 */
  rules?: SvnRulesInput;
  backupOnRevert?: boolean;
  backupDir?: string;
  localDate?: string;
  releaseOccupants?: boolean;
  /** 阶段与文件计数进度（P5）；percent 未知时为 null。 */
  onProgress?: (message: string, percent?: number | null) => void;
}): Promise<{ skipped: boolean; detail: string; code: number | null; rulesArchiveDir?: string }> {
  if (!existsSync(options.workingCopy)) {
    throw new Error(`目录不存在: ${options.workingCopy}`);
  }
  if (!existsSync(path.join(options.workingCopy, ".svn"))) {
    throw new Error("不是 SVN 工作副本（缺少 .svn）");
  }

  const stage = (message: string): void => options.onProgress?.(message, null);
  const policy = options.onConflict ?? "fail";
  const notes: string[] = [];
  const canRelease = options.releaseOccupants === true && process.platform === "win32";
  const rulesInput = options.rules;
  if (policy === "rules" && !rulesInput) {
    throw new Error("onConflict=rules 需要提供 SVN 规则文件");
  }
  let rulesArchiveDir: string | undefined;
  const runRules = async (phase: string, forceArchive: string[] = []): Promise<void> => {
    const outcome = await applySvnRules({
      wc: options.workingCopy,
      cwd: options.workingCopy,
      run: (args, o) => runSvn(options, [...args, "--non-interactive"], `svn ${args[0]}`, o?.allowFail ?? false),
      rules: rulesInput!.rules,
      enable: rulesInput!.enable,
      archiveRoot: rulesInput!.archiveRoot,
      archiveDir: rulesArchiveDir,
      now: rulesInput!.now ?? new Date(),
      phase,
      forceArchive,
      cleanupLocks: true,
      onStage: stage,
    });
    rulesArchiveDir = outcome.archiveDir;
    for (const note of outcome.notes) if (!notes.includes(note)) notes.push(note);
    const summary = summarizeRules(outcome);
    if (summary) notes.push(`${phase}${summary}`);
    if (outcome.blocked.length > 0) throw new RulesBlockedError(outcome);
  };
  const done = (result: { skipped: boolean; detail: string; code: number | null }) =>
    rulesArchiveDir ? { ...result, rulesArchiveDir } : result;

  if (existsSync(path.join(options.workingCopy, ".svn", "lock"))) {
    if (policy !== "revert" && policy !== "rules") {
      throw new Error("工作副本有 in-progress 锁（.svn/lock），未执行 cleanup");
    }
    if (canRelease) {
      await releasePredicted(options, [], "in-progress 锁");
    }
    await runSvn(options, ["cleanup"], "svn cleanup");
    notes.push("已 svn cleanup 解除 in-progress 锁");
  }

  stage("检查工作副本状态");
  const status = await runSvn(options, ["status", "--xml"], "svn status");
  let statusXml = status.stdout;
  let incomingXml: string | undefined;
  if (!options.skipUpdate) {
    stage("查询远端变更");
    const remote = await runSvn(options, ["status", "-u", "--xml"], "svn status -u", true);
    if (remote.code === 0 && remote.stdout.trim()) {
      incomingXml = remote.stdout;
      statusXml = incomingXml;
    } else {
      notes.push("无法取得远端状态，仅按本地 svn status 估计写集");
    }
  }

  const predicted = predictWriteRelatives(statusXml, incomingXml, {
    skipUpdate: options.skipUpdate,
    willRevertProblems: policy === "revert" && Boolean(findSvnProblem(status.stdout)),
    extraLocal: policy === "rules" ? rulesLocalWrites(options.workingCopy, status.stdout, rulesInput!) : [],
  });
  logWriteSet(options.logFile, predicted, incomingXml ? "update" : "local");

  if (canRelease && predicted.rels.length > 0) {
    const released = await releasePredicted(options, predicted.rels, "svn-update 写集");
    if (released) {
      notes.push(released);
    }
  } else if (predicted.rels.length > 0 && !canRelease) {
    notes.push(
      `预计写入 ${predicted.rels.length} 个路径（未自动释放占用；可将 with.releaseOccupants 设为 true）`,
    );
  }

  const problem = findSvnProblem(status.stdout);
  if (policy === "rules") {
    // 冲突、可丢弃类别的本地改动、switched 路径都交给规则；将与远端合并的本地修改先存档
    await runRules("更新前", mergeTargets(options.workingCopy, incomingXml));
  } else if (problem) {
    if (policy === "postpone") {
      return {
        skipped: true,
        detail: `${problem}，按 onConflict=postpone 保留现场挂起，处理完下轮自动继续:\n  ${conflictedRelatives(status.stdout)}`,
        code: 0,
      };
    }
    if (policy !== "revert") {
      throw new Error(`${problem}。已保留现场，未自动 cleanup/revert`);
    }
    const backup = await backupDirty(options, status.stdout);
    if (backup) {
      notes.push(`冲突/改动已备份到 ${backup}`);
    }
    if (canRelease) {
      await releasePredicted(options, revertWriteRelatives(parseSvnStatusXml(status.stdout)), "svn revert");
    }
    await resetWorkingCopy(options);
    notes.push("已按 onConflict=revert 执行 cleanup/revert");
  }

  if (options.skipUpdate) {
    return done({ skipped: true, detail: notes.join("；") || "按策略跳过 svn update", code: 0 });
  }

  stage(incomingXml ? `开始更新，远端变更约 ${predicted.incoming} 个路径` : "开始更新");
  const counter = createUpdateProgress({
    total: incomingXml ? predicted.incoming : 0,
    emit: (message, percent) => options.onProgress?.(message, percent),
  });
  // update 输出可能很大、捕获的 stdout 只留末尾，冲突行逐行收集，不从 stdout 事后解析
  const updateConflicts = new Set<string>();
  const update = await runSvn(
    options,
    ["update", "--non-interactive", "--accept", "postpone"],
    "svn update",
    true,
    (line) => {
      counter.line(line);
      for (const rel of conflictedRelativesFromUpdateOutput(line)) updateConflicts.add(rel);
    },
  );
  if (update.code === 0) {
    counter.finish();
    const conflicts = [...updateConflicts];
    if (conflicts.length > 0 && policy === "rules") {
      notes.push(`svn update 产生 ${conflicts.length} 个冲突，按规则处理`);
      await runRules("更新后");
    } else if (conflicts.length > 0 && policy === "postpone") {
      return {
        skipped: true,
        detail: `svn update 产生 ${conflicts.length} 个冲突，按 onConflict=postpone 保留现场挂起，处理完下轮自动继续:\n  ${conflicts.slice(0, 20).join("\n  ")}`,
        code: 0,
      };
    } else if (conflicts.length > 0) {
      throw new Error(`svn update 产生 ${conflicts.length} 个冲突:\n  ${conflicts.slice(0, 20).join("\n  ")}`);
    }
    notes.push(tail(update.stdout) || "svn update 完成");
    return done({ skipped: false, detail: notes.join("；"), code: update.code });
  }

  const updateProblem =
    findSvnProblem(update.stdout + update.stderr) ?? tail(update.stderr) ?? `svn update 退出码 ${update.code}`;
  const lockHit = isSvnLockError(update.stdout + update.stderr);

  if (canRelease && lockHit) {
    const extra = pathsFromSvnError(`${update.stdout}\n${update.stderr}`).map((item) =>
      path.isAbsolute(item) ? path.relative(options.workingCopy, item) : item,
    );
    notes.push("更新被文件独占打断，cleanup 并释放占用后重试");
    await runSvn(options, ["cleanup"], "svn cleanup", true);
    await releasePredicted(options, [...predicted.rels, ...extra], "update 独占重试");
    const retry = await runSvn(options, ["update", "--non-interactive", "--accept", "postpone"], "svn update retry", true);
    if (retry.code === 0) {
      notes.push("释放占用后已重新 update");
      if (policy === "rules") await runRules("更新后");
      return done({ skipped: false, detail: [...notes, tail(retry.stdout) || "svn update 完成"].join("；"), code: retry.code });
    }
  }

  if (policy !== "revert") {
    throw new Error(updateProblem);
  }
  const backup = await backupDirty(
    options,
    (await runSvn(options, ["status", "--xml"], "svn status", true)).stdout,
  );
  if (backup) {
    notes.push(`更新失败后的改动已备份到 ${backup}`);
  }
  if (canRelease) {
    await releasePredicted(options, predicted.rels, "update 失败后 revert");
  }
  await resetWorkingCopy(options);
  const retry = await runSvn(options, ["update"], "svn update retry");
  notes.push("revert 后已重新 update");
  return { skipped: false, detail: [...notes, tail(retry.stdout) || "svn update 完成"].join("；"), code: retry.code };
}

export async function svnRevertTree(options: {
  workingCopy: string;
  timeoutMs: number;
  logFile: string;
  abortSignal: AbortSignal;
  recursive?: boolean;
  releaseOccupants?: boolean;
}): Promise<{ detail: string; code: number | null }> {
  const status = await runSvn(options, ["status", "--xml"], "svn status", true);
  const rels = revertWriteRelatives(parseSvnStatusXml(status.stdout));
  logWriteSet(options.logFile, { rels, incoming: 0, local: rels.length }, "revert");
  if (options.releaseOccupants === true && process.platform === "win32") {
    await releasePredicted(options, rels, "svn revert 写集");
  }
  const args = ["revert", ...(options.recursive === false ? [] : ["-R"]), "."];
  const result = await runSvn(options, args, "svn revert");
  return { detail: tail(result.stdout) || "svn revert 完成", code: result.code };
}

function predictWriteRelatives(
  localXml: string,
  incomingXml: string | undefined,
  options: { skipUpdate: boolean; willRevertProblems: boolean; extraLocal?: string[] },
): { rels: string[]; incoming: number; local: number } {
  const localEntries = parseSvnStatusXml(localXml);
  const local = revertWriteRelatives(localEntries);
  const extra = options.extraLocal ?? [];
  if (options.skipUpdate) {
    return {
      rels: options.willRevertProblems ? local : extra,
      incoming: 0,
      local: local.length,
    };
  }
  const incomingEntries = parseSvnStatusXml(incomingXml ?? localXml);
  const incoming = updateWriteRelatives(incomingEntries, false);
  const rels = options.willRevertProblems
    ? [...new Set([...incoming, ...local])]
    : [...new Set([...incoming, ...extra])];
  return { rels, incoming: incoming.length, local: local.length };
}

/** 规则可能改写的本地路径：冲突条目，以及可丢弃类别里的本地改动。 */
function rulesLocalWrites(wc: string, localXml: string, input: SvnRulesInput): string[] {
  const discard = discardSet(input.rules, input.enable);
  const out: string[] = [];
  for (const it of parseStatusItems(localXml)) {
    const rel = relativeTo(wc, it.path, wc);
    if (rel === ".") continue;
    const conflicted = it.item === "conflicted" || it.props === "conflicted" || it.treeConflicted;
    const dirty = conflicted || ["modified", "added", "deleted", "replaced", "missing"].includes(it.item) || it.props === "modified";
    if (!dirty) continue;
    const cat = categoryOf(input.rules, rel);
    if (conflicted || (cat && discard.has(cat.name))) out.push(relativeFromStatusPath(rel));
  }
  return out;
}

/** update 会把远端改动合并进来的本地修改（本地 M/R，远端 M/R/D）；规则先把它们存档。 */
function mergeTargets(wc: string, incomingXml: string | undefined): string[] {
  if (!incomingXml) return [];
  const incoming = new Set(["modified", "replaced", "deleted"]);
  return parseSvnStatusXml(incomingXml)
    .filter((e) => (e.wcItem === "modified" || e.wcItem === "replaced") && e.reposItem !== undefined && incoming.has(e.reposItem))
    .map((e) => relativeTo(wc, e.path.replace(/\\/g, "/"), wc))
    .filter((rel) => rel !== ".");
}

function logWriteSet(
  logFile: string,
  predicted: { rels: string[]; incoming: number; local: number },
  kind: string,
): void {
  const preview = predicted.rels.slice(0, 30).join("\n  ");
  const extra = predicted.rels.length > 30 ? `\n  …共 ${predicted.rels.length} 个` : "";
  appendLog(
    logFile,
    `[novoard-packs] svn 写集(${kind}) incoming=${predicted.incoming} localDirty=${predicted.local} probe=${predicted.rels.length}` +
      (preview ? `\n  ${preview}${extra}` : " (无)"),
  );
}

async function releasePredicted(
  options: { workingCopy: string; abortSignal: AbortSignal; logFile: string },
  rels: string[],
  label: string,
): Promise<string | undefined> {
  const extraFiles = resolveWriteTargets(options.workingCopy, rels);
  const prepared = await prepareExclusiveAccess({
    target: options.workingCopy,
    abortSignal: options.abortSignal,
    extraFiles,
    includeUnityByName: false,
  });
  const closed = prepared.closed.map((item) => `${item.name}(${item.pid})`).join(", ");
  appendLog(
    options.logFile,
    `[novoard-packs] ${label} 释放占用 closed=${prepared.closed.length}${closed ? ` ${closed}` : ""} remaining=${prepared.remaining.length}`,
  );
  if (prepared.remaining.length > 0) {
    const names = prepared.remaining.map((item) => `${item.name}(${item.pid})`).join(", ");
    throw new Error(`无法释放 SVN 写路径占用: ${names}`);
  }
  if (prepared.remainingLocks.length > 0) {
    throw new Error(`无法释放 Unity 项目锁: ${prepared.remainingLocks.join(", ")}`);
  }
  if (prepared.closed.length === 0) {
    return undefined;
  }
  return `已结束占用进程 ${closed}`;
}

async function runSvn(
  options: {
    workingCopy: string;
    timeoutMs: number;
    logFile: string;
    abortSignal: AbortSignal;
  },
  args: string[],
  label: string,
  allowFail = false,
  onStdoutLine?: (line: string) => void,
) {
  const result = await runCommand({
    command: "svn",
    args,
    cwd: options.workingCopy,
    timeoutMs: args.includes("status") ? Math.min(options.timeoutMs, 10 * 60_000) : options.timeoutMs,
    logFile: options.logFile,
    abortSignal: options.abortSignal,
    gracefulMs: SVN_GRACEFUL_MS,
    onStdoutLine,
    // status/info/diff/list 的输出要整份解析（写集预测、冲突判断、存档）；update/revert 输出只看尾部
    fullStdout: ["status", "info", "diff", "list"].includes(args[0]),
  }).done;
  if (result.cancelled) {
    const note = await cleanupAfterInterrupt(args, { cwd: options.workingCopy, logFile: options.logFile });
    throw new Error(`${result.timedOut ? `${label} 超时` : "已取消"}${note}`);
  }
  if (!allowFail && result.code !== 0) {
    throw new Error(tail(result.stderr) || `${label} 退出码 ${result.code}`);
  }
  return result;
}

async function resetWorkingCopy(options: {
  workingCopy: string;
  timeoutMs: number;
  logFile: string;
  abortSignal: AbortSignal;
}): Promise<void> {
  await runSvn(options, ["cleanup"], "svn cleanup", true);
  await runSvn(options, ["revert", "-R", "."], "svn revert");
  await runSvn(options, ["cleanup", "--remove-unversioned", "--remove-ignored"], "svn cleanup unversioned", true);
}

async function backupDirty(
  options: {
    workingCopy: string;
    backupOnRevert?: boolean;
    backupDir?: string;
    localDate?: string;
  },
  statusXml: string,
): Promise<string | undefined> {
  if (options.backupOnRevert === false) {
    return undefined;
  }
  const rels = revertWriteRelatives(parseSvnStatusXml(statusXml)).filter((rel) => !shouldSkipBackup(rel));
  const root = resolveBackupRoot(options.workingCopy, options.backupDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destRoot = path.join(root, options.localDate ?? stamp.slice(0, 10), stamp);
  mkdirSync(destRoot, { recursive: true });
  const copied: string[] = [];
  for (const rel of rels) {
    const from = path.join(options.workingCopy, rel);
    if (!existsSync(from)) {
      continue;
    }
    const to = path.join(destRoot, rel);
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to, {
      recursive: true,
      force: true,
      filter: (src) => !shouldSkipBackup(path.relative(options.workingCopy, src)),
    });
    copied.push(rel);
  }
  writeFileSync(path.join(destRoot, "manifest.txt"), copied.join("\n") || "(没有可备份的脏文件)", "utf8");
  return destRoot;
}

export function resolveBackupRoot(workingCopy: string, backupDir?: string): string {
  if (backupDir) {
    return path.isAbsolute(backupDir) ? backupDir : path.resolve(workingCopy, backupDir);
  }
  return `${workingCopy.replace(/[\\/]+$/, "")}_backup`;
}

function shouldSkipBackup(rel: string): boolean {
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return (
    norm === ".svn" ||
    norm.startsWith(".svn/") ||
    norm === "Library" ||
    norm.startsWith("Library/") ||
    norm === "Temp" ||
    norm.startsWith("Temp/") ||
    norm === "Logs" ||
    norm.startsWith("Logs/") ||
    norm.includes("/Library/") ||
    norm.includes("/Temp/")
  );
}

function conflictedRelatives(statusXml: string): string {
  const rels = parseSvnStatusXml(statusXml)
    .filter((entry) => entry.wcItem === "conflicted")
    .map((entry) => relativeFromStatusPath(entry.path));
  return rels.length > 0 ? rels.slice(0, 20).join("\n  ") : "(status 未标出冲突条目)";
}

function findSvnProblem(xml: string): string | undefined {
  if (/item="conflicted"/.test(xml) || />conflicted</.test(xml) || /props="conflicted"/.test(xml) || /tree-conflicted="true"/.test(xml)) {
    return "工作副本存在冲突";
  }
  if (/item="obstructed"/.test(xml)) {
    return "工作副本存在 obstructed 路径";
  }
  if (/item="incomplete"/.test(xml)) {
    return "工作副本不完整";
  }
  if (/wc-locked="true"/.test(xml)) {
    return "工作副本被锁定";
  }
  return undefined;
}

function tail(text: string): string {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-8).join("\n");
}
