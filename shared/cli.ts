/**
 * 能力包统一 CLI（ADR-0019 §2–5，PRD-7 P4）：
 *
 *   node dist/pack.mjs <tool> --project-root <p> [--dry-run] [--result-json <f>] [--<param-kebab> <value> ...]
 *
 * - argv 与 novoard-agent `paramsToArgv` 互逆：kebab 转 camelCase；布尔 `--flag` 为 true、`--flag=false` 为 false；
 *   数组每项重复一次 flag；number 按数字解析。解析后再走 validateToolParams。
 * - 退出码：0 成功；1 工具失败；64 参数错；99 意外错误（程序缺陷）；130 被中断。
 * - `--result-json`：`{ detail, skipped? }`，失败时 detail 为失败原因。
 * - 进度：stdout 输出 `{"type":"progress","message":...,"percent"?:N}` 行。
 * - SIGTERM/SIGINT：中止信号传给工具，由工具结束自己启动的子进程树，然后写结果文件并以 130 退出。
 * - 超时由 agent 的 runner 统一负责，这里只给工具一个兜底上限（24 小时）。
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { localDate } from "./time";
import type { ToolManifest, ToolRunContext, ToolRunResult, ToolsetManifest } from "./types";
import { validateToolParams } from "./validate";

export const EXIT = { OK: 0, FAIL: 1, USAGE: 64, UNEXPECTED: 99, INTERRUPTED: 130 } as const;

/** 兜底上限；setTimeout 超过 2^31-1 毫秒会立即触发，所以不能用 Infinity。 */
export const FALLBACK_TIMEOUT_MS = 24 * 60 * 60_000;

export class UsageError extends Error {}

export type ParsedArgv = {
  tool: ToolManifest;
  projectRoot: string;
  dryRun: boolean;
  resultJson?: string;
  params: Record<string, unknown>;
};

type RunFn = (toolId: string, params: Record<string, unknown> | undefined, ctx: ToolRunContext) => Promise<ToolRunResult>;

function usage(manifest: ToolsetManifest): string {
  const ids = manifest.tools.map((t) => t.id).join(" | ");
  return `用法：node dist/pack.mjs <${ids}> --project-root <目录> [--dry-run] [--result-json <文件>] [--<参数> <值> ...]`;
}

function kebabToCamel(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** 解析 argv；参数不合法时抛 UsageError。 */
export function parseArgv(manifest: ToolsetManifest, argv: string[]): ParsedArgv {
  const toolId = argv[0];
  if (!toolId || toolId.startsWith("-")) {
    throw new UsageError(`缺少工具名。${usage(manifest)}`);
  }
  const tool = manifest.tools.find((t) => t.id === toolId);
  if (!tool) {
    throw new UsageError(`${manifest.id} 没有工具 ${toolId}。${usage(manifest)}`);
  }
  const specs = new Map((tool.params ?? []).map((s) => [s.name, s]));
  const params: Record<string, unknown> = {};
  let projectRoot: string | undefined;
  let resultJson: string | undefined;
  let dryRun = false;

  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new UsageError(`多余的位置参数：${token}`);
    }
    const eq = token.indexOf("=");
    const name = token.slice(2, eq >= 0 ? eq : undefined);
    const inline = eq >= 0 ? token.slice(eq + 1) : undefined;
    const takeValue = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`--${name} 需要一个值`);
      }
      i += 1;
      return next;
    };
    const parseBool = (): boolean => {
      if (inline === undefined || inline === "true") return true;
      if (inline === "false") return false;
      throw new UsageError(`--${name} 只能是 --${name} 或 --${name}=false`);
    };

    if (name === "project-root") {
      projectRoot = takeValue();
      continue;
    }
    if (name === "result-json") {
      resultJson = takeValue();
      continue;
    }
    if (name === "dry-run") {
      dryRun = parseBool();
      continue;
    }
    const key = kebabToCamel(name);
    const spec = specs.get(key);
    if (!spec) {
      throw new UsageError(`${tool.id} 没有参数 --${name}`);
    }
    switch (spec.type) {
      case "boolean":
        params[key] = parseBool();
        break;
      case "number": {
        const raw = takeValue();
        const value = Number(raw);
        if (raw.trim() === "" || Number.isNaN(value)) {
          throw new UsageError(`--${name} 应为数字：${raw}`);
        }
        params[key] = value;
        break;
      }
      case "string[]": {
        const list = (params[key] as string[] | undefined) ?? [];
        list.push(takeValue());
        params[key] = list;
        break;
      }
      default:
        params[key] = takeValue();
    }
  }

  if (!projectRoot) {
    throw new UsageError(`缺少 --project-root。${usage(manifest)}`);
  }
  const { errors } = validateToolParams(tool, params);
  if (errors.length > 0) {
    throw new UsageError(errors.join("; "));
  }
  return { tool, projectRoot: path.resolve(projectRoot), dryRun, resultJson, params };
}

