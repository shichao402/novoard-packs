/**
 * workingCopyPool 入口：参数校验、dry-run、按工具分发。规格见 docs/prd/working-copy-pool.md。
 * 所有工具的 cwd 都是池根；取消由 shared/cli 按 ADR-0019 §5 处理（130 退出）。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { isCliEntry, main, UsageError } from "../../../shared/cli";
import type { ToolRunContext, ToolRunResult } from "../../../shared/types";
import { validateToolParams } from "../../../shared/validate";
import { branchUrl, CONFIG_FILE, isBranchName, isTtl, loadConfig, type PoolConfig } from "./config";
import { manifest } from "./manifest";
import { acquireSummary, gc, obtain, openPool, poolView, recover, refresh, releaseBranch, resolveLease } from "./pool";
import { candidates, occupied, peekPool, status } from "./queries";
import { readState } from "./state";
import { captureSpec, describeSparse, formatSpecToml } from "./sparse";
import { readDirDepths, svnInfo } from "./svn";

export { manifest };

const byId = new Map(manifest.tools.map((t) => [t.id, t]));

export async function run(toolId: string, rawParams: Record<string, unknown> | undefined, ctx: ToolRunContext): Promise<ToolRunResult> {
  const tool = byId.get(toolId);
  if (!tool) throw new UsageError(`workingCopyPool 没有工具: ${toolId}`);
  const { params, errors } = validateToolParams(tool, rawParams);
  if (errors.length > 0) throw new UsageError(errors.join("; "));
  if (typeof params.branch === "string" && !isBranchName(params.branch)) throw new UsageError(`分支名不合法：${params.branch}`);
  if (typeof params.ttl === "string" && params.ttl.trim() && params.ttl.trim() !== "forever" && !isTtl(params.ttl.trim())) {
    throw new UsageError(`ttl 不合法：${params.ttl}（如 12h、1d、3d、1w 或 forever）`);
  }
  if (ctx.dryRun) return { detail: dryRun(tool.displayName, toolId, params, ctx), code: 0 };

  switch (toolId) {
    case "candidates": {
      const result = await candidates(peekPool(ctx));
      return { detail: result.detail, code: 0, choices: result.choices };
    }
    case "occupied": {
      const result = occupied(peekPool(ctx));
      return { detail: result.detail, code: 0, choices: result.choices };
    }
    case "status": {
      const result = await status(peekPool(ctx));
      return { detail: result.detail, code: 0, summary: result.summary, pool: result.pool };
    }
    case "acquire":
      return runAcquire(params, ctx);
    case "release": {
      const pool = openPool(ctx);
      const result = await releaseBranch(pool, String(params.branch));
      return { detail: result.detail, code: 0, skipped: !result.released, summary: result.detail };
    }
    case "gc":
      return runGc(ctx);
    case "refresh":
      return runRefresh(ctx);
    case "capture-sparse":
      return runCaptureSparse(params, ctx);
    default:
      throw new UsageError(`未实现工具: ${toolId}`);
  }
}

async function runAcquire(params: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolRunResult> {
  const pool = openPool(ctx);
  const recovered = await recover(pool);
  const branch = String(params.branch);
  const lease = resolveLease(pool, params.ttl, params.tag);
  const outcome = await obtain(pool, branch, lease);
  const summary = acquireSummary(outcome);
  const view = poolView(pool, readState(pool.paths));
  const entry = view.slots.find((s) => s.id === outcome.slot)?.link ?? "";
  const lines = [summary, `入口：${entry}`];
  if (outcome.notes.length) lines.push(...outcome.notes);
  if (recovered.length) lines.push(`中断恢复：${recovered.join("；")}`);
  return { detail: lines.join("\n"), code: 0, summary, pool: view };
}

async function runGc(ctx: ToolRunContext): Promise<ToolRunResult> {
  const pool = openPool(ctx);
  const report = await gc(pool);
  const lines: string[] = [];
  const section = (title: string, items: string[]): void => {
    if (items.length) lines.push(`${title}：`, ...items.map((s) => `  ${s}`));
  };
  section("中断恢复", report.recovered);
  section("解除阻塞", report.unblocked);
  section("仍阻塞", report.blocked);
  section("已回收", report.retired);
  section("待缩容", report.pendingShrink);
  section("入口", report.links);
  section("失败", report.errors);
  if (report.patches) lines.push(`删除过期存档 ${report.patches} 个`);
  const summary = `回收 ${report.retired.length}，阻塞 ${report.blocked.length}，待缩容 ${report.pendingShrink.length ? "有" : "无"}${report.errors.length ? `，失败 ${report.errors.length}` : ""}`;
  return { detail: [summary, ...lines].join("\n"), code: report.errors.length ? 1 : 0, summary };
}

async function runRefresh(ctx: ToolRunContext): Promise<ToolRunResult> {
  const pool = openPool(ctx);
  if (pool.config.resident.length === 0) {
    const recovered = await recover(pool);
    return { detail: `pool.toml 没有常驻分支${recovered.length ? `；中断恢复：${recovered.join("；")}` : ""}`, code: 0, skipped: true };
  }
  const result = await refresh(pool);
  const failed = result.items.filter((i) => !i.ok);
  const lines = result.items.map((i) => `${i.ok ? (i.skipped ? "-" : "✓") : "✗"} ${i.branch}：${i.detail}`);
  if (result.recovered.length) lines.push(`中断恢复：${result.recovered.join("；")}`);
  const summary = `常驻 ${result.items.length} 个：成功 ${result.items.filter((i) => i.ok && !i.skipped).length}，跳过 ${result.items.filter((i) => i.skipped).length}，失败 ${failed.length}`;
  return { detail: [summary, ...lines].join("\n"), code: failed.length ? 1 : 0, summary };
}

/**
 * 从现有工作副本导出最小稀疏配置：读各目录实际 depth，只保留跟继承结果不一致的条目。
 * 只读，不需要 pool.toml；相对路径按 cwd 解析。
 */
