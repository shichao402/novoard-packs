import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

/** 不要求完整输出时，stdout/stderr 各自只留末尾这么多字符（够报错、看尾部日志）。 */
export const OUTPUT_TAIL_CHARS = 200_000;

export type ExecResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  cancelled: boolean;
  timedOut: boolean;
  /** stdout 超过 OUTPUT_TAIL_CHARS、只留了末尾（fullStdout 时恒为 false）。 */
  stdoutTruncated: boolean;
};

export type ExecHandle = {
  cancel: () => void;
  done: Promise<ExecResult>;
};

const STRIP_ENV = new Set(["VSCODE_NLS_CONFIG", "VSCODE_PID", "VSCODE_CWD", "VSCODE_NLS_CONFIG_JSON"]);

export function buildChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of STRIP_ENV) {
    delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  env.SVN_NON_INTERACTIVE = "1";
  return env;
}

export type SpawnCapturedResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  cancelled: boolean;
};

/**
 * 结束子进程。Windows 用 taskkill /T 结束整棵进程树（cronkit 原实现）；
 * 其他平台（能力包 versionControl 全平台、unity-warmup 含 darwin）发信号给子进程。
 */
function killTree(proc: ChildProcess, force: boolean): void {
  if (!proc.pid) {
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(proc.pid), "/T", ...(force ? ["/F"] : [])], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    proc.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // 进程已退出
  }
}

/**
 * Async spawn that does not block the event loop.
 * stdout/stderr 完整保留：调用方（ps、tasklist、占用查询）都要整份解析，截掉开头会漏条目或解析失败。
 */
export function spawnCaptured(options: {
  command: string;
  args: string[];
  timeoutMs: number;
  abortSignal?: AbortSignal;
  ignoreOutput?: boolean;
}): Promise<SpawnCapturedResult> {
  const { command, args, timeoutMs, abortSignal, ignoreOutput } = options;
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error("已取消"));
      return;
    }

    const out = new OutputBuffer(Infinity);
    const err = new OutputBuffer(Infinity);
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let timer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;

    const proc = spawn(command, args, {
      windowsHide: true,
      stdio: ignoreOutput ? "ignore" : ["ignore", "pipe", "pipe"],
    });

    const forceKill = (): void => killTree(proc, true);

    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (forceTimer) {
        clearTimeout(forceTimer);
      }
      abortSignal?.removeEventListener("abort", onAbort);
      if (cancelled && !timedOut) {
        reject(new Error("已取消"));
        return;
      }
      resolve({ stdout: out.text(), stderr: err.text(), code, timedOut, cancelled });
    };

    const onAbort = (): void => {
      cancelled = true;
      forceKill();
    };

    if (!ignoreOutput) {
      // setEncoding 内部用 StringDecoder，多字节字符跨 chunk 不会被拆坏
      proc.stdout?.setEncoding("utf8");
      proc.stderr?.setEncoding("utf8");
      proc.stdout?.on("data", (chunk: string) => out.push(chunk));
      proc.stderr?.on("data", (chunk: string) => err.push(chunk));
    }
    proc.on("error", () => finish(1));
    proc.on("close", (code) => finish(code));

    timer = setTimeout(() => {
      timedOut = true;
      cancelled = true;
      forceKill();
      forceTimer = setTimeout(() => {
        if (!settled) {
          finish(1);
        }
      }, 3_000);
    }, timeoutMs);

    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal?.aborted) {
      onAbort();
    }
  });
}