/** 参数解析失败时也尽量把原因写进结果文件。 */
function peekResultJson(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--result-json") return argv[i + 1];
    if (argv[i].startsWith("--result-json=")) return argv[i].slice("--result-json=".length);
  }
  return undefined;
}

function writeResult(file: string | undefined, value: { detail: string; skipped?: boolean }): void {
  if (!file) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
  } catch {
    // 结果文件写不了不影响退出码；agent 会退回 stdout/stderr
  }
}

function isUnexpected(error: unknown): boolean {
  return error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError || error instanceof SyntaxError;
}

export type CliIo = {
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** 订阅中断信号的对象，默认 process；测试传 EventEmitter。 */
  signals?: { on: (event: string, fn: () => void) => unknown; off: (event: string, fn: () => void) => unknown } | null;
  logDir?: string;
  timeoutMs?: number;
  now?: () => Date;
};

export async function runCli(manifest: ToolsetManifest, run: RunFn, argv: string[], io: CliIo = {}): Promise<number> {
  const out = io.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = io.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const signals = io.signals === undefined ? process : io.signals;
  const now = io.now ?? (() => new Date());

  let parsed: ParsedArgv;
  try {
    parsed = parseArgv(manifest, argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeResult(peekResultJson(argv), { detail: message });
    err(message);
    return error instanceof UsageError ? EXIT.USAGE : EXIT.UNEXPECTED;
  }

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  signals?.on("SIGTERM", onSignal);
  signals?.on("SIGINT", onSignal);

  const stamp = now().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  const logFile = path.join(io.logDir ?? path.join(os.tmpdir(), "novoard-packs"), `${manifest.id}-${parsed.tool.id}-${stamp}-${process.pid}.log`);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ctx: ToolRunContext = {
    cwd: parsed.projectRoot,
    workspacePath: parsed.projectRoot,
    timeoutMs: io.timeoutMs ?? FALLBACK_TIMEOUT_MS,
    logFile,
    abortSignal: controller.signal,
    dryRun: parsed.dryRun,
    resultJsonPath: parsed.resultJson,
    localDate: localDate(timezone, now()),
    onProgress: (message, percent) => {
      const frame: Record<string, unknown> = { type: "progress", message };
      if (typeof percent === "number" && Number.isFinite(percent)) frame.percent = Math.max(0, Math.min(100, percent));
      out(JSON.stringify(frame));
    },
  };

  try {
    if (!parsed.dryRun) out(`日志：${logFile}`);
    const result = await run(parsed.tool.id, parsed.params, ctx);
    if (controller.signal.aborted) {
      writeResult(parsed.resultJson, { detail: "已取消" });
      err("已取消");
      return EXIT.INTERRUPTED;
    }
    if (result.code !== 0) {
      const detail = result.detail || `${parsed.tool.displayName} 退出码 ${result.code}`;
      writeResult(parsed.resultJson, { detail });
      err(detail);
      return EXIT.FAIL;
    }
    writeResult(parsed.resultJson, { detail: result.detail, ...(result.skipped ? { skipped: true } : {}) });
    out(result.detail);
    return EXIT.OK;
  } catch (error) {
    if (controller.signal.aborted) {
      writeResult(parsed.resultJson, { detail: "已取消" });
      err("已取消");
      return EXIT.INTERRUPTED;
    }
    const message = error instanceof Error ? error.message : String(error);
    writeResult(parsed.resultJson, { detail: message });
    if (isUnexpected(error)) {
      err(error instanceof Error && error.stack ? error.stack : message);
      return EXIT.UNEXPECTED;
    }
    err(message);
    return EXIT.FAIL;
  } finally {
    signals?.off("SIGTERM", onSignal);
    signals?.off("SIGINT", onSignal);
  }
}

/** 当前模块是否作为 `node dist/pack.mjs` 直接运行（被 import 时为 false）。 */
export function isCliEntry(moduleUrl: string): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/** 包入口调用：跑完 CLI 后等 stdout 刷完再退出，避免残留句柄让进程挂住。 */
export async function main(manifest: ToolsetManifest, run: RunFn): Promise<void> {
  const code = await runCli(manifest, run, process.argv.slice(2));
  process.stdout.write("", () => process.exit(code));
}
