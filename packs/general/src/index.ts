import path from "node:path";
import { isCliEntry, main } from "../../../shared/cli";
import { releaseOccupants } from "../../../shared/occupants";
import type { ToolRunContext, ToolRunResult } from "../../../shared/types";
import { validateToolParams } from "../../../shared/validate";
import { quitIdleApps } from "./idle-quit";
import { manifest } from "./manifest";
import { warmupUnity } from "./unity";

export { manifest };

const byId = new Map(manifest.tools.map((t) => [t.id, t]));

/** 分发逻辑从 cronkit `runBuiltinTool` 的 unity-warmup/quit-idle 分支移植；argv CLI 见 shared/cli（P4）。 */
export async function run(
  toolId: string,
  rawParams: Record<string, unknown> | undefined,
  ctx: ToolRunContext,
): Promise<ToolRunResult> {
  const tool = byId.get(toolId);
  if (!tool) {
    throw new Error(`general 没有工具: ${toolId}`);
  }
  const { params, errors } = validateToolParams(tool, rawParams);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
  if (tool.platforms && !tool.platforms.includes(process.platform as "win32" | "darwin" | "linux")) {
    throw new Error(`${toolId} 不支持当前平台 ${process.platform}（支持 ${tool.platforms.join("/")}）`);
  }
  if (ctx.dryRun) {
    return { detail: `dry-run: ${tool.displayName} ${JSON.stringify(params)}`, code: 0 };
  }

  switch (toolId) {
    case "unity-warmup":
      return warmupUnity({
        projectPath: ctx.cwd,
        timeoutMs: ctx.timeoutMs,
        logFile: ctx.logFile,
        abortSignal: ctx.abortSignal,
        nographics: params.nographics === true,
        executeMethod: typeof params.executeMethod === "string" ? params.executeMethod : null,
        lowPriority: true,
        onProgress: ctx.onProgress,
      });
    case "quit-idle":
      return quitIdleApps(
        {
          processNames: params.processNames as string[],
          idleFor: String(params.idleFor),
          countIdleFrom: String(params.countIdleFrom ?? "00:00"),
          until: String(params.until ?? "08:00"),
          // cronkit 传的是 step 原始 timeout 字符串；这里由 ctx.timeoutMs 还原。
          timeout: `${Math.max(0, Math.floor(ctx.timeoutMs))}ms`,
          retryInterval: typeof params.retryInterval === "string" ? params.retryInterval : undefined,
          closeWait: typeof params.closeWait === "string" ? params.closeWait : undefined,
        },
        ctx.logFile,
      );
    case "release-occupants":
      return runReleaseOccupants(params, ctx);
    default:
      throw new Error(`未实现工具: ${toolId}`);
  }
}

async function runReleaseOccupants(params: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolRunResult> {
  const target = path.resolve(ctx.cwd, String(params.path));
  const extraFiles = (params.extraFiles as string[] | undefined)?.map((f) => path.resolve(ctx.cwd, f));
  const { closed, remaining } = await releaseOccupants({ target, extraFiles, abortSignal: ctx.abortSignal });
  const fmt = (list: { name: string; pid: number }[]) => list.map((o) => `${o.name}(${o.pid})`).join(", ");
  if (remaining.length > 0) {
    throw new Error(`无法释放占用: ${fmt(remaining)}`);
  }
  return {
    detail: closed.length > 0 ? `已结束占用进程 ${fmt(closed)}` : "没有需要释放的占用进程",
    code: 0,
  };
}

if (isCliEntry(import.meta.url)) {
  await main(manifest, run);
}
