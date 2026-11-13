import { isCliEntry, main } from "../../../shared/cli";
import { runCommand } from "../../../shared/exec";
import type { ToolRunContext, ToolRunResult } from "../../../shared/types";
import { validateToolParams } from "../../../shared/validate";
import { isGitTool, runGitTool } from "./git";
import { manifest } from "./manifest";
import { cleanupAfterInterrupt, SVN_GRACEFUL_MS, svnCheckAndUpdate, svnRevertTree } from "./svn";

export { manifest };

const byId = new Map(manifest.tools.map((t) => [t.id, t]));

/** 分发逻辑从 cronkit `runBuiltinTool` 的 svn/git 分支移植；argv CLI 见 shared/cli（P4）。 */
export async function run(
  toolId: string,
  rawParams: Record<string, unknown> | undefined,
  ctx: ToolRunContext,
): Promise<ToolRunResult> {
  const tool = byId.get(toolId);
  if (!tool) {
    throw new Error(`versionControl 没有工具: ${toolId}`);
  }
  const { params, errors } = validateToolParams(tool, rawParams);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
  if (ctx.dryRun) {
    return { detail: `dry-run: ${tool.displayName} ${JSON.stringify(params)}`, code: 0 };
  }
  if (isGitTool(toolId)) {
    return runGitTool(toolId, params, ctx);
  }

  switch (toolId) {
    case "svn-update":
      return runSvnUpdate(params, ctx);
    case "svn-cleanup":
      return runSvnArgs(
        ctx,
        [
          "cleanup",
          ...(params.removeUnversioned === true ? ["--remove-unversioned", "--remove-ignored"] : []),
        ],
        "svn cleanup",
      );
    case "svn-revert":
      return svnRevertTree({
        workingCopy: ctx.cwd,
        timeoutMs: ctx.timeoutMs,
        logFile: ctx.logFile,
        abortSignal: ctx.abortSignal,
        recursive: params.recursive !== false,
        releaseOccupants: params.releaseOccupants !== false,
      });
    case "svn-switch":
      return runSvnArgs(ctx, ["switch", String(params.url)], "svn switch");
    case "svn-copy":
      return runSvnArgs(
        ctx,
        ["copy", String(params.source), String(params.destination), "-m", String(params.message)],
        "svn copy",
        true,
      );
    case "svn-delete":
      return runSvnArgs(ctx, ["delete", String(params.target), "-m", String(params.message)], "svn delete", true);
    default:
      throw new Error(`未实现工具: ${toolId}`);
  }
}

async function runSvnUpdate(params: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolRunResult> {
  const strategy = String(params.strategy ?? "follow-latest");
  if (strategy === "disabled") {
    return { detail: "strategy=disabled，跳过", code: 0, skipped: true };
  }
  const result = await svnCheckAndUpdate({
    workingCopy: ctx.cwd,
    timeoutMs: ctx.timeoutMs,
    logFile: ctx.logFile,
    abortSignal: ctx.abortSignal,
    skipUpdate: false,
    onConflict: (params.onConflict as "fail" | "postpone" | "revert") ?? "fail",
    backupOnRevert: params.backupOnRevert !== false,
    backupDir: typeof params.backupDir === "string" ? params.backupDir : undefined,
    localDate: ctx.localDate,
    releaseOccupants: params.releaseOccupants !== false,
    onProgress: ctx.onProgress,
  });
  return { detail: result.detail, code: result.code, skipped: result.skipped };
}

async function runSvnArgs(
  ctx: ToolRunContext,
  args: string[],
  label: string,
  allowUrlCwd = false,
): Promise<ToolRunResult> {
  const result = await runCommand({
    command: "svn",
    args,
    cwd: allowUrlCwd ? ctx.workspacePath : ctx.cwd,
    timeoutMs: ctx.timeoutMs,
    logFile: ctx.logFile,
    abortSignal: ctx.abortSignal,
    gracefulMs: SVN_GRACEFUL_MS,
  }).done;
  if (result.cancelled) {
    // URL 对 URL 的 copy/delete 不碰工作副本，不用 cleanup
    const note = allowUrlCwd ? "" : await cleanupAfterInterrupt(args, { cwd: ctx.cwd, logFile: ctx.logFile });
    throw new Error(`${result.timedOut ? `${label} 超时` : "已取消"}${note}`);
  }
  if (result.code !== 0) {
    throw new Error(tail(result.stderr || result.stdout) || `${label} 退出码 ${result.code}`);
  }
  return { detail: tail(result.stdout) || `${label} 完成`, code: result.code };
}

function tail(text: string): string {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-8).join("\n");
}

if (isCliEntry(import.meta.url)) {
  await main(manifest, run);
}