export function runCommand(options: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  logFile: string;
  abortSignal?: AbortSignal;
  lowPriority?: boolean;
  gracefulMs?: number;
  /** 可选的进程外协议取消行；不传时保持原有 stdin=ignore。 */
  cancelStdin?: string;
  env?: NodeJS.ProcessEnv;
  /** stdout 每个完整行回调一次（用于进度计数），末尾不完整行在进程结束时补发。 */
  onStdoutLine?: (line: string) => void;
  /**
   * 完整保留 stdout。要整份解析 stdout 的调用（xml、diff、列表）必须开；
   * 缺省只留末尾 OUTPUT_TAIL_CHARS 个字符，并在结果里标 stdoutTruncated。
   */
  fullStdout?: boolean;
}): ExecHandle {
  mkdirSync(path.dirname(options.logFile), { recursive: true });
  const log = createWriteStream(options.logFile, { flags: "a" });
  log.write(`$ ${options.command} ${options.args.join(" ")}\ncwd=${options.cwd}\n\n`);

  const out = new OutputBuffer(options.fullStdout ? Infinity : OUTPUT_TAIL_CHARS);
  const err = new OutputBuffer(OUTPUT_TAIL_CHARS);
  let cancelled = false;
  let timedOut = false;
  let proc: ChildProcess | undefined;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let forceTimer: NodeJS.Timeout | undefined;
  const gracefulMs = options.gracefulMs ?? 15_000;

  const forceKill = (): void => {
    if (proc) killTree(proc, true);
  };

  const softKill = (): void => {
    if (!proc?.pid) {
      return;
    }
    if (options.cancelStdin && proc.stdin?.writable) {
      proc.stdin.end(options.cancelStdin + "\n");
    }
    // Try graceful tree terminate first (no /F).
    killTree(proc, false);
    if (forceTimer) {
      clearTimeout(forceTimer);
    }
    forceTimer = setTimeout(() => {
      if (!settled) {
        log.write("\n[novoard-packs] graceful wait elapsed, force kill\n");
        forceKill();
      }
    }, gracefulMs);
  };

  const done = new Promise<ExecResult>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (forceTimer) {
        clearTimeout(forceTimer);
      }
      options.abortSignal?.removeEventListener("abort", onAbort);
      log.end();
      resolve({
        code,
        signal,
        stdout: out.text(),
        stderr: err.text(),
        cancelled,
        timedOut,
        stdoutTruncated: out.truncated,
      });
    };

    const onAbort = (): void => {
      cancelled = true;
      softKill();
    };

    const env = buildChildEnv(options.env ?? process.env);
    proc = spawn(options.command, options.args, {
      cwd: options.cwd,
      windowsHide: true,
      env,
      stdio: [options.cancelStdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    proc.stdin?.on("error", () => {});

    if (options.lowPriority && proc.pid) {
      spawn(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `try { (Get-Process -Id ${proc.pid}).PriorityClass = 'BelowNormal' } catch {}`,
        ],
        { windowsHide: true, stdio: "ignore" },
      );
    }

    let pendingLine = "";
    const emitLines = (text: string, flush: boolean): void => {
      if (!options.onStdoutLine) return;
      const parts = (pendingLine + text).split(/\r?\n/);
      pendingLine = flush ? "" : (parts.pop() ?? "");
      for (const line of parts) {
        if (line) options.onStdoutLine(line);
      }
    };

    // 逐 chunk toString 会把跨 chunk 的多字节字符（中文路径、diff 内容）拆成乱码，用 StringDecoder 接续
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    const onStdout = (text: string, flush: boolean): void => {
      out.push(text);
      emitLines(text, flush);
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      log.write(chunk);
      onStdout(outDecoder.write(chunk), false);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      log.write(chunk);
      err.push(errDecoder.write(chunk));
    });
    proc.on("error", (error) => {
      const message = `${error.message}\n`;
      err.push(message);
      log.write(message);
      finish(1, null);
    });
    proc.on("close", (code, signal) => {
      onStdout(outDecoder.end(), true);
      err.push(errDecoder.end());
      finish(code, signal);
    });

    timer = setTimeout(() => {
      timedOut = true;
      cancelled = true;
      softKill();
    }, options.timeoutMs);

    if (options.abortSignal?.aborted) {
      onAbort();
    } else {
      options.abortSignal?.addEventListener("abort", onAbort, { once: true });
    }
  });

  return {
    cancel: () => {
      cancelled = true;
      softKill();
    },
    done,
  };
}

/**
 * 子进程输出收集。limit=Infinity 时完整保留；否则只留末尾 limit 个字符并记 truncated。
 * 分块收集、超过两倍上限才压缩一次，避免每个 chunk 都把整串拼接一遍（大输出时是平方级）。
 */
class OutputBuffer {
  private chunks: string[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  push(text: string): void {
    if (!text) return;
    this.chunks.push(text);
    this.size += text.length;
    if (this.size > this.limit * 2) this.compact();
  }

  text(): string {
    this.compact();
    if (this.chunks.length > 1) this.chunks = [this.chunks.join("")];
    return this.chunks[0] ?? "";
  }

  private compact(): void {
    if (this.size <= this.limit) return;
    const joined = this.chunks.join("");
    const kept = joined.slice(joined.length - this.limit);
    this.chunks = [kept];
    this.size = kept.length;
    this.truncated = true;
  }
}