async function runCaptureSparse(params: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolRunResult> {
  const wc = path.resolve(ctx.cwd, String(params.path));
  const sctx = { cwd: ctx.cwd, timeoutMs: ctx.timeoutMs, logFile: ctx.logFile, abortSignal: ctx.abortSignal, onProgress: ctx.onProgress };
  const info = await svnInfo(sctx, wc);
  if (!info) throw new UsageError(`不是 svn 工作副本：${wc}`);
  ctx.onProgress?.("读取目录 depth");
  const dirs = await readDirDepths(sctx, wc);
  const spec = captureSpec(dirs);
  const count = Object.keys(spec.paths).length;
  const summary = `导出 ${count} 条稀疏规则（根目录 ${spec.root}，共 ${dirs.length} 个目录）`;
  return { detail: [summary, `工作副本：${wc}`, "", formatSpecToml(spec).trimEnd()].join("\n"), code: 0, summary };
}

// ---------------------------------------------------------------- dry-run

/**
 * dry-run 不建池目录、不访问 svn：没有 pool.toml 只回显参数；有就描述计划。
 * PRD「风险」：排除规则写错会下载大量资源，所以打印将要排除和展开的目录。
 */
function dryRun(displayName: string, toolId: string, params: Record<string, unknown>, ctx: ToolRunContext): string {
  const head = `dry-run: ${displayName} ${JSON.stringify(params)}`;
  if (toolId === "capture-sparse") return `${head}\n读取 ${path.resolve(ctx.cwd, String(params.path))} 各目录的 depth，导出 [sparse] 配置；只读`;
  const root = path.resolve(ctx.cwd);
  if (!existsSync(path.join(root, CONFIG_FILE))) return head;
  const config = loadConfig(root);
  const lines = [head, `池根 ${root}，最多 ${config.maxSlots} 个槽位`];
  if (toolId === "acquire") {
    lines.push(`分支 URL：${branchUrl(config, String(params.branch))}`);
    lines.push(`保留：${typeof params.ttl === "string" && params.ttl ? params.ttl : config.defaultTtl}${params.tag ? `，标签 ${params.tag}` : ""}`);
    lines.push(...sparsePlan(config));
  } else if (toolId === "refresh") {
    lines.push(config.resident.length ? `常驻分支：${config.resident.join("、")}` : "没有常驻分支");
    lines.push(...sparsePlan(config));
  } else if (toolId === "gc") {
    lines.push(`超过 ${config.maxSlots} 个槽位时回收空闲槽位；删除 ${config.patchRetentionDays} 天前的存档`);
  }
  return lines.join("\n");
}

export function sparsePlan(config: PoolConfig): string[] {
  return describeSparse(config.sparse);
}

if (isCliEntry(import.meta.url)) {
  await main(manifest, run);
}
