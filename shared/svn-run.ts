/**
 * svn 子进程的公共约定：中断后的限时 cleanup、软杀宽限。
 * versionControl 与 workingCopyPool 共用（原在 packs/versionControl/src/svn.ts）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { runCommand } from "./exec";

/** 会写工作副本（.svn/wc.db）的子命令；被中途结束会留下 in-progress 锁。 */
export const SVN_WC_WRITE = new Set(["update", "up", "revert", "commit", "ci", "switch", "sw", "merge", "checkout", "co", "add", "delete", "rm", "copy", "cp", "move", "mv", "resolve"]);
/** 中断后 cleanup 的上限：agent 对 uses 步骤的宽限期是 10 秒（ADR-0019 §5），要在它强杀之前跑完。 */
export const INTERRUPT_CLEANUP_MS = 6_000;
/** svn 的软杀宽限：Windows 上不带 /F 的 taskkill 对 svn 无效，等久了只会挤掉 cleanup 的时间。 */
export const SVN_GRACEFUL_MS = 1_000;

export function appendLog(logFile: string, line: string): void {
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${line}\n`, "utf8");
  } catch {
    // 日志写不了不影响工具
  }
}

/**
 * svn 写工作副本的命令被取消或超时后，补跑一次 `svn cleanup` 解除 in-progress 锁。
 * 不带 abortSignal（此时已经中止），失败只记日志，返回附加说明。
 * `update --set-depth` 之类第一个参数仍是写命令，按写命令处理。
 */
export async function cleanupAfterInterrupt(
  args: string[],
  options: { cwd: string; logFile: string },
): Promise<string> {
  if (!SVN_WC_WRITE.has(args[0] ?? "")) return "";
  const result = await runCommand({
    command: "svn",
    args: ["cleanup", "--non-interactive"],
    cwd: options.cwd,
    timeoutMs: INTERRUPT_CLEANUP_MS,
    logFile: options.logFile,
    gracefulMs: SVN_GRACEFUL_MS,
  }).done;
  const ok = !result.cancelled && result.code === 0;
  appendLog(options.logFile, `[novoard-packs] 中断后 svn cleanup ${ok ? "完成" : `失败 code=${result.code} timedOut=${result.timedOut}`}`);
  return ok ? "（已 svn cleanup）" : "（svn cleanup 未完成，下次运行前需手动 cleanup）";
}

export function tailLines(text: string, count = 8): string {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-count).join("\n");
}
