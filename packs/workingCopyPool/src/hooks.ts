/** 配置驱动的项目预更新钩子；不包含任何项目名、资产路径或包间依赖。 */
import { existsSync } from "node:fs";
import path from "node:path";
import { runCommand } from "../../../shared/exec";
import type { ToolRunContext } from "../../../shared/types";
import type { PoolConfig } from "./config";
import { Cancelled } from "./svn";

export async function runBeforeUpdate(config: PoolConfig, ctx: ToolRunContext, wc: string): Promise<void> {
  const argv = config.hooks?.beforeUpdate;
  if (!argv) return;
  if (ctx.abortSignal.aborted) throw new Cancelled("已取消");
  if (!existsSync(path.join(wc, ".svn"))) throw new Error("项目钩子目标不是 SVN 工作副本根");
  ctx.onProgress?.(`执行项目更新前钩子（${path.basename(wc)}）`, null);
  const result = await runCommand({
    command: argv[0],
    args: [...argv.slice(1), "--project-root", wc],
    cwd: wc,
    logFile: ctx.logFile,
    timeoutMs: Math.min(ctx.timeoutMs, 10 * 60_000),
    abortSignal: ctx.abortSignal,
    gracefulMs: 6000,
    cancelStdin: '{"type":"cancel"}',
    onStdoutLine: (line) => {
      try {
        const frame = JSON.parse(line);
        if (frame.type === "progress" && typeof frame.message === "string") {
          ctx.onProgress?.(frame.message, typeof frame.percent === "number" ? frame.percent : null);
        }
      } catch { /* 普通输出原样进入日志。 */ }
    },
  }).done;
  if (ctx.abortSignal.aborted || (result.cancelled && !result.timedOut)) throw new Cancelled("项目钩子已取消");
  if (result.timedOut) throw new Error("项目更新前钩子超时；未执行 svn update");
  if (result.code !== 0) throw new Error(`项目更新前钩子失败（${result.code}）；未执行 svn update：${(result.stderr || result.stdout).trim().slice(-2000)}`);
}
