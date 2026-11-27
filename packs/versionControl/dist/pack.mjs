// packs/versionControl/src/index.ts
import path10 from "node:path";

// shared/cli.ts
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// shared/time.ts
function localDate(timezone, at = /* @__PURE__ */ new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(at);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

// shared/validate.ts
function validateToolParams(tool, raw, rawArgs) {
  const errors = [];
  const input = { ...raw ?? {} };
  const specs = tool.params ?? [];
  const known = new Set(specs.map((s) => s.name));
  if (rawArgs && rawArgs.length > 0 && !tool.allowRawArgs) {
    errors.push(`\u5DE5\u5177 ${tool.id} \u4E0D\u5141\u8BB8 raw args`);
  }
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      errors.push(`\u672A\u77E5\u53C2\u6570: ${key}`);
    }
  }
  const params = {};
  for (const spec of specs) {
    const has = Object.prototype.hasOwnProperty.call(input, spec.name);
    let value = has ? input[spec.name] : spec.default;
    if (value === void 0 || value === null) {
      if (spec.required) {
        errors.push(`\u7F3A\u5C11\u5FC5\u586B\u53C2\u6570: ${spec.name}`);
      }
      continue;
    }
    const coerced = coerceParam(spec, value);
    if (coerced.error) {
      errors.push(coerced.error);
      continue;
    }
    params[spec.name] = coerced.value;
  }
  return { params, errors };
}
function coerceParam(spec, value) {
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") {
        return { error: `${spec.name} \u5E94\u4E3A string` };
      }
      return { value };
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) {
        return { error: `${spec.name} \u5E94\u4E3A number` };
      }
      return { value };
    case "boolean":
      if (typeof value !== "boolean") {
        return { error: `${spec.name} \u5E94\u4E3A boolean` };
      }
      return { value };
    case "string[]":
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        return { error: `${spec.name} \u5E94\u4E3A string[]` };
      }
      return { value };
    case "enum": {
      if (typeof value !== "string") {
        return { error: `${spec.name} \u5E94\u4E3A\u679A\u4E3E\u5B57\u7B26\u4E32` };
      }
      if (spec.enum && !spec.enum.includes(value)) {
        return { error: `${spec.name} \u5FC5\u987B\u662F ${spec.enum.join("|")}` };
      }
      return { value };
    }
    default:
      return { error: `${spec.name} \u672A\u77E5\u7C7B\u578B` };
  }
}

// shared/cli.ts
var EXIT = { OK: 0, FAIL: 1, USAGE: 64, UNEXPECTED: 99, INTERRUPTED: 130 };
var FALLBACK_TIMEOUT_MS = 24 * 60 * 6e4;
var UsageError = class extends Error {
};
function usage(manifest2) {
  const ids = manifest2.tools.map((t) => t.id).join(" | ");
  return `\u7528\u6CD5\uFF1Anode dist/pack.mjs <${ids}> --project-root <\u76EE\u5F55> [--dry-run] [--result-json <\u6587\u4EF6>] [--<\u53C2\u6570> <\u503C> ...]`;
}
function kebabToCamel(name) {
  return name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}
function parseArgv(manifest2, argv) {
  const toolId = argv[0];
  if (!toolId || toolId.startsWith("-")) {
    throw new UsageError(`\u7F3A\u5C11\u5DE5\u5177\u540D\u3002${usage(manifest2)}`);
  }
  const tool = manifest2.tools.find((t) => t.id === toolId);
  if (!tool) {
    throw new UsageError(`${manifest2.id} \u6CA1\u6709\u5DE5\u5177 ${toolId}\u3002${usage(manifest2)}`);
  }
  const specs = new Map((tool.params ?? []).map((s) => [s.name, s]));
  const params = {};
  let projectRoot;
  let resultJson;
  let dryRun = false;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new UsageError(`\u591A\u4F59\u7684\u4F4D\u7F6E\u53C2\u6570\uFF1A${token}`);
    }
    const eq = token.indexOf("=");
    const name = token.slice(2, eq >= 0 ? eq : void 0);
    const inline = eq >= 0 ? token.slice(eq + 1) : void 0;
    const takeValue = () => {
      if (inline !== void 0) return inline;
      const next = argv[i + 1];
      if (next === void 0 || next.startsWith("--")) {
        throw new UsageError(`--${name} \u9700\u8981\u4E00\u4E2A\u503C`);
      }
      i += 1;
      return next;
    };
    const parseBool = () => {
      if (inline === void 0 || inline === "true") return true;
      if (inline === "false") return false;
      throw new UsageError(`--${name} \u53EA\u80FD\u662F --${name} \u6216 --${name}=false`);
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
      throw new UsageError(`${tool.id} \u6CA1\u6709\u53C2\u6570 --${name}`);
    }
    switch (spec.type) {
      case "boolean":
        params[key] = parseBool();
        break;
      case "number": {
        const raw = takeValue();
        const value = Number(raw);
        if (raw.trim() === "" || Number.isNaN(value)) {
          throw new UsageError(`--${name} \u5E94\u4E3A\u6570\u5B57\uFF1A${raw}`);
        }
        params[key] = value;
        break;
      }
      case "string[]": {
        const list = params[key] ?? [];
        list.push(takeValue());
        params[key] = list;
        break;
      }
      default:
        params[key] = takeValue();
    }
  }
  if (!projectRoot) {
    throw new UsageError(`\u7F3A\u5C11 --project-root\u3002${usage(manifest2)}`);
  }
  const { errors } = validateToolParams(tool, params);
  if (errors.length > 0) {
    throw new UsageError(errors.join("; "));
  }
  return { tool, projectRoot: path.resolve(projectRoot), dryRun, resultJson, params };
}
function peekResultJson(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--result-json") return argv[i + 1];
    if (argv[i].startsWith("--result-json=")) return argv[i].slice("--result-json=".length);
  }
  return void 0;
}
function extras(result) {
  const out = {};
  if (result.choices !== void 0) out.choices = result.choices;
  if (result.summary !== void 0) out.summary = result.summary;
  if (result.pool !== void 0) out.pool = result.pool;
  return out;
}
function writeResult(file, value) {
  if (!file) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value)}
`, "utf8");
  } catch {
  }
}
function isUnexpected(error) {
  return error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError || error instanceof SyntaxError;
}
async function runCli(manifest2, run2, argv, io = {}) {
  const out = io.out ?? ((line) => process.stdout.write(`${line}
`));
  const err = io.err ?? ((line) => process.stderr.write(`${line}
`));
  const signals = io.signals === void 0 ? process : io.signals;
  const now = io.now ?? (() => /* @__PURE__ */ new Date());
  let parsed;
  try {
    parsed = parseArgv(manifest2, argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeResult(peekResultJson(argv), { detail: message });
    err(message);
    return error instanceof UsageError ? EXIT.USAGE : EXIT.UNEXPECTED;
  }
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  signals?.on("SIGTERM", onSignal);
  signals?.on("SIGINT", onSignal);
  const stopStdin = io.stdin ? watchCancelLine(io.stdin, onSignal) : () => {
  };
  const stamp = now().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  const logFile = path.join(io.logDir ?? path.join(os.tmpdir(), "novoard-packs"), `${manifest2.id}-${parsed.tool.id}-${stamp}-${process.pid}.log`);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ctx = {
    cwd: parsed.projectRoot,
    workspacePath: parsed.projectRoot,
    timeoutMs: io.timeoutMs ?? FALLBACK_TIMEOUT_MS,
    logFile,
    abortSignal: controller.signal,
    dryRun: parsed.dryRun,
    resultJsonPath: parsed.resultJson,
    localDate: localDate(timezone, now()),
    onProgress: (message, percent) => {
      const frame = { type: "progress", message };
      if (typeof percent === "number" && Number.isFinite(percent)) frame.percent = Math.max(0, Math.min(100, percent));
      out(JSON.stringify(frame));
    }
  };
  try {
    if (!parsed.dryRun) out(`\u65E5\u5FD7\uFF1A${logFile}`);
    const result = await run2(parsed.tool.id, parsed.params, ctx);
    if (controller.signal.aborted) {
      writeResult(parsed.resultJson, { detail: "\u5DF2\u53D6\u6D88" });
      err("\u5DF2\u53D6\u6D88");
      return EXIT.INTERRUPTED;
    }
    if (result.code !== 0) {
      const detail = result.detail || `${parsed.tool.displayName} \u9000\u51FA\u7801 ${result.code}`;
      writeResult(parsed.resultJson, { detail, ...extras(result) });
      err(detail);
      return EXIT.FAIL;
    }
    writeResult(parsed.resultJson, { detail: result.detail, ...result.skipped ? { skipped: true } : {}, ...extras(result) });
    out(result.detail);
    return EXIT.OK;
  } catch (error) {
    if (controller.signal.aborted) {
      writeResult(parsed.resultJson, { detail: "\u5DF2\u53D6\u6D88" });
      err("\u5DF2\u53D6\u6D88");
      return EXIT.INTERRUPTED;
    }
    const message = error instanceof Error ? error.message : String(error);
    writeResult(parsed.resultJson, { detail: message });
    if (error instanceof UsageError) {
      err(message);
      return EXIT.USAGE;
    }
    if (isUnexpected(error)) {
      err(error instanceof Error && error.stack ? error.stack : message);
      return EXIT.UNEXPECTED;
    }
    err(message);
    return EXIT.FAIL;
  } finally {
    signals?.off("SIGTERM", onSignal);
    signals?.off("SIGINT", onSignal);
    stopStdin();
  }
}
function isCancelLine(line) {
  const text = line.trim();
  if (!text.startsWith("{")) return false;
  try {
    const value = JSON.parse(text);
    return value?.type === "cancel";
  } catch {
    return false;
  }
}
function watchCancelLine(input, onCancel) {
  let buf = "";
  const onData = (chunk) => {
    buf += String(chunk);
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (isCancelLine(line)) onCancel();
    }
    if (buf.length > 4096) buf = buf.slice(-4096);
  };
  const onEnd = () => {
    if (isCancelLine(buf)) onCancel();
    buf = "";
  };
  input.on("data", onData);
  input.on("end", onEnd);
  input.on("error", () => {
  });
  return () => {
    input.off("data", onData);
    input.off("end", onEnd);
    input.pause();
  };
}
function isCliEntry(moduleUrl) {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
async function main(manifest2, run2) {
  const code = await runCli(manifest2, run2, process.argv.slice(2), { stdin: process.stdin.isTTY ? null : process.stdin });
  process.stdout.write("", () => process.exit(code));
}

// shared/exec.ts
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync as mkdirSync2 } from "node:fs";
import path2 from "node:path";
import { StringDecoder } from "node:string_decoder";
var OUTPUT_TAIL_CHARS = 2e5;
var STRIP_ENV = /* @__PURE__ */ new Set(["VSCODE_NLS_CONFIG", "VSCODE_PID", "VSCODE_CWD", "VSCODE_NLS_CONFIG_JSON"]);
function buildChildEnv(base = process.env) {
  const env = { ...base };
  for (const key of STRIP_ENV) {
    delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  env.SVN_NON_INTERACTIVE = "1";
  return env;
}
function killTree(proc, force) {
  if (!proc.pid) {
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(proc.pid), "/T", ...force ? ["/F"] : []], {
      windowsHide: true,
      stdio: "ignore"
    });
    return;
  }
  try {
    proc.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
  }
}
function spawnCaptured(options) {
  const { command, args, timeoutMs, abortSignal, ignoreOutput } = options;
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error("\u5DF2\u53D6\u6D88"));
      return;
    }
    const out = new OutputBuffer(Infinity);
    const err = new OutputBuffer(Infinity);
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let timer;
    let forceTimer;
    const proc = spawn(command, args, {
      windowsHide: true,
      stdio: ignoreOutput ? "ignore" : ["ignore", "pipe", "pipe"]
    });
    const forceKill = () => killTree(proc, true);
    const finish = (code) => {
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
        reject(new Error("\u5DF2\u53D6\u6D88"));
        return;
      }
      resolve({ stdout: out.text(), stderr: err.text(), code, timedOut, cancelled });
    };
    const onAbort = () => {
      cancelled = true;
      forceKill();
    };
    if (!ignoreOutput) {
      proc.stdout?.setEncoding("utf8");
      proc.stderr?.setEncoding("utf8");
      proc.stdout?.on("data", (chunk) => out.push(chunk));
      proc.stderr?.on("data", (chunk) => err.push(chunk));
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
      }, 3e3);
    }, timeoutMs);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal?.aborted) {
      onAbort();
    }
  });
}
function runCommand(options) {
  mkdirSync2(path2.dirname(options.logFile), { recursive: true });
  const log = createWriteStream(options.logFile, { flags: "a" });
  log.write(`$ ${options.command} ${options.args.join(" ")}
cwd=${options.cwd}

`);
  const out = new OutputBuffer(options.fullStdout ? Infinity : OUTPUT_TAIL_CHARS);
  const err = new OutputBuffer(OUTPUT_TAIL_CHARS);
  let cancelled = false;
  let timedOut = false;
  let proc;
  let settled = false;
  let timer;
  let forceTimer;
  const gracefulMs = options.gracefulMs ?? 15e3;
  const forceKill = () => {
    if (proc) killTree(proc, true);
  };
  const softKill = () => {
    if (!proc?.pid) {
      return;
    }
    if (options.cancelStdin && proc.stdin?.writable) {
      proc.stdin.end(options.cancelStdin + "\n");
    }
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
  const done = new Promise((resolve) => {
    const finish = (code, signal) => {
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
        stdoutTruncated: out.truncated
      });
    };
    const onAbort = () => {
      cancelled = true;
      softKill();
    };
    const env = buildChildEnv(options.env ?? process.env);
    proc = spawn(options.command, options.args, {
      cwd: options.cwd,
      windowsHide: true,
      env,
      stdio: [options.cancelStdin ? "pipe" : "ignore", "pipe", "pipe"]
    });
    proc.stdin?.on("error", () => {
    });
    if (options.lowPriority && proc.pid) {
      spawn(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `try { (Get-Process -Id ${proc.pid}).PriorityClass = 'BelowNormal' } catch {}`
        ],
        { windowsHide: true, stdio: "ignore" }
      );
    }
    let pendingLine = "";
    const emitLines = (text, flush) => {
      if (!options.onStdoutLine) return;
      const parts = (pendingLine + text).split(/\r?\n/);
      pendingLine = flush ? "" : parts.pop() ?? "";
      for (const line of parts) {
        if (line) options.onStdoutLine(line);
      }
    };
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    const onStdout = (text, flush) => {
      out.push(text);
      emitLines(text, flush);
    };
    proc.stdout?.on("data", (chunk) => {
      log.write(chunk);
      onStdout(outDecoder.write(chunk), false);
    });
    proc.stderr?.on("data", (chunk) => {
      log.write(chunk);
      err.push(errDecoder.write(chunk));
    });
    proc.on("error", (error) => {
      const message = `${error.message}
`;
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
    done
  };
}
var OutputBuffer = class {
  constructor(limit) {
    this.limit = limit;
  }
  chunks = [];
  size = 0;
  truncated = false;
  push(text) {
    if (!text) return;
    this.chunks.push(text);
    this.size += text.length;
    if (this.size > this.limit * 2) this.compact();
  }
  text() {
    this.compact();
    if (this.chunks.length > 1) this.chunks = [this.chunks.join("")];
    return this.chunks[0] ?? "";
  }
  compact() {
    if (this.size <= this.limit) return;
    const joined = this.chunks.join("");
    const kept = joined.slice(joined.length - this.limit);
    this.chunks = [kept];
    this.size = kept.length;
    this.truncated = true;
  }
};

// packs/versionControl/src/git.ts
import { existsSync } from "node:fs";
import path3 from "node:path";
var GIT_TOOLS = [
  {
    id: "git-status",
    displayName: "Git Status",
    description: "\u67E5\u770B\u5DE5\u4F5C\u533A\u4E0E\u5206\u652F\u72B6\u6001",
    idempotent: true,
    supportsDryRun: true,
    params: []
  },
  {
    id: "git-fetch",
    displayName: "Git Fetch",
    description: "\u62C9\u53D6\u8FDC\u7AEF\u5F15\u7528\uFF0C\u4E0D\u5408\u5E76",
    idempotent: true,
    supportsDryRun: true,
    params: [
      { name: "remote", type: "string", label: "\u8FDC\u7AEF", description: "\u8FDC\u7AEF\u540D\uFF1B\u7559\u7A7A\u5219 --all" },
      { name: "prune", type: "boolean", default: true, label: "\u6E05\u7406\u5931\u6548\u5206\u652F", description: "\u5220\u9664\u8FDC\u7AEF\u5DF2\u4E0D\u5B58\u5728\u7684\u8DDF\u8E2A\u5206\u652F" }
    ]
  },
  {
    id: "git-pull",
    displayName: "Git Pull",
    description: "\u62C9\u53D6\u5E76\u66F4\u65B0\u5F53\u524D\u5206\u652F\uFF08\u5BF9\u5E94 SVN \u66F4\u65B0\uFF09",
    idempotent: true,
    requiresExclusiveWorkspace: true,
    supportsDryRun: true,
    params: [
      {
        name: "strategy",
        type: "enum",
        enum: ["follow-latest", "manual", "disabled"],
        default: "follow-latest",
        required: true,
        label: "\u66F4\u65B0\u7B56\u7565",
        description: "follow-latest \u6BCF\u6B21\u62C9\u53D6\uFF1Bmanual \u4EC5\u624B\u52A8\u89E6\u53D1\uFF1Bdisabled \u8DF3\u8FC7"
      },
      { name: "remote", type: "string", label: "\u8FDC\u7AEF", description: "\u8FDC\u7AEF\u540D\uFF0C\u9ED8\u8BA4 origin\uFF08\u6307\u5B9A branch \u65F6\uFF09" },
      { name: "branch", type: "string", label: "\u5206\u652F", description: "\u5206\u652F\u540D\uFF1B\u7559\u7A7A\u5219\u62C9\u5F53\u524D\u5206\u652F\u7684\u4E0A\u6E38" },
      { name: "ffOnly", type: "boolean", default: true, label: "\u4EC5\u5FEB\u8FDB", description: "\u4EC5\u5FEB\u8FDB\uFF0C\u907F\u514D\u81EA\u52A8\u5408\u5E76\u63D0\u4EA4" },
      { name: "rebase", type: "boolean", default: false, label: "\u7528 rebase \u5408\u5E76" }
    ]
  },
  {
    id: "git-checkout",
    displayName: "Git Checkout",
    description: "\u5207\u6362\u5206\u652F\u6216\u68C0\u51FA\u6307\u5B9A\u5F15\u7528",
    idempotent: false,
    requiresExclusiveWorkspace: true,
    params: [
      { name: "ref", type: "string", required: true, label: "\u5F15\u7528", description: "\u5206\u652F\u3001tag \u6216 commit" },
      { name: "create", type: "boolean", default: false, label: "\u4E0D\u5B58\u5728\u5219\u65B0\u5EFA", description: "\u4E0D\u5B58\u5728\u5219\u65B0\u5EFA\u5206\u652F\uFF08-b\uFF09" }
    ]
  },
  {
    id: "git-stash",
    displayName: "Git Stash",
    description: "\u6682\u5B58\u6216\u6062\u590D\u672C\u5730\u6539\u52A8",
    idempotent: false,
    requiresExclusiveWorkspace: true,
    params: [
      {
        name: "action",
        type: "enum",
        enum: ["push", "pop", "drop", "list"],
        default: "push",
        required: true,
        label: "\u64CD\u4F5C"
      },
      { name: "message", type: "string", label: "\u8BF4\u660E", description: "push \u65F6\u7684\u8BF4\u660E" },
      { name: "includeUntracked", type: "boolean", default: false, label: "\u5305\u542B\u672A\u8DDF\u8E2A\u6587\u4EF6", description: "push \u65F6\u5305\u542B\u672A\u8DDF\u8E2A\u6587\u4EF6" }
    ]
  },
  {
    id: "git-clean",
    displayName: "Git Clean",
    description: "\u5220\u9664\u672A\u8DDF\u8E2A\u6587\u4EF6",
    idempotent: true,
    requiresExclusiveWorkspace: true,
    params: [
      { name: "directories", type: "boolean", default: true, label: "\u5220\u9664\u672A\u8DDF\u8E2A\u76EE\u5F55", description: "\u540C\u65F6\u5220\u9664\u672A\u8DDF\u8E2A\u76EE\u5F55\uFF08-d\uFF09" },
      { name: "ignored", type: "boolean", default: false, label: "\u5220\u9664\u88AB\u5FFD\u7565\u7684\u6587\u4EF6", description: "\u540C\u65F6\u5220\u9664\u88AB ignore \u7684\u6587\u4EF6\uFF08-x\uFF09" }
    ]
  },
  {
    id: "git-reset",
    displayName: "Git Reset",
    description: "\u91CD\u7F6E HEAD / \u6682\u5B58\u533A / \u5DE5\u4F5C\u533A",
    idempotent: false,
    requiresExclusiveWorkspace: true,
    params: [
      {
        name: "mode",
        type: "enum",
        enum: ["mixed", "hard"],
        default: "mixed",
        required: true,
        label: "\u6A21\u5F0F",
        description: "mixed \u4FDD\u7559\u5DE5\u4F5C\u533A\u6539\u52A8\uFF1Bhard \u4E22\u5F03\u672C\u5730\u6539\u52A8"
      },
      { name: "ref", type: "string", default: "HEAD", label: "\u5F15\u7528", description: "\u91CD\u7F6E\u5230\u7684\u5F15\u7528" }
    ]
  },
  {
    id: "git-commit",
    displayName: "Git Commit",
    description: "\u63D0\u4EA4\u672C\u5730\u6539\u52A8",
    idempotent: false,
    requiresExclusiveWorkspace: true,
    params: [
      { name: "message", type: "string", required: true, label: "\u63D0\u4EA4\u8BF4\u660E" },
      { name: "all", type: "boolean", default: true, label: "\u63D0\u4EA4\u5168\u90E8\u6539\u52A8", description: "\u63D0\u4EA4\u524D git add -A" },
      { name: "allowEmpty", type: "boolean", default: false, label: "\u5141\u8BB8\u7A7A\u63D0\u4EA4" }
    ]
  },
  {
    id: "git-push",
    displayName: "Git Push\uFF08\u8FDC\u7AEF\u5199\uFF09",
    description: "\u63A8\u9001\u5230\u8FDC\u7AEF",
    idempotent: false,
    remoteWrite: true,
    requiresExclusiveWorkspace: true,
    params: [
      { name: "remote", type: "string", default: "origin", label: "\u8FDC\u7AEF" },
      { name: "ref", type: "string", label: "\u5F15\u7528", description: "\u8981\u63A8\u9001\u7684\u5F15\u7528\uFF1B\u7559\u7A7A\u5219\u63A8\u5F53\u524D\u5206\u652F" },
      { name: "setUpstream", type: "boolean", default: false, label: "\u8BBE\u7F6E\u4E0A\u6E38" },
      {
        name: "force",
        type: "boolean",
        default: false,
        label: "\u5F3A\u5236\u63A8\u9001",
        description: "\u4F7F\u7528 --force-with-lease\uFF0C\u907F\u514D\u8986\u76D6\u672A\u77E5\u8FDC\u7AEF\u63D0\u4EA4"
      }
    ]
  }
];
var gitIds = new Set(GIT_TOOLS.map((tool) => tool.id));
function isGitTool(toolId) {
  return gitIds.has(toolId);
}
async function runGitTool(toolId, params, ctx) {
  assertGitRepo(ctx.cwd);
  switch (toolId) {
    case "git-status":
      return runGit(ctx, ["status", "-sb"], "git status");
    case "git-fetch": {
      const remote = optionalString(params.remote);
      const args = ["fetch"];
      if (params.prune !== false) {
        args.push("--prune");
      }
      if (remote) {
        args.push(remote);
      } else {
        args.push("--all");
      }
      return runGit(ctx, args, "git fetch");
    }
    case "git-pull": {
      const strategy = String(params.strategy ?? "follow-latest");
      if (strategy === "disabled") {
        return { detail: "strategy=disabled\uFF0C\u8DF3\u8FC7", code: 0, skipped: true };
      }
      const args = ["pull"];
      if (params.ffOnly !== false) {
        args.push("--ff-only");
      }
      if (params.rebase === true) {
        args.push("--rebase");
      }
      const remote = optionalString(params.remote);
      const branch = optionalString(params.branch);
      if (remote && branch) {
        args.push(remote, branch);
      } else if (remote) {
        args.push(remote);
      } else if (branch) {
        args.push("origin", branch);
      }
      return runGit(ctx, args, "git pull");
    }
    case "git-checkout": {
      const ref = String(params.ref);
      const args = params.create === true ? ["checkout", "-b", ref] : ["checkout", ref];
      return runGit(ctx, args, "git checkout");
    }
    case "git-stash": {
      const action = String(params.action ?? "push");
      if (action === "list") {
        return runGit(ctx, ["stash", "list"], "git stash list");
      }
      if (action === "pop") {
        return runGit(ctx, ["stash", "pop"], "git stash pop");
      }
      if (action === "drop") {
        return runGit(ctx, ["stash", "drop"], "git stash drop");
      }
      const args = ["stash", "push"];
      if (params.includeUntracked === true) {
        args.push("-u");
      }
      const message = optionalString(params.message);
      if (message) {
        args.push("-m", message);
      }
      return runGit(ctx, args, "git stash");
    }
    case "git-clean": {
      const args = ["clean", "-f"];
      if (params.directories !== false) {
        args.push("-d");
      }
      if (params.ignored === true) {
        args.push("-x");
      }
      return runGit(ctx, args, "git clean");
    }
    case "git-reset": {
      const mode = String(params.mode ?? "mixed");
      const ref = optionalString(params.ref) || "HEAD";
      return runGit(ctx, ["reset", `--${mode}`, ref], "git reset");
    }
    case "git-commit":
      return runGitCommit(params, ctx);
    case "git-push": {
      const args = ["push"];
      if (params.setUpstream === true) {
        args.push("-u");
      }
      if (params.force === true) {
        args.push("--force-with-lease");
      }
      args.push(optionalString(params.remote) || "origin");
      const ref = optionalString(params.ref);
      if (ref) {
        args.push(ref);
      }
      return runGit(ctx, args, "git push");
    }
    default:
      throw new Error(`\u672A\u5B9E\u73B0 Git \u5DE5\u5177: ${toolId}`);
  }
}
async function runGitCommit(params, ctx) {
  if (params.all !== false) {
    await runGit(ctx, ["add", "-A"], "git add");
  }
  const status = await runGit(ctx, ["status", "--porcelain"], "git status", { allowEmpty: true });
  if (!status.detail.trim() && params.allowEmpty !== true) {
    return { detail: "\u6CA1\u6709\u53EF\u63D0\u4EA4\u7684\u6539\u52A8\uFF0C\u8DF3\u8FC7", code: 0, skipped: true };
  }
  const args = ["commit", "-m", String(params.message)];
  if (params.allowEmpty === true) {
    args.push("--allow-empty");
  }
  return runGit(ctx, args, "git commit");
}
async function runGit(ctx, args, label, options = {}) {
  const result = await runCommand({
    command: "git",
    args,
    cwd: ctx.cwd,
    timeoutMs: ctx.timeoutMs,
    logFile: ctx.logFile,
    abortSignal: ctx.abortSignal
  }).done;
  if (result.cancelled) {
    throw new Error(result.timedOut ? `${label} \u8D85\u65F6` : "\u5DF2\u53D6\u6D88");
  }
  if (result.code !== 0) {
    throw new Error(tail(result.stderr || result.stdout) || `${label} \u9000\u51FA\u7801 ${result.code}`);
  }
  const detail = tail(result.stdout) || (options.allowEmpty ? "" : `${label} \u5B8C\u6210`);
  return { detail, code: result.code };
}
function assertGitRepo(cwd) {
  if (!existsSync(cwd)) {
    throw new Error(`\u76EE\u5F55\u4E0D\u5B58\u5728: ${cwd}`);
  }
  if (!existsSync(path3.join(cwd, ".git"))) {
    throw new Error("\u4E0D\u662F Git \u4ED3\u5E93\uFF08\u7F3A\u5C11 .git\uFF09");
  }
}
function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function tail(text) {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-8).join("\n");
}

// packs/versionControl/src/manifest.ts
var svnUpdate = {
  id: "svn-update",
  displayName: "SVN \u66F4\u65B0",
  description: "\u5BF9\u7167\u8FDC\u7AEF\u5DEE\u5F02\u4F30\u8BA1\u5C06\u5199\u5165\u7684\u6587\u4EF6\uFF1BWindows \u4E0A\u53EF\u6309\u5199\u96C6\u91CA\u653E\u5360\u7528\u540E\u518D\u66F4\u65B0",
  idempotent: true,
  requiresExclusiveWorkspace: true,
  supportsDryRun: true,
  params: [
    {
      name: "strategy",
      type: "enum",
      enum: ["follow-latest", "manual", "disabled"],
      default: "follow-latest",
      required: true,
      label: "\u66F4\u65B0\u7B56\u7565"
    },
    {
      name: "onConflict",
      type: "enum",
      enum: ["fail", "postpone", "revert", "rules"],
      default: "fail",
      label: "\u9047\u5230\u51B2\u7A81",
      description: "fail: \u51B2\u7A81\u5373\u5931\u8D25\uFF1Bpostpone: \u4FDD\u7559\u73B0\u573A\u6302\u8D77\u672C\u8F6E\uFF0C\u4E0B\u8F6E\u81EA\u52A8\u7EE7\u7EED\uFF1Brevert: \u5907\u4EFD\u540E\u8FD8\u539F\uFF1Brules: \u6309 SVN \u89C4\u5219\u6587\u4EF6\u5904\u7406\uFF08\u5148\u5B58\u6863\uFF0C\u53EF\u4E22\u5F03\u7C7B\u522B\u4E0E\u547D\u4E2D\u89C4\u5219\u53D6\u8FDC\u7AEF\uFF0C\u5176\u4F59\u963B\u585E\uFF09"
    },
    { name: "backupOnRevert", type: "boolean", default: true, label: "\u8FD8\u539F\u524D\u5907\u4EFD" },
    { name: "backupDir", type: "string", label: "\u5907\u4EFD\u76EE\u5F55", format: "path" },
    {
      name: "rulesFile",
      type: "string",
      format: "path",
      label: "SVN \u89C4\u5219\u6587\u4EF6",
      description: "onConflict=rules \u65F6\u5FC5\u586B\uFF0Csvn-rules.toml \u7684\u7EDD\u5BF9\u8DEF\u5F84"
    },
    {
      name: "rulesEnable",
      type: "string[]",
      label: "\u5F00\u542F\u7684\u53EF\u9009\u4E22\u5F03\u7C7B\u522B",
      description: "\u89C4\u5219\u6587\u4EF6 discard.optional \u91CC\u7684\u7C7B\u522B\u540D\uFF0C\u5982 art"
    },
    {
      name: "releaseOccupants",
      type: "boolean",
      default: true,
      label: "\u91CA\u653E\u5360\u7528",
      description: "\u6309\u672C\u6B21\u5C06\u5199\u5165\u7684\u6587\u4EF6\u91CA\u653E\u5360\u7528\uFF1B\u72EC\u5360\u5931\u8D25\u4F1A cleanup \u540E\u91CD\u8BD5\u4E00\u6B21\u3002\u4E0D\u60F3\u5F3A\u6740\u5C31\u5173\u6389"
    }
  ]
};
var svnCleanup = {
  id: "svn-cleanup",
  displayName: "SVN Cleanup",
  idempotent: true,
  requiresExclusiveWorkspace: true,
  params: [
    { name: "removeUnversioned", type: "boolean", default: false, label: "\u5220\u9664\u672A\u7EB3\u7BA1\u6587\u4EF6" }
  ]
};
var svnRevert = {
  id: "svn-revert",
  displayName: "SVN Revert",
  description: "\u6309 svn status \u7684\u672C\u5730\u6539\u52A8\u4F30\u8BA1\u5C06\u6539\u5199\u7684\u6587\u4EF6\uFF1BWindows \u4E0A\u53EF\u5148\u91CA\u653E\u5360\u7528",
  idempotent: true,
  requiresExclusiveWorkspace: true,
  params: [
    { name: "recursive", type: "boolean", default: true, label: "\u9012\u5F52" },
    {
      name: "releaseOccupants",
      type: "boolean",
      default: true,
      label: "\u91CA\u653E\u5360\u7528",
      description: "\u6309\u672C\u5730\u810F\u6587\u4EF6\u91CA\u653E\u5360\u7528\u3002\u4E0D\u60F3\u5F3A\u6740\u5C31\u5173\u6389"
    }
  ]
};
var svnSwitch = {
  id: "svn-switch",
  displayName: "SVN Switch",
  idempotent: false,
  requiresExclusiveWorkspace: true,
  remoteWrite: false,
  params: [
    { name: "url", type: "string", required: true, label: "\u76EE\u6807 URL" }
  ]
};
var svnCopy = {
  id: "svn-copy",
  displayName: "SVN Copy\uFF08\u8FDC\u7AEF\u5199\uFF09",
  idempotent: false,
  remoteWrite: true,
  params: [
    { name: "source", type: "string", required: true, label: "\u6E90 URL" },
    { name: "destination", type: "string", required: true, label: "\u76EE\u6807 URL" },
    { name: "message", type: "string", required: true, label: "\u63D0\u4EA4\u8BF4\u660E" }
  ]
};
var svnDelete = {
  id: "svn-delete",
  displayName: "SVN Delete\uFF08\u8FDC\u7AEF\u5199\uFF09",
  idempotent: false,
  remoteWrite: true,
  params: [
    { name: "target", type: "string", required: true, label: "\u8981\u5220\u9664\u7684 URL" },
    { name: "message", type: "string", required: true, label: "\u63D0\u4EA4\u8BF4\u660E" }
  ]
};
var manifest = {
  id: "versionControl",
  displayName: "\u7248\u672C\u63A7\u5236",
  schemaVersion: 1,
  runtime: "node",
  entry: "dist/pack.mjs",
  tools: [svnUpdate, svnCleanup, svnRevert, svnSwitch, svnCopy, svnDelete, ...GIT_TOOLS]
};

// shared/svn-rules.ts
import { readFileSync } from "node:fs";

// node_modules/smol-toml/dist/error.js
function getLineColFromPtr(string, ptr) {
  let lines = string.slice(0, ptr).split(/\r?\n/);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string, line, column) {
  let lines = string.split(/\r?\n/);
  let codeblock = "";
  let numberLen = (Math.log10(line + 1) | 0) + 1;
  for (let i = line - 1; i <= line + 1; i++) {
    let l = lines[i - 1];
    if (!l)
      continue;
    codeblock += i.toString().padEnd(numberLen, " ");
    codeblock += ":  ";
    codeblock += l;
    codeblock += "\n";
    if (i === line) {
      codeblock += " ".repeat(numberLen + column + 2);
      codeblock += "^\n";
    }
  }
  return codeblock;
}
var TomlError = class _TomlError extends Error {
  line;
  column;
  codeblock;
  constructor(message, options) {
    const [line, column] = getLineColFromPtr(options.toml, options.ptr);
    const codeblock = makeCodeBlock(options.toml, line, column);
    super(`Invalid TOML document: ${message}

${codeblock}`, options);
    this.line = line;
    this.column = column;
    this.codeblock = codeblock;
  }
  /** @internal */
  static x(message, ctx, ptr) {
    throw new _TomlError(message, { toml: ctx.s, ptr: ptr ?? ctx.p });
  }
};

// node_modules/smol-toml/dist/primitive.js
function parseString(ctx) {
  let startPtr = ctx.p;
  let c = ctx.s.charCodeAt(ctx.p++);
  let first = c;
  let isLiteral = c === 39;
  let isMultiline = c === ctx.s.charCodeAt(ctx.p) && c === ctx.s.charCodeAt(ctx.p + 1);
  if (isMultiline) {
    if ((c = ctx.s.charCodeAt(ctx.p += 2)) === 10)
      ctx.p++;
    else if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)
      ctx.p += 2;
  }
  let parsed = "";
  let sliceStart = ctx.p;
  let state = 0;
  for (; ctx.p < ctx.s.length; ctx.p++) {
    c = ctx.s.charCodeAt(ctx.p);
    if (isMultiline && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)) {
      state = state && 3;
    } else if (c < 32 && c !== 9 || c === 127) {
      TomlError.x("control characters are not allowed in strings", ctx);
    } else if ((!state || state === 3) && c === first && (!isMultiline || ctx.s.charCodeAt(ctx.p + 1) === first && ctx.s.charCodeAt(ctx.p + 2) === first)) {
      if (isMultiline) {
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
      }
      if (!state) {
        let s = ctx.s.slice(sliceStart, ctx.p);
        parsed = parsed ? parsed + s : s;
      }
      ctx.p += isMultiline ? 3 : 1;
      return parsed;
    } else if (!state) {
      if (!isLiteral && c === 92) {
        parsed += ctx.s.slice(sliceStart, sliceStart = ctx.p);
        state = 1;
      }
    } else if (state === 1) {
      if (c === 120 || c === 117 || c === 85) {
        let errPtr = ctx.p++ - 1;
        let value = 0;
        let len = c === 120 ? 2 : c === 117 ? 4 : 8;
        for (let j = 0; j < len; j++, ctx.p++) {
          let hex = ctx.s.charCodeAt(ctx.p);
          let digit = (
            /* 0-9 */
            hex >= 48 && hex <= 57 ? hex - 48 : (
              /* A-F */
              hex >= 65 && hex <= 70 ? hex - 65 + 10 : (
                /* a-f */
                hex >= 97 && hex <= 102 ? hex - 97 + 10 : -1
              )
            )
          );
          if (digit < 0)
            TomlError.x("invalid non-hex character in unicode escape", ctx);
          value = value << 4 | digit;
        }
        if (value < 0 || value > 1114111 || value >= 55296 && value <= 57343) {
          TomlError.x("invalid unicode escape", ctx, errPtr);
        }
        parsed += String.fromCodePoint(value);
        sliceStart = ctx.p--;
        state = 0;
      } else if (isMultiline && (c === 32 || c === 9)) {
        state = 2;
      } else {
        if (c === 98)
          parsed += "\b";
        else if (c === 116)
          parsed += "	";
        else if (c === 110)
          parsed += "\n";
        else if (c === 102)
          parsed += "\f";
        else if (c === 114)
          parsed += "\r";
        else if (c === 101)
          parsed += "\x1B";
        else if (c === 34)
          parsed += '"';
        else if (c === 92)
          parsed += "\\";
        else
          TomlError.x("unrecognised escape sequence", ctx);
        sliceStart = ctx.p + 1;
        state = 0;
      }
    } else if (c !== 32 && c !== 9) {
      if (state === 2)
        TomlError.x("invalid escape: only line-ending whitespace may be escaped", ctx, sliceStart);
      state = !isLiteral && c === 92 ? 1 : 0;
      sliceStart = ctx.p;
    }
  }
  TomlError.x("unfinished string", ctx, startPtr);
}

// node_modules/smol-toml/dist/date.js
var DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[Tt ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|z|[-+]\d{2}:\d{2})?$/i;
var TomlDate = class _TomlDate extends Date {
  #hasDate = false;
  #hasTime = false;
  #offset = null;
  constructor(date, fasttype, unsafeDelim) {
    let hasDate = true;
    let hasTime = true;
    let offset = "Z";
    let c;
    if (typeof date === "string") {
      if (fasttype)
        prep: {
          if (fasttype < 3) {
            if (+date.slice(11, 13) > 23) {
              date = "";
              break prep;
            }
            if (fasttype === 2) {
              offset = null;
              date += "Z";
            } else if ((c = date.charCodeAt(date.length - 1)) !== 90 && c !== 122) {
              offset = date.slice(date.length - 6);
            }
            if (unsafeDelim)
              date = date.slice(0, 10) + "T" + date.slice(11);
          } else if (fasttype === 4) {
            date = +date.slice(0, 2) > 23 ? "" : `0000-01-01T${date}Z`;
          }
          hasDate = fasttype !== 4;
          hasTime = fasttype !== 3;
        }
      else {
        let match = date.match(DATE_TIME_RE);
        if (match) {
          if (!match[1]) {
            hasDate = false;
            date = `0000-01-01T${date}`;
          }
          hasTime = !!match[2];
          hasTime && date[10] === " " && (date = date.replace(" ", "T"));
          if (match[2] && +match[2] > 23) {
            date = "";
          } else {
            offset = match[3] || null;
            if (!offset && hasTime)
              date += "Z";
          }
        } else {
          date = "";
        }
      }
    }
    super(date);
    if (!isNaN(this.getTime())) {
      this.#hasDate = hasDate;
      this.#hasTime = hasTime;
      this.#offset = offset;
    }
  }
  isDateTime() {
    return this.#hasDate && this.#hasTime;
  }
  isLocal() {
    return !this.#hasDate || !this.#hasTime || !this.#offset;
  }
  isDate() {
    return this.#hasDate && !this.#hasTime;
  }
  isTime() {
    return this.#hasTime && !this.#hasDate;
  }
  isValid() {
    return this.#hasDate || this.#hasTime;
  }
  toISOString() {
    let iso = super.toISOString();
    if (this.isDate())
      return iso.slice(0, 10);
    if (this.isTime())
      return iso.slice(11, 23);
    if (this.#offset === null)
      return iso.slice(0, -1);
    if (this.#offset === "Z" || this.#offset === "z")
      return iso;
    let offset = +this.#offset.slice(1, 3) * 60 + +this.#offset.slice(4, 6);
    offset = this.#offset[0] === "-" ? offset : -offset;
    let offsetDate = new Date(this.getTime() - offset * 6e4);
    return offsetDate.toISOString().slice(0, -1) + this.#offset;
  }
  static wrapAsOffsetDateTime(jsDate, offset = "Z") {
    let date = new _TomlDate(jsDate);
    date.#offset = offset;
    return date;
  }
  static wrapAsLocalDateTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#offset = null;
    return date;
  }
  static wrapAsLocalDate(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasTime = false;
    date.#offset = null;
    return date;
  }
  static wrapAsLocalTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasDate = false;
    date.#offset = null;
    return date;
  }
};

// node_modules/smol-toml/dist/extract.js
function isDigit(char, base = 10) {
  return base === 16 ? char > 47 && char < 58 || char > 64 && char < 71 || char > 96 && char < 103 : char > 47 && char < 48 + base;
}
function isEndOfValue(char, delim) {
  return char === 32 || char === 9 || char === 10 || char === 13 || // Structure end or next value delimiter
  delim && (char === delim || char === 44) || // Comment
  char === 35;
}
function extractValue(ctx, end) {
  let errPtr = ctx.p;
  let c = ctx.s.charCodeAt(ctx.p);
  if (c === 91 || c === 123) {
    ctx.d-- || TomlError.x("document contains excessively nested structures. aborting.", ctx);
    let value = c === 91 ? parseArray(ctx) : parseInlineTable(ctx);
    ctx.d++;
    return value;
  }
  if (c === 34 || c === 39) {
    return parseString(ctx);
  }
  if (c === 116) {
    if (ctx.s.charCodeAt(++ctx.p) !== 114 || ctx.s.charCodeAt(++ctx.p) !== 117 || ctx.s.charCodeAt(++ctx.p) !== 101)
      TomlError.x("invalid value", ctx, errPtr);
    return ctx.p++, true;
  }
  if (c === 102) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 108 || ctx.s.charCodeAt(++ctx.p) !== 115 || ctx.s.charCodeAt(++ctx.p) !== 101)
      TomlError.x("invalid value", ctx, errPtr);
    return ctx.p++, false;
  }
  if (c === 43 || c === 45) {
    return parseNumber(ctx, ctx.p, ctx.s.charCodeAt(++ctx.p), 44 - c, end);
  }
  if (ctx.s.charCodeAt(ctx.p + 4) === 45 && ctx.s.charCodeAt(ctx.p + 7) === 45) {
    return parseDate(ctx, c, end);
  }
  if (ctx.s.charCodeAt(ctx.p + 2) === 58) {
    return parseTime(ctx, c, end);
  }
  return parseNumber(ctx, ctx.p, c, 0, end);
}
function parseNumber(ctx, startPtr, startChr, sign, endChr) {
  let c = startChr;
  let state = 0;
  let hasUnderscores = false;
  if (c === 105) {
    if (ctx.s.charCodeAt(++ctx.p) !== 110 || ctx.s.charCodeAt(++ctx.p) !== 102)
      TomlError.x("invalid value", ctx, startPtr);
    return ctx.p++, (sign || 1) / 0;
  }
  if (c === 110) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 110)
      TomlError.x("invalid value", ctx, startPtr);
    return ctx.p++, NaN;
  }
  if (c === 48) {
    if (++ctx.p >= ctx.s.length || isEndOfValue(c = ctx.s.charCodeAt(ctx.p), endChr))
      return ctx.bi === true ? 0n : 0;
    if (!sign) {
      if (c === 120)
        return parseIntegerBaseN(ctx, startPtr, 16, endChr);
      else if (c === 98)
        return parseIntegerBaseN(ctx, startPtr, 2, endChr);
      else if (c === 111)
        return parseIntegerBaseN(ctx, startPtr, 8, endChr);
    }
    if (c === 46)
      state = 2;
    else if (c === 101 || c === 69)
      state = 4;
    else
      TomlError.x("illegal leading zero", ctx, startPtr);
  } else if (!isDigit(c))
    TomlError.x("invalid value", ctx, startPtr);
  while (++ctx.p < ctx.s.length && (c = ctx.s.charCodeAt(ctx.p), !isEndOfValue(c, endChr))) {
    if (!state)
      state = 1;
    if (c === 95) {
      if (!(state & 1))
        TomlError.x("illegal underscore", ctx);
      state += 11;
      hasUnderscores = true;
    } else if (state === 1 && c === 46)
      state = 2;
    else if ((state === 1 || state === 3) && (c === 101 || c === 69))
      state = 4;
    else if (state === 4 && (c === 43 || c === 45)) {
      state = 6;
    } else if (!isDigit(c))
      TomlError.x(`illegal character in numeric literal`, ctx);
    else if (state > 9)
      state -= 11;
    else if (!(state & 1))
      state++;
  }
  if (!state) {
    let val = (startChr - 48) * (sign || 1);
    return ctx.bi === true ? BigInt(val) : val;
  }
  if (!(state & 1))
    TomlError.x("unfinished numeric value", ctx, startPtr);
  let str = ctx.s.slice(startPtr, ctx.p);
  if (hasUnderscores)
    str = str.replaceAll("_", "");
  return state > 1 ? parseFloat(str) : parseInteger(ctx, str, 10, startPtr);
}
function parseIntegerBaseN(ctx, startPtr, base, endChr) {
  let c, underscore = 1;
  while (++ctx.p < ctx.s.length && (c = ctx.s.charCodeAt(ctx.p), !isEndOfValue(c, endChr))) {
    if (c === 95) {
      if (underscore & 1)
        TomlError.x("illegal underscore", ctx);
      underscore = 3;
    } else if (!isDigit(c, base))
      TomlError.x(`illegal character in numeric literal`, ctx);
    else if (underscore & 1)
      underscore--;
  }
  if (underscore & 1)
    TomlError.x("unfinished numeric value", ctx);
  let str = ctx.s.slice(startPtr + 2, ctx.p);
  if (underscore)
    str = str.replaceAll("_", "");
  return parseInteger(ctx, str, base, startPtr);
}
function parseInteger(ctx, str, base, startPtr) {
  if (ctx.bi !== true)
    int: {
      let val = parseInt(str, base);
      if (!Number.isSafeInteger(val)) {
        if (ctx.bi)
          break int;
        TomlError.x("integer value cannot be represented losslessly", ctx, startPtr);
      }
      return val;
    }
  return base === 10 ? BigInt(str) : BigInt((base === 2 ? "0b" : base === 8 ? "0o" : "0x") + str);
}
function parseDate(ctx, c, endChr) {
  let startPtr = ctx.p++, unsafeSeparator;
  if (!isDigit(c) || !isDigit(ctx.s.charCodeAt(ctx.p++)) || !isDigit(ctx.s.charCodeAt(ctx.p++)) || !isDigit(ctx.s.charCodeAt(ctx.p++))) {
    return parseNumber(ctx, ctx.p = startPtr, c, 0, endChr);
  }
  ctx.p += 5;
  if (!isDigit(ctx.s.charCodeAt(ctx.p++)))
    TomlError.x("invalid date-time: date part is malformed", ctx, startPtr);
  if (ctx.p >= ctx.s.length || ((c = ctx.s.charCodeAt(ctx.p)) !== 32 || (unsafeSeparator = true, !isDigit(ctx.s.charCodeAt(ctx.p + 1)))) && c !== 84 && c !== 116) {
    let t2 = ctx.s.slice(startPtr, ctx.p);
    return readDate(ctx, t2, 3, false, startPtr);
  }
  if (ctx.s.charCodeAt(ctx.p += 3) !== 58)
    TomlError.x("invalid date-time: time part is malformed", ctx, startPtr);
  if (ctx.s.charCodeAt(ctx.p += 3) === 58)
    ctx.p += 3;
  if (ctx.s.charCodeAt(ctx.p) === 46)
    while (isDigit(ctx.s.charCodeAt(++ctx.p)))
      ;
  if (c = ctx.s.charCodeAt(ctx.p)) {
    if (c === 90 || c === 122) {
      let t2 = ctx.s.slice(startPtr, ++ctx.p);
      return readDate(ctx, t2, 1, unsafeSeparator, startPtr, "[+00:00]");
    }
    if (c === 43 || c === 45) {
      let t2 = ctx.s.slice(startPtr, ctx.p += 6);
      return readDate(ctx, t2, 1, unsafeSeparator, startPtr, !ctx.ld && "[" + ctx.s.slice(ctx.p - 6, ctx.p) + "]");
    }
  }
  let t = ctx.s.slice(startPtr, ctx.p);
  return readDate(ctx, t, 2, unsafeSeparator, startPtr);
}
function parseTime(ctx, c, endChr) {
  let start = ctx.p;
  if (!isDigit(c) || !isDigit(ctx.s.charCodeAt(++ctx.p))) {
    return parseNumber(ctx, --ctx.p, c, 0, endChr);
  }
  if (ctx.s.charCodeAt(ctx.p += 4) === 58)
    ctx.p += 3;
  if (ctx.s.charCodeAt(ctx.p) === 46)
    while (isDigit(ctx.s.charCodeAt(++ctx.p)))
      ;
  let t = ctx.s.slice(start, ctx.p);
  return readDate(ctx, t, 4, false, start);
}
function readDate(ctx, str, type, unsafeDelim, errPtr, temporalSuffix) {
  if (ctx.ld) {
    let date = new TomlDate(str, type, unsafeDelim);
    if (!date.isValid())
      TomlError.x("invalid date", ctx, errPtr);
    return date;
  }
  try {
    if (temporalSuffix)
      str += temporalSuffix;
    switch (type) {
      case 1:
        return Temporal.ZonedDateTime.from(str);
      case 2:
        return Temporal.PlainDateTime.from(str);
      case 3:
        return Temporal.PlainDate.from(str);
      case 4:
        return Temporal.PlainTime.from(str);
    }
  } catch (e) {
    TomlError.x(e instanceof Error ? e.message : "" + e, ctx, errPtr);
  }
}

// node_modules/smol-toml/dist/util.js
function skipComment(ctx) {
  for (; ctx.p < ctx.s.length; ctx.p++) {
    let c = ctx.s.charCodeAt(ctx.p);
    if (c === 10)
      break;
    if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10) {
      ctx.p++;
      break;
    }
    if (c < 32 && c !== 9 || c === 127) {
      TomlError.x("control characters are not allowed in comments", ctx);
    }
  }
}
function skipVoid(ctx, banNewLines, banComments) {
  let c;
  while (ctx.p < ctx.s.length) {
    while (ctx.p < ctx.s.length && ((c = ctx.s.charCodeAt(ctx.p)) === 32 || c === 9 || !banNewLines && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)))
      ctx.p++;
    if (banComments || c !== 35)
      break;
    skipComment(ctx);
  }
}

// node_modules/smol-toml/dist/struct.js
function parseKey(ctx, end = 61) {
  let startPtr;
  let state = 0;
  let parsed = [];
  let sliceStart;
  let c = ctx.s.charCodeAt(startPtr = ctx.p);
  do {
    if (c === end) {
      if (!state)
        TomlError.x("unexpected end of key", ctx);
      if (state === 1)
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
      return ctx.p++, parsed;
    } else if (c === 46) {
      if (!state)
        TomlError.x("illegal empty bare key", ctx);
      if (state === 1)
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
      state = 0;
    } else if (!state && (c === 34 || c === 39)) {
      if (c === ctx.s.charCodeAt(ctx.p + 1) && c === ctx.s.charCodeAt(ctx.p + 2))
        TomlError.x("illegal quoted key: multiline strings are not allowed", ctx);
      parsed.push(parseString(ctx));
      state = 2;
      ctx.p--;
    } else if (c === 32 || c === 9) {
      if (state === 1) {
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
        state = 2;
      }
    } else if (state === 2 || c < 48 && c !== 45 || c > 57 && c < 65 || c > 90 && c < 97 && c !== 95 || c > 122) {
      TomlError.x("illegal character in key", ctx);
    } else if (!state) {
      state = 1;
      sliceStart = ctx.p;
    }
  } while (c = ctx.s.charCodeAt(++ctx.p));
  TomlError.x("incomplete key-value: cannot find end of key", ctx, startPtr);
}
function parseInlineTable(ctx) {
  let startPtr = ctx.p++;
  let res = /* @__PURE__ */ Object.create(null);
  let seen = /* @__PURE__ */ new Set();
  let c;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 125) {
      ctx.p++;
      return res;
    }
    let k;
    let t = res;
    let hasOwn = false;
    let errPtr = ctx.p;
    let key = parseKey(ctx);
    for (let i = 0; i < key.length; i++) {
      if (i)
        t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
      k = key[i];
      if ((hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k]))) {
        TomlError.x("trying to redefine an already defined value", ctx, errPtr);
      }
      let unsafe = k === "__proto__";
      if (ctx.uk && (unsafe || k === "constructor")) {
        t = ctx.uk !== 1 && TomlError.x("document contains an unsafe property", ctx, errPtr);
        break;
      }
      if (!hasOwn && unsafe) {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
      }
    }
    if (hasOwn) {
      TomlError.x("trying to redefine an already defined value", ctx, errPtr);
    }
    skipVoid(ctx, true, true);
    let value = extractValue(
      ctx,
      125
      /* } */
    );
    if (t && typeof (t[k] = value) === "object")
      seen.add(value);
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 125) {
      return res;
    }
    if (c !== 44)
      TomlError.x("expected comma or end of structure", ctx, ctx.p - 1);
  }
  TomlError.x("unfinished table", ctx, startPtr);
}
function parseArray(ctx) {
  let startPtr = ctx.p++;
  let res = [];
  let c;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 93) {
      ctx.p++;
      return res;
    }
    res.push(extractValue(
      ctx,
      93
      /* ] */
    ));
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 93) {
      return res;
    }
    if (c !== 44)
      TomlError.x("expected comma or end of structure", ctx, ctx.p - 1);
  }
  TomlError.x("unfinished array", ctx, startPtr);
}

// node_modules/smol-toml/dist/parse.js
function peekTable(ctx, key, table, meta, type) {
  let t = table;
  let m = meta;
  let k;
  let hasOwn = false;
  let state;
  for (let i = 0; i < key.length; i++) {
    if (i) {
      t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
      m = (state = m[k]).c;
      if (type === 0 && (state.t === 1 || state.t === 2)) {
        return null;
      }
      if (state.t === 2) {
        let l = t.length - 1;
        t = t[l];
        m = m[l].c;
      }
    }
    k = key[i];
    if ((hasOwn = Object.hasOwn(t, k)) && m[k]?.t === 0 && m[k]?.d) {
      return null;
    }
    if (!hasOwn) {
      let unsafe = k === "__proto__";
      if (ctx.uk && (unsafe || k === "constructor"))
        return false;
      if (unsafe) {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        Object.defineProperty(m, k, { enumerable: true, configurable: true, writable: true });
      }
      m[k] = {
        t: i < key.length - 1 && type === 2 ? 3 : type,
        d: false,
        i: 0,
        c: /* @__PURE__ */ Object.create(null)
      };
    }
  }
  state = m[k];
  if (state.t !== type && !(type === 1 && state.t === 3)) {
    return null;
  }
  if (type === 2) {
    if (!state.d) {
      state.d = true;
      t[k] = [];
    }
    t[k].push(t = /* @__PURE__ */ Object.create(null));
    state.c[state.i++] = state = { t: 1, d: false, i: 0, c: /* @__PURE__ */ Object.create(null) };
  }
  if (state.d) {
    return null;
  }
  state.d = true;
  if (type === 1) {
    t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
  } else if (type === 0 && hasOwn) {
    return null;
  }
  return [k, t, state.c];
}
function validateTablePeek(ctx, peek, ptr) {
  if (peek === null || ctx.uk === 2)
    TomlError.x(peek === null ? "trying to redefine an already defined table or value" : "document contains an unsafe property", ctx, ptr);
}
function parse(toml, options = {}) {
  let ctx = {
    s: toml,
    p: 0,
    d: options.maxDepth ?? 1e3,
    bi: options.integersAsBigInt ?? false,
    ld: options.useLegacyDate ?? true,
    uk: options.unsafeKeyBehaviour === "throw" ? 2 : options.unsafeKeyBehaviour === "drop" ? 1 : 0
  };
  let res = /* @__PURE__ */ Object.create(null);
  let meta = /* @__PURE__ */ Object.create(null);
  let tmp;
  let skipping = false;
  let tbl = res;
  let m = meta;
  if (toml.charCodeAt(0) === 65279)
    ctx.p++;
  skipVoid(ctx);
  while (ctx.p < toml.length) {
    if (toml.charCodeAt(ctx.p) === 91) {
      let isTableArray = toml.charCodeAt(++ctx.p) === 91;
      tmp = ctx.p += +isTableArray;
      skipping = false;
      let k = parseKey(
        ctx,
        93
        /* ] */
      );
      if (isTableArray) {
        if (toml.charCodeAt(ctx.p) !== 93) {
          TomlError.x("expected end of table array declaration", ctx);
        }
        ctx.p++;
      }
      let p = peekTable(
        ctx,
        k,
        res,
        meta,
        isTableArray ? 2 : 1
        /* Type.EXPLICIT */
      );
      if (!p) {
        validateTablePeek(ctx, p, tmp);
        skipping = true;
      } else {
        m = p[2];
        tbl = p[1];
      }
    } else {
      tmp = ctx.p;
      let k = parseKey(ctx);
      let p = peekTable(
        ctx,
        k,
        tbl,
        m,
        0
        /* Type.DOTTED */
      );
      if (!p && !skipping)
        validateTablePeek(ctx, p, tmp);
      skipVoid(ctx, true, true);
      let v = extractValue(ctx, void 0);
      if (p && !skipping)
        p[1][p[0]] = v;
    }
    skipVoid(ctx, true);
    if (ctx.p < toml.length && (tmp = toml.charCodeAt(ctx.p)) !== 10 && (tmp !== 13 || toml.charCodeAt(ctx.p + 1) !== 10)) {
      TomlError.x("each key-value declaration must be followed by an end-of-line", ctx);
    }
    skipVoid(ctx);
  }
  return res;
}

// node_modules/smol-toml/dist/stringify.js
var HAS_WELLFORMED = !!"".isWellFormed;

// shared/svn-rules.ts
var RULE_KINDS = ["local-equals-incoming", "yaml-keys-only", "local-only-missing"];
var SvnRulesError = class extends Error {
};
var TOP_KEYS = /* @__PURE__ */ new Set(["version", "categories", "discard", "rule"]);
var DISCARD_KEYS = /* @__PURE__ */ new Set(["always", "optional"]);
var RULE_KEYS = /* @__PURE__ */ new Set(["id", "when", "paths", "keys"]);
function loadSvnRules(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new SvnRulesError(`\u8BFB\u4E0D\u5230 SVN \u89C4\u5219\u6587\u4EF6 ${file}\uFF1A${error.message}`);
  }
  return parseSvnRules(text, file);
}
function parseSvnRules(text, file = "svn-rules.toml") {
  let raw;
  try {
    raw = parse(text);
  } catch (error) {
    const detail = error instanceof TomlError ? error.message.split("\n")[0] : String(error);
    throw new SvnRulesError(`${file}\uFF1ATOML \u8BED\u6CD5\u9519\u8BEF\uFF1A${detail}`);
  }
  const fail = (message) => {
    throw new SvnRulesError(`${file}\uFF1A${message}`);
  };
  for (const key of Object.keys(raw)) if (!TOP_KEYS.has(key)) fail(`\u672A\u77E5\u5B57\u6BB5 ${key}`);
  if (raw.version !== 1) fail("version \u5FC5\u987B\u4E3A 1");
  const strList = (where, value) => {
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) fail(`${where} \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4`);
    return value;
  };
  const table = (where, value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${where} \u5FC5\u987B\u662F\u8868`);
    return value;
  };
  const categories = {};
  const owner = /* @__PURE__ */ new Map();
  const cats = table("[categories]", raw.categories ?? {});
  for (const [name, value] of Object.entries(cats)) {
    if (!/^[A-Za-z][\w-]*$/.test(name)) fail(`\u7C7B\u522B\u540D ${name} \u53EA\u80FD\u7528\u5B57\u6BCD\u3001\u6570\u5B57\u3001- \u548C _\uFF0C\u4E14\u4EE5\u5B57\u6BCD\u5F00\u5934`);
    const prefixes = [];
    for (const item of strList(`categories.${name}`, value)) {
      const rel = normalizeRulePath(item);
      if (!rel) fail(`categories.${name} \u542B\u975E\u6CD5\u8DEF\u5F84 ${JSON.stringify(item)}`);
      const key = foldCase(rel);
      const prev = owner.get(key);
      if (prev) fail(`\u8DEF\u5F84 ${rel} \u540C\u65F6\u51FA\u73B0\u5728\u7C7B\u522B ${prev} \u548C ${name}`);
      owner.set(key, name);
      prefixes.push(rel);
    }
    categories[name] = prefixes;
  }
  const discard = table("[discard]", raw.discard ?? {});
  for (const key of Object.keys(discard)) if (!DISCARD_KEYS.has(key)) fail(`[discard] \u672A\u77E5\u5B57\u6BB5 ${key}`);
  const always = strList("discard.always", discard.always ?? []);
  const optional = strList("discard.optional", discard.optional ?? []);
  for (const name of [...always, ...optional]) if (!(name in categories)) fail(`[discard] \u5F15\u7528\u4E86\u672A\u5B9A\u4E49\u7684\u7C7B\u522B ${name}`);
  for (const name of always) if (optional.includes(name)) fail(`\u7C7B\u522B ${name} \u4E0D\u80FD\u540C\u65F6\u5728 always \u548C optional`);
  const rules = [];
  const ruleList = raw.rule ?? [];
  if (!Array.isArray(ruleList)) fail("rule \u5FC5\u987B\u5199\u6210 [[rule]] \u6570\u7EC4");
  ruleList.forEach((value, index) => {
    const r = table(`rule[${index}]`, value);
    for (const key of Object.keys(r)) if (!RULE_KEYS.has(key)) fail(`rule[${index}] \u672A\u77E5\u5B57\u6BB5 ${key}`);
    if (typeof r.id !== "string" || !/^[A-Za-z][\w-]*$/.test(r.id)) fail(`rule[${index}].id \u5FC5\u987B\u662F\u5B57\u6BCD\u5F00\u5934\u7684\u6807\u8BC6`);
    const id = r.id;
    if (rules.some((x) => x.id === id)) fail(`rule id ${id} \u91CD\u590D`);
    if (!RULE_KINDS.includes(r.when)) fail(`rule ${id} \u7684 when \u53EA\u80FD\u662F ${RULE_KINDS.join("\u3001")}`);
    const when = r.when;
    const paths = strList(`rule ${id} \u7684 paths`, r.paths ?? []);
    const keys = strList(`rule ${id} \u7684 keys`, r.keys ?? []);
    if (when === "yaml-keys-only" && keys.length === 0) fail(`rule ${id} \u662F yaml-keys-only\uFF0C\u5FC5\u987B\u7ED9 keys`);
    if (when !== "yaml-keys-only" && keys.length > 0) fail(`rule ${id} \u53EA\u6709 yaml-keys-only \u624D\u80FD\u5199 keys`);
    for (const k of keys) if (!/^[A-Za-z_][\w-]*$/.test(k)) fail(`rule ${id} \u7684 key ${k} \u4E0D\u662F\u5408\u6CD5\u7684 YAML \u952E`);
    const matchers = paths.map((p) => {
      const norm = p.replace(/\\/g, "/");
      if (!norm || norm.startsWith("/") || norm.split("/").includes("..")) fail(`rule ${id} \u7684 paths \u542B\u975E\u6CD5\u6A21\u5F0F ${p}`);
      return globToRegExp(norm);
    });
    rules.push({ id, when, paths, keys, matchers });
  });
  return { file, categories, always, optional, rules };
}
function normalizeRulePath(item) {
  const rel = item.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!rel || rel.includes(":")) return void 0;
  if (rel.split("/").some((part) => part === "" || part === "." || part === "..")) return void 0;
  return rel;
}
function discardSet(rules, enable) {
  for (const name of enable) {
    if (!rules.optional.includes(name)) {
      const hint = rules.always.includes(name) ? "\uFF08\u5B83\u5DF2\u603B\u662F\u4E22\u5F03\uFF0C\u4E0D\u7528\u5F00\u542F\uFF09" : `\uFF1B\u53EF\u9009\uFF1A${rules.optional.join("\u3001") || "\u65E0"}`;
      throw new SvnRulesError(`${rules.file}\uFF1A\u7C7B\u522B ${name} \u4E0D\u80FD\u5F00\u542F${hint}`);
    }
  }
  return /* @__PURE__ */ new Set([...rules.always, ...enable]);
}
function categoryOf(rules, rel) {
  const target = foldCase(rel);
  let best;
  for (const [name, prefixes] of Object.entries(rules.categories)) {
    for (const prefix of prefixes) {
      const p = foldCase(prefix);
      if ((target === p || target.startsWith(`${p}/`)) && (!best || prefix.length > best.prefix.length)) best = { name, prefix };
    }
  }
  return best;
}
function ruleMatchesPath(rule, rel) {
  if (rule.matchers.length === 0) return true;
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  return rule.paths.some((p, i) => rule.matchers[i].test(p.replace(/\\/g, "/").includes("/") ? rel : base));
}
function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, process.platform === "win32" ? "i" : "");
}
function sameExceptTopLevelKeys(a, b, keys) {
  const text = (v) => {
    const s = typeof v === "string" ? v : v.toString("utf8");
    return s.includes("\0") ? void 0 : s;
  };
  const ta = text(a);
  const tb = text(b);
  if (ta === void 0 || tb === void 0) return false;
  const drop = new RegExp(`^(?:${keys.map((k) => k.replace(/[-]/g, "\\-")).join("|")}):`);
  const lines = (s) => s.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n").filter((line) => !drop.test(line));
  const la = lines(ta);
  const lb = lines(tb);
  return la.length === lb.length && la.every((line, i) => line === lb[i]);
}
function foldCase(p) {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

// shared/svn-update.ts
import { cpSync as cpSync2, existsSync as existsSync6, mkdirSync as mkdirSync6, writeFileSync as writeFileSync4 } from "node:fs";
import path9 from "node:path";

// shared/occupants.ts
import { closeSync, existsSync as existsSync2, mkdtempSync, openSync, rmSync, unlinkSync, writeFileSync as writeFileSync2 } from "node:fs";
import os2 from "node:os";
import path4 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var PROTECTED_NAMES = /* @__PURE__ */ new Set([
  "explorer",
  "dwm",
  "csrss",
  "winlogon",
  "services",
  "lsass",
  "smss",
  "svchost",
  "system",
  "registry",
  "idle",
  "searchindexer",
  "msmpeng",
  "securityhealthservice",
  "sihost",
  "ctfmon",
  "runtimebroker",
  "startmenuexperiencehost",
  "shellexperiencehost",
  "textinputhost",
  "fontdrvhost",
  "conhost",
  "cursor",
  "code",
  "electron",
  "node",
  "powershell",
  "pwsh"
]);
var ALWAYS_RELEASE = /* @__PURE__ */ new Set([
  "unity",
  "unitycrashhandler64",
  "unitycrashhandler32",
  "unityshadercompiler",
  "unity.licensing.client",
  "tsvncache"
]);
var NEVER_FORCE_KILL = ["rider", "idea", "clion", "webstorm", "pycharm", "goland", "devenv"];
function helperScript() {
  const here = path4.dirname(fileURLToPath2(import.meta.url));
  const candidates = [path4.resolve(here, "../scripts/list-occupants.ps1"), path4.resolve(here, "scripts/list-occupants.ps1")];
  const found = candidates.find((p) => existsSync2(p));
  if (!found) {
    throw new Error(`\u627E\u4E0D\u5230 ${candidates[0]}`);
  }
  return found;
}
async function listOccupants(target, abortSignal, extraFiles) {
  const script = helperScript();
  const prepared = writeFileList(extraFiles);
  try {
    const result = await spawnCaptured({
      command: "powershell",
      args: occupantScriptArgs(script, target, prepared?.listFile),
      timeoutMs: 6e4,
      abortSignal
    });
    return parseOccupantJson(result.stdout);
  } catch (error) {
    if (error instanceof Error && error.message === "\u5DF2\u53D6\u6D88") {
      throw error;
    }
    return [];
  } finally {
    prepared?.cleanup();
  }
}
function occupantScriptArgs(script, target, listFile) {
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Target", target];
  if (listFile) {
    args.push("-FileList", listFile);
  }
  return args;
}
function writeFileList(extraFiles) {
  const files = [...new Set((extraFiles ?? []).filter((item) => item && existsSync2(item)))];
  if (files.length === 0) {
    return void 0;
  }
  const dir = mkdtempSync(path4.join(os2.tmpdir(), "novoard-packs-occ-"));
  const listFile = path4.join(dir, "files.txt");
  writeFileSync2(listFile, `\uFEFF${files.join("\r\n")}\r
`, "utf8");
  return {
    listFile,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
      }
    }
  };
}
function parseOccupantJson(stdout) {
  const raw = (stdout || "").trim();
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter((item) => Number.isFinite(item.pid) && item.pid > 0);
  } catch {
    return [];
  }
}
function isAlwaysRelease(item) {
  const base = path4.parse(item.name).name.toLowerCase();
  const full = item.name.toLowerCase();
  return [...ALWAYS_RELEASE].some((name) => base.includes(name) || full.includes(name));
}
function isNeverForceKill(item) {
  const base = path4.parse(item.name).name.toLowerCase();
  return NEVER_FORCE_KILL.some((name) => base.includes(name));
}
function isUnityEditorFamily(item) {
  const base = path4.parse(item.name).name.toLowerCase();
  const full = item.name.toLowerCase();
  return ["unity", "unitycrashhandler", "unityshadercompiler", "unity.licensing.client"].some(
    (name) => base.includes(name) || full.includes(name)
  );
}
function filterReleasable(occupants) {
  const self = /* @__PURE__ */ new Set([process.pid, process.ppid ?? 0]);
  const unique = /* @__PURE__ */ new Map();
  for (const item of occupants) {
    if (self.has(item.pid)) {
      continue;
    }
    const base = path4.parse(item.name).name.toLowerCase();
    if (PROTECTED_NAMES.has(base) && !isAlwaysRelease(item)) {
      continue;
    }
    if (item.source === "cmdline" && !isAlwaysRelease(item)) {
      continue;
    }
    unique.set(item.pid, item);
  }
  return [...unique.values()];
}
function parseTasklistCsv(stdout) {
  const found = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^"([^"]+)","(\d+)"/);
    if (!match) {
      continue;
    }
    const item = { pid: Number(match[2]), name: match[1], source: "process-name" };
    if (!Number.isFinite(item.pid) || item.pid <= 0) {
      continue;
    }
    if (isUnityEditorFamily(item)) {
      found.push(item);
    }
  }
  return found;
}
async function listUnityProcessesByName(abortSignal) {
  try {
    const result = await spawnCaptured({
      command: "tasklist",
      args: ["/FO", "CSV", "/NH"],
      timeoutMs: 15e3,
      abortSignal
    });
    return parseTasklistCsv(result.stdout || "");
  } catch (error) {
    if (error instanceof Error && error.message === "\u5DF2\u53D6\u6D88") {
      throw error;
    }
    return [];
  }
}
async function scanReleasable(target, abortSignal, extraFiles, includeUnityByName = true) {
  const occupants = await listOccupants(target, abortSignal, extraFiles);
  if (!includeUnityByName) {
    return filterReleasable(occupants);
  }
  const unity = await listUnityProcessesByName(abortSignal);
  return filterReleasable([...occupants, ...unity]);
}
function unityLockFiles(workspaceRoot) {
  return [
    path4.join(workspaceRoot, "Temp", "UnityLockfile"),
    path4.join(workspaceRoot, "Project", "Temp", "UnityLockfile")
  ].filter((file) => existsSync2(file));
}
async function taskkill(pid, force, abortSignal) {
  const args = force ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"];
  try {
    await spawnCaptured({
      command: "taskkill",
      args,
      timeoutMs: 15e3,
      abortSignal,
      ignoreOutput: true
    });
  } catch (error) {
    if (error instanceof Error && error.message === "\u5DF2\u53D6\u6D88") {
      throw error;
    }
  }
}
async function stillAlive(pid, abortSignal) {
  try {
    const result = await spawnCaptured({
      command: "tasklist",
      args: ["/FI", `PID eq ${pid}`, "/NH"],
      timeoutMs: 1e4,
      abortSignal
    });
    return (result.stdout || "").includes(String(pid));
  } catch (error) {
    if (error instanceof Error && error.message === "\u5DF2\u53D6\u6D88") {
      throw error;
    }
    return false;
  }
}
async function waitMs(ms, signal) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("\u5DF2\u53D6\u6D88"));
      },
      { once: true }
    );
  });
}
async function prepareExclusiveAccess(options) {
  const graceMs = options.graceMs ?? 2e4;
  const includeUnityByName = options.includeUnityByName !== false;
  const first = await scanReleasable(
    options.target,
    options.abortSignal,
    options.extraFiles,
    includeUnityByName
  );
  if (first.length > 0) {
    for (const item of first) {
      if (options.abortSignal?.aborted) {
        throw new Error("\u5DF2\u53D6\u6D88");
      }
      await taskkill(item.pid, false, options.abortSignal);
    }
    await waitMs(Math.min(graceMs, 2e4), options.abortSignal);
    const leftover = [];
    for (const item of await scanReleasable(
      options.target,
      options.abortSignal,
      options.extraFiles,
      includeUnityByName
    )) {
      if (await stillAlive(item.pid, options.abortSignal)) {
        leftover.push(item);
      }
    }
    for (const item of leftover) {
      if (options.abortSignal?.aborted) {
        throw new Error("\u5DF2\u53D6\u6D88");
      }
      if (isNeverForceKill(item)) {
        continue;
      }
      await taskkill(item.pid, true, options.abortSignal);
    }
    await waitMs(2e3, options.abortSignal);
  }
  const remaining = await scanReleasable(
    options.target,
    options.abortSignal,
    options.extraFiles,
    includeUnityByName
  );
  if (remaining.length > 0) {
    return { closed: first, remaining, remainingLocks: unityLockFiles(options.target) };
  }
  if (!includeUnityByName) {
    return { closed: first, remaining, remainingLocks: [] };
  }
  const remainingLocks = await clearStaleUnityLocks(options.target, options.lockWaitMs ?? 1e4, options.abortSignal);
  return { closed: first, remaining, remainingLocks };
}
async function clearStaleUnityLocks(workspaceRoot, waitMsMax, abortSignal) {
  const deadline = Date.now() + waitMsMax;
  while (true) {
    const locks = unityLockFiles(workspaceRoot);
    if (locks.length === 0) {
      return [];
    }
    const unityAlive = (await scanReleasable(workspaceRoot, abortSignal)).filter(isUnityEditorFamily);
    if (unityAlive.length === 0) {
      for (const file of locks) {
        try {
          unlinkSync(file);
        } catch {
        }
      }
      return unityLockFiles(workspaceRoot);
    }
    if (Date.now() >= deadline) {
      return locks;
    }
    await waitMs(500, abortSignal);
  }
}

// shared/svn-run.ts
import { appendFileSync, mkdirSync as mkdirSync3 } from "node:fs";
import path5 from "node:path";
var SVN_WC_WRITE = /* @__PURE__ */ new Set(["update", "up", "revert", "commit", "ci", "switch", "sw", "merge", "checkout", "co", "add", "delete", "rm", "copy", "cp", "move", "mv", "resolve"]);
var INTERRUPT_CLEANUP_MS = 6e3;
var SVN_GRACEFUL_MS = 1e3;
function appendLog(logFile, line) {
  try {
    mkdirSync3(path5.dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${line}
`, "utf8");
  } catch {
  }
}
async function cleanupAfterInterrupt(args, options) {
  if (!SVN_WC_WRITE.has(args[0] ?? "")) return "";
  const result = await runCommand({
    command: "svn",
    args: ["cleanup", "--non-interactive"],
    cwd: options.cwd,
    timeoutMs: INTERRUPT_CLEANUP_MS,
    logFile: options.logFile,
    gracefulMs: SVN_GRACEFUL_MS
  }).done;
  const ok = !result.cancelled && result.code === 0;
  appendLog(options.logFile, `[novoard-packs] \u4E2D\u65AD\u540E svn cleanup ${ok ? "\u5B8C\u6210" : `\u5931\u8D25 code=${result.code} timedOut=${result.timedOut}`}`);
  return ok ? "\uFF08\u5DF2 svn cleanup\uFF09" : "\uFF08svn cleanup \u672A\u5B8C\u6210\uFF0C\u4E0B\u6B21\u8FD0\u884C\u524D\u9700\u624B\u52A8 cleanup\uFF09";
}

// shared/svn-resolve.ts
import { cpSync, existsSync as existsSync5, mkdirSync as mkdirSync5, mkdtempSync as mkdtempSync2, readFileSync as readFileSync2, rmSync as rmSync2, statSync, writeFileSync as writeFileSync3, appendFileSync as appendFileSync2 } from "node:fs";
import os3 from "node:os";
import path8 from "node:path";

// shared/svn-archive.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync4 } from "node:fs";
import path6 from "node:path";
function archiveStamp(now) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
function createArchiveDir(root, now) {
  const base = path6.join(root, archiveStamp(now));
  let dir = base;
  for (let i = 2; existsSync3(dir); i++) dir = `${base}_${i}`;
  mkdirSync4(dir, { recursive: true });
  return dir;
}
function toRelativePatch(diff, wc) {
  const variants = [wc, wc.replace(/\\/g, "/")].map((p) => p.replace(/[\\/]+$/, ""));
  let out = diff;
  for (const v of new Set(variants)) {
    out = out.split(`${v}/`).join("").split(`${v}\\`).join("");
  }
  return out;
}

// shared/svn-status.ts
import { existsSync as existsSync4 } from "node:fs";
import path7 from "node:path";
var LOCAL_WRITE_ITEMS = /* @__PURE__ */ new Set([
  "modified",
  "added",
  "deleted",
  "replaced",
  "conflicted",
  "missing",
  "incomplete",
  "obstructed"
]);
var INCOMING_WRITE_ITEMS = /* @__PURE__ */ new Set(["modified", "added", "deleted", "replaced"]);
var LOCK_PRONE_EXT = /* @__PURE__ */ new Set([
  ".dll",
  ".exe",
  ".pdb",
  ".mdb",
  ".so",
  ".dylib",
  ".lib",
  ".sys",
  ".ocx",
  ".pyd",
  ".node",
  ".unity3d",
  ".resource",
  ".bundle",
  ".pak",
  ".dat",
  ".db",
  ".sqlite",
  ".lock"
]);
var MAX_LOCK_PROBE_FILES = 2048;
function parseSvnStatusXml(xml) {
  const entries = [];
  const re = /<entry\b([^>]*)>([\s\S]*?)<\/entry>/gi;
  let match;
  while (match = re.exec(xml)) {
    const pathAttr = /(?:^|\s)path="([^"]*)"/i.exec(match[1]);
    if (!pathAttr) {
      continue;
    }
    const body = match[2];
    const wc = /<wc-status\b([^>]*)>/i.exec(body);
    const repos = /<repos-status\b([^>]*)>/i.exec(body);
    const wcItem = attr(wc?.[1], "item") ?? "none";
    const reposItem = attr(repos?.[1], "item");
    const wcLocked = attr(wc?.[1], "wc-locked") === "true";
    entries.push({
      path: decodeXml(pathAttr[1]),
      wcItem,
      ...reposItem ? { reposItem } : {},
      ...wcLocked ? { wcLocked: true } : {}
    });
  }
  return entries;
}
function attr(source, name) {
  if (!source) {
    return void 0;
  }
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "i").exec(source)?.[1];
}
function parseStatusItems(xml) {
  const out = [];
  const re = /<entry\b([^>]*)>([\s\S]*?)<\/entry>/g;
  let match;
  while (match = re.exec(xml)) {
    const p = /\bpath="([^"]*)"/.exec(match[1])?.[1];
    const wc = /<wc-status\b([^>]*)>([\s\S]*?)<\/wc-status>|<wc-status\b([^>]*)\/>/.exec(match[2]);
    if (p === void 0 || !wc) continue;
    const attrs = wc[1] ?? wc[3] ?? "";
    const body = wc[2] ?? "";
    const get = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
    out.push({
      path: decodeXml(p).replace(/\\/g, "/"),
      item: get("item") ?? "normal",
      props: get("props") ?? "none",
      treeConflicted: get("tree-conflicted") === "true",
      wcLocked: get("wc-locked") === "true",
      switched: get("switched") === "true",
      copied: get("copied") === "true",
      locked: /<lock>/.test(body)
    });
  }
  return out;
}
function relativeTo(wc, p, cwd) {
  const resolved = Boolean(cwd) && !path7.isAbsolute(p);
  const norm = (resolved ? path7.resolve(cwd, p) : p).replace(/\\/g, "/");
  const root = (resolved ? path7.resolve(wc) : wc).replace(/\\/g, "/").replace(/\/+$/, "");
  const fold2 = (s) => process.platform === "win32" ? s.toLowerCase() : s;
  if (fold2(norm) === fold2(root)) return ".";
  if (fold2(norm).startsWith(`${fold2(root)}/`)) return norm.slice(root.length + 1);
  return norm;
}
function decodeXml(value) {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function relativeFromStatusPath(entryPath) {
  return entryPath.replace(/\//g, path7.sep);
}
function revertWriteRelatives(entries) {
  const found = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    if (LOCAL_WRITE_ITEMS.has(entry.wcItem)) {
      found.add(relativeFromStatusPath(entry.path));
    }
  }
  return [...found];
}
function updateWriteRelatives(entries, includeRevertLocal) {
  const found = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    if (entry.reposItem && INCOMING_WRITE_ITEMS.has(entry.reposItem)) {
      found.add(relativeFromStatusPath(entry.path));
      continue;
    }
    if (includeRevertLocal && LOCAL_WRITE_ITEMS.has(entry.wcItem)) {
      found.add(relativeFromStatusPath(entry.path));
    }
  }
  return [...found];
}
function prioritizeLockTargets(rels) {
  const lockProne = [];
  const rest = [];
  for (const rel of rels) {
    if (isLockProne(rel)) {
      lockProne.push(rel);
    } else {
      rest.push(rel);
    }
  }
  return [...lockProne, ...rest].slice(0, MAX_LOCK_PROBE_FILES);
}
function isLockProne(rel) {
  return LOCK_PRONE_EXT.has(path7.extname(rel).toLowerCase());
}
function svnMetadataPaths(workingCopy) {
  return [
    path7.join(workingCopy, ".svn", "wc.db"),
    path7.join(workingCopy, ".svn", "lock"),
    path7.join(workingCopy, "Temp", "UnityLockfile"),
    path7.join(workingCopy, "Project", "Temp", "UnityLockfile")
  ];
}
function resolveWriteTargets(workingCopy, relatives) {
  const abs = /* @__PURE__ */ new Set();
  for (const rel of prioritizeLockTargets(relatives)) {
    const file = path7.resolve(workingCopy, rel);
    abs.add(file);
    if (!existsSync4(file)) {
      abs.add(path7.dirname(file));
    }
  }
  for (const extra of svnMetadataPaths(workingCopy)) {
    abs.add(extra);
  }
  abs.add(path7.resolve(workingCopy));
  return [...abs];
}
function isSvnLockError(text) {
  const blob = text || "";
  if (/E720032|E720005|E720033|E155004|E200031/.test(blob)) {
    return true;
  }
  return /being used by another process/i.test(blob) || /另一个程序正在使用此文件/.test(blob) || /进程无法访问/.test(blob) || /Access is denied/i.test(blob) || /工作副本被锁定/.test(blob) || /working copy .*locked/i.test(blob);
}
function conflictedRelativesFromUpdateOutput(stdout) {
  const found = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([ADUCGERB ]{4}) (\S.*)$/.exec(line);
    if (match && match[1].includes("C")) {
      found.push(match[2].trim());
    }
  }
  return [...new Set(found)];
}
function isSvnUpdateItemLine(line) {
  const match = /^([ADUCGER ]{4}) (\S.*)$/.exec(line);
  return match !== null && match[1].trim() !== "";
}
function createUpdateProgress(options) {
  const intervalMs = options.intervalMs ?? 1e3;
  const now = options.now ?? Date.now;
  let count = 0;
  let lastAt = -Infinity;
  const describe = () => {
    if (options.total > 0) {
      return {
        message: `\u66F4\u65B0\u6587\u4EF6 ${count}/${options.total}`,
        percent: Math.min(99, Math.floor(count / options.total * 100))
      };
    }
    return { message: `\u66F4\u65B0\u6587\u4EF6 ${count}`, percent: null };
  };
  return {
    line: (line) => {
      if (!isSvnUpdateItemLine(line)) return;
      count += 1;
      const at = now();
      if (at - lastAt < intervalMs) return;
      lastAt = at;
      const { message, percent } = describe();
      options.emit(message, percent);
    },
    finish: () => {
      options.emit(`\u66F4\u65B0\u5B8C\u6210\uFF0C\u5171 ${count} \u4E2A\u6761\u76EE`, 100);
    },
    count: () => count
  };
}
function pathsFromSvnError(text) {
  const found = /* @__PURE__ */ new Set();
  const quoted = /'((?:[A-Za-z]:)?[^']*[\\/][^']+)'|"((?:[A-Za-z]:)?[^"]*[\\/][^"]+)"/g;
  let match;
  while (match = quoted.exec(text)) {
    const value = match[1] ?? match[2] ?? "";
    if (value) {
      found.add(value);
    }
  }
  return [...found];
}

// shared/svn-resolve.ts
var RulesBlockedError = class extends Error {
  constructor(outcome) {
    super(describeBlocked(outcome));
    this.outcome = outcome;
  }
};
function describeBlocked(outcome) {
  const n = outcome.blocked.length;
  const list = outcome.blocked.slice(0, 8).map((e) => `${e.path}\uFF08${e.reason ?? e.what}\uFF09`).join("\uFF1B");
  const more = n > 8 ? ` \u7B49 ${n} \u9879` : "";
  return `\u89C4\u5219\u5904\u7406\u540E\u4ECD\u6709 ${n} \u9879\u9700\u8981\u4EBA\u5DE5\u5904\u7406\uFF1A${list}${more}${outcome.archiveDir ? `\uFF1B\u5DF2\u5904\u7406\u90E8\u5206\u5B58\u6863 ${outcome.archiveDir}` : ""}`;
}
function summarizeRules(outcome) {
  const count = (action) => outcome.entries.filter((e) => e.action === action).length;
  const parts = [
    count("theirs") ? `\u53D6\u8FDC\u7AEF ${count("theirs")}` : "",
    count("revert") ? `\u8FD8\u539F ${count("revert")}` : "",
    count("switch-back") ? `\u5207\u56DE ${count("switch-back")}` : ""
  ].filter(Boolean);
  if (parts.length === 0) return "";
  return `\u89C4\u5219\u5904\u7406\uFF1A${parts.join("\u3001")}${outcome.archiveDir ? `\uFF08\u5B58\u6863 ${outcome.archiveDir}\uFF09` : ""}`;
}
var DIRTY = /* @__PURE__ */ new Set(["modified", "added", "deleted", "replaced", "missing"]);
var ACTION_LABEL = { add: "\u65B0\u589E", delete: "\u5220\u9664", edit: "\u4FEE\u6539", replace: "\u66FF\u6362" };
var REASON_LABEL = {
  unversioned: "\u6709\u672A\u7EB3\u7BA1\u6587\u4EF6",
  edit: "\u5DF2\u4FEE\u6539",
  delete: "\u5DF2\u5220\u9664",
  missing: "\u7F3A\u5931",
  obstructed: "\u88AB\u963B\u788D",
  added: "\u5DF2\u65B0\u589E",
  replaced: "\u5DF2\u66FF\u6362",
  "moved-away": "\u5DF2\u79FB\u8D70",
  "moved-here": "\u5DF2\u79FB\u5165"
};
var MAX_ROUNDS = 3;
async function applySvnRules(o) {
  const discard = discardSet(o.rules, o.enable);
  const outcome = { entries: [], blocked: [], archiveDir: o.archiveDir, notes: [] };
  const tmp = mkdtempSync2(path8.join(os3.tmpdir(), "novoard-svn-rules-"));
  let force = [...new Set(o.forceArchive ?? [])];
  let rootUrl;
  const ctx = {
    o,
    discard,
    tmp,
    abs: (rel) => rel === "." || rel === "" ? o.wc : path8.join(o.wc, ...rel.split("/")),
    rel: (p) => relativeTo(o.wc, p, o.cwd),
    rootUrl: async () => {
      if (rootUrl) return rootUrl;
      const info = await o.run(["info", "--xml", peg(o.wc)]);
      rootUrl = decodeXml(/<url>([\s\S]*?)<\/url>/.exec(info.stdout)?.[1] ?? "").replace(/\/+$/, "");
      if (!rootUrl) throw new Error(`\u8BFB\u4E0D\u5230 ${o.wc} \u7684 URL`);
      return rootUrl;
    },
    archiveDir: () => {
      outcome.archiveDir ??= createArchiveDir(o.archiveRoot, o.now);
      return outcome.archiveDir;
    },
    currentArchiveDir: () => outcome.archiveDir
  };
  try {
    for (let round = 1; ; round++) {
      o.onStage?.(`${o.phase}\uFF1A\u6309\u89C4\u5219\u68C0\u67E5\u5DE5\u4F5C\u526F\u672C`);
      let items = await statusItems(ctx, o.wc);
      if (items.some((it) => it.item.wcLocked)) {
        if (!o.cleanupLocks) {
          outcome.blocked = [{ path: ".", what: "\u5DE5\u4F5C\u526F\u672C\u9501", action: "blocked", reason: "\u5DE5\u4F5C\u526F\u672C\u88AB\u9501\u5B9A\uFF08\u4E2D\u65AD\u6B8B\u7559\uFF09\uFF0C\u672A\u5141\u8BB8 cleanup" }];
          break;
        }
        await o.run(["cleanup", peg(o.wc)]);
        outcome.notes.push("\u5DF2 svn cleanup \u89E3\u9664\u5DE5\u4F5C\u526F\u672C\u9501");
        items = await statusItems(ctx, o.wc);
      }
      const plan = await planRound(ctx, items);
      for (const note of plan.notes) if (!outcome.notes.includes(note)) outcome.notes.push(note);
      const acting = plan.victims.length + plan.reverts.length + plan.switches.length;
      if (acting === 0 || round > MAX_ROUNDS) {
        if (force.length > 0) await archiveRound(ctx, items, emptyPlan(), force);
        outcome.blocked = acting === 0 ? plan.blocked : [...plan.blocked, ...unconverged(plan)];
        break;
      }
      await archiveRound(ctx, items, plan, force);
      force = [];
      const removed = await executePlan(ctx, plan, items);
      const entries = [...plan.victims.map((v) => v.entry), ...plan.reverts.flatMap((r) => r.entries), ...plan.switches.map((s) => s.entry)];
      outcome.entries.push(...entries);
      recordRound(ctx, round, [...entries, ...plan.blocked], removed);
    }
  } finally {
    rmSync2(tmp, { recursive: true, force: true });
  }
  if (outcome.blocked.length > 0 && outcome.archiveDir) recordRound(ctx, 0, outcome.blocked, []);
  return outcome;
}
function emptyPlan() {
  return { victims: [], reverts: [], switches: [], blocked: [], notes: [] };
}
function unconverged(plan) {
  const reason = `${MAX_ROUNDS} \u8F6E\u5904\u7406\u540E\u4ECD\u672A\u6536\u655B`;
  return [
    ...plan.victims.map(({ entry }) => ({ ...entry, action: "blocked", reason })),
    ...plan.reverts.flatMap((r) => r.entries.map((entry) => ({ ...entry, action: "blocked", reason }))),
    ...plan.switches.map(({ entry }) => ({ ...entry, action: "blocked", reason }))
  ];
}
function peg(p) {
  return p.includes("@") ? `${p}@` : p;
}
async function statusItems(ctx, target) {
  const result = await ctx.o.run(["status", "--xml", peg(target)], { allowFail: target !== ctx.o.wc });
  return parseStatusItems(result.stdout).map((item) => ({ rel: ctx.rel(item.path), item }));
}
function fold(p) {
  return process.platform === "win32" ? p.toLowerCase() : p;
}
function isUnder(rel, parent) {
  if (parent === ".") return true;
  const a = fold(rel);
  const b = fold(parent);
  return a === b || a.startsWith(`${b}/`);
}
function isDirty(it) {
  return DIRTY.has(it.item) || it.props === "modified";
}
function isVictim(it) {
  return it.item === "conflicted" || it.props === "conflicted" || it.treeConflicted;
}
async function planRound(ctx, items) {
  const { o, discard } = ctx;
  const plan = emptyPlan();
  const victims = await readVictims(ctx, items.filter((x) => isVictim(x.item)));
  const pairs = /* @__PURE__ */ new Map();
  const pairOf = (v) => {
    let p = pairs.get(v.rel);
    if (!p) {
      p = contentPair(ctx, v);
      pairs.set(v.rel, p);
    }
    return p;
  };
  for (const v of victims) {
    const cat = categoryOf(o.rules, v.rel);
    const base = { path: v.rel, what: v.what, ...cat ? { category: cat.name } : {} };
    if (v.item.item === "obstructed") {
      plan.blocked.push({ ...base, action: "blocked", reason: `${v.what}\uFF0C\u4E14\u8DEF\u5F84\u88AB\u963B\u788D\uFF08obstructed\uFF09` });
      continue;
    }
    if (cat && discard.has(cat.name)) {
      plan.victims.push({ victim: v, entry: { ...base, rule: `discard:${cat.name}`, action: "theirs" }, archive: !o.rules.always.includes(cat.name) });
      continue;
    }
    let hit;
    for (const rule of o.rules.rules) {
      if (!ruleMatchesPath(rule, v.rel)) continue;
      if (await rulePasses(ctx, rule, v, items, pairOf)) {
        hit = rule;
        break;
      }
    }
    if (hit) {
      plan.victims.push({ victim: v, entry: { ...base, rule: hit.id, action: "theirs" }, archive: true });
      continue;
    }
    const why = !cat ? "\u4E0D\u5C5E\u4E8E\u53EF\u4E22\u5F03\u7C7B\u522B" : o.rules.optional.includes(cat.name) ? `\u7C7B\u522B ${cat.name} \u672A\u5F00\u542F\u4E22\u5F03` : `\u7C7B\u522B ${cat.name} \u4E0D\u53EF\u4E22\u5F03`;
    plan.blocked.push({ ...base, action: "blocked", reason: `${v.what}\uFF0C\u672A\u547D\u4E2D\u89C4\u5219\uFF0C${why}` });
  }
  for (const x of items) {
    if (x.item.item === "obstructed" && !isVictim(x.item)) {
      const cat = categoryOf(o.rules, x.rel);
      plan.blocked.push({ path: x.rel, what: "\u8DEF\u5F84\u88AB\u963B\u788D", ...cat ? { category: cat.name } : {}, action: "blocked", reason: "\u8DEF\u5F84\u88AB\u963B\u788D\uFF08obstructed\uFF09" });
    }
  }
  const victimRels = victims.map((v) => v.rel);
  const groups = /* @__PURE__ */ new Map();
  for (const x of items) {
    if (!isDirty(x.item) || isVictim(x.item) || x.item.item === "obstructed") continue;
    if (victimRels.some((v) => isUnder(x.rel, v))) continue;
    const cat = categoryOf(o.rules, x.rel);
    if (!cat || !discard.has(cat.name)) continue;
    const group = groups.get(cat.prefix) ?? { cat: cat.name, entries: [] };
    group.entries.push({ path: x.rel, what: localWhat(x.item), category: cat.name, rule: `discard:${cat.name}`, action: "revert" });
    groups.set(cat.prefix, group);
  }
  for (const [prefix, group] of groups) {
    const archive = !o.rules.always.includes(group.cat);
    if (plan.blocked.some((b) => isUnder(b.path, prefix) || isUnder(prefix, b.path))) {
      for (const entry of group.entries) plan.reverts.push({ target: entry.path, entries: [entry], archive });
    } else {
      plan.reverts.push({ target: prefix, entries: group.entries, archive });
    }
  }
  for (const x of items) {
    if (!x.item.switched || x.rel === ".") continue;
    const cat = categoryOf(o.rules, x.rel);
    if (cat && discard.has(cat.name)) {
      plan.switches.push({ rel: x.rel, entry: { path: x.rel, what: "switched \u5230\u5176\u4ED6 URL", category: cat.name, rule: `discard:${cat.name}`, action: "switch-back" } });
    } else {
      plan.notes.push(`${x.rel} \u88AB switch \u5230\u5176\u4ED6 URL\uFF0C\u4E0D\u5C5E\u4E8E\u53EF\u4E22\u5F03\u7C7B\u522B\uFF0C\u4FDD\u6301\u4E0D\u52A8`);
    }
  }
  return plan;
}
function localWhat(it) {
  const label = { modified: "\u672C\u5730\u4FEE\u6539", added: "\u672C\u5730\u65B0\u589E", deleted: "\u672C\u5730\u5220\u9664", replaced: "\u672C\u5730\u66FF\u6362", missing: "\u672C\u5730\u7F3A\u5931" };
  return label[it.item] ?? (it.props === "modified" ? "\u672C\u5730\u5C5E\u6027\u4FEE\u6539" : it.item);
}
async function readVictims(ctx, list) {
  const infos = /* @__PURE__ */ new Map();
  for (let i = 0; i < list.length; i += 50) {
    const batch = list.slice(i, i + 50);
    const result = await ctx.o.run(["info", "--xml", ...batch.map((x) => peg(ctx.abs(x.rel)))], { allowFail: true });
    for (const [p, info] of parseConflictInfo(result.stdout)) infos.set(fold(ctx.rel(p)), info);
  }
  return list.map((x) => {
    const info = infos.get(fold(x.rel)) ?? {};
    const text = x.item.item === "conflicted" && !x.item.treeConflicted ? true : Boolean(info.text);
    const props = x.item.props === "conflicted";
    const tree = x.item.treeConflicted;
    return { rel: x.rel, item: x.item, text, props, tree, info, what: describeConflict({ text, props, tree, info }) };
  });
}
function describeConflict(v) {
  const parts = [];
  if (v.tree) {
    const t = v.info.tree;
    parts.push(
      t ? `\u6811\u51B2\u7A81\uFF08${t.operation === "switch" ? "\u5207\u6362" : t.operation === "update" ? "\u66F4\u65B0" : t.operation}\u65F6\u8FDC\u7AEF${ACTION_LABEL[t.action] ?? t.action}\uFF0C\u672C\u5730${REASON_LABEL[t.reason] ?? t.reason}\uFF09` : "\u6811\u51B2\u7A81"
    );
  }
  if (v.text) parts.push("\u6587\u672C\u51B2\u7A81");
  if (v.props) parts.push("\u5C5E\u6027\u51B2\u7A81");
  return parts.join("+") || "\u51B2\u7A81";
}
function parseConflictInfo(xml) {
  const out = /* @__PURE__ */ new Map();
  const entryRe = /<entry\b([^>]*)>([\s\S]*?)<\/entry>/g;
  let m;
  while (m = entryRe.exec(xml)) {
    const p = attr2(m[1], "path");
    if (p === void 0) continue;
    const body = m[2];
    const info = {};
    const conflictRe = /<conflict\b([^>]*)>([\s\S]*?)<\/conflict>/g;
    let c;
    while (c = conflictRe.exec(body)) {
      const type = attr2(c[1], "type");
      const inner = c[2];
      const file = (tag) => {
        const v = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(inner)?.[1];
        return v === void 0 ? void 0 : decodeXml(v);
      };
      if (type === "text") info.text = { mine: file("prev-wc-file"), theirs: file("cur-base-file"), older: file("prev-base-file") };
      if (type === "property") info.propFile = file("prop-file");
      info.right ??= rightVersion(inner);
    }
    const tree = /<tree-conflict\b([^>]*)>([\s\S]*?)<\/tree-conflict>/.exec(body);
    if (tree) {
      info.tree = {
        action: attr2(tree[1], "action") ?? "",
        reason: attr2(tree[1], "reason") ?? "",
        operation: attr2(tree[1], "operation") ?? "",
        kind: attr2(tree[1], "kind") ?? ""
      };
      info.right = rightVersion(tree[2]) ?? info.right;
    }
    out.set(decodeXml(p), info);
  }
  return out;
}
function rightVersion(body) {
  const re = /<version\b([^>]*?)\/?>/g;
  let v;
  while (v = re.exec(body)) {
    if (attr2(v[1], "side") !== "source-right") continue;
    return {
      side: "source-right",
      kind: attr2(v[1], "kind") ?? "",
      pathInRepos: decodeXml(attr2(v[1], "path-in-repos") ?? ""),
      reposUrl: decodeXml(attr2(v[1], "repos-url") ?? ""),
      revision: Number(attr2(v[1], "revision") ?? -1)
    };
  }
  return void 0;
}
function attr2(source, name) {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(source)?.[1];
}
async function contentPair(ctx, v) {
  if (v.props) return void 0;
  const readFile = (file) => {
    if (!file) return void 0;
    try {
      return statSync(file).isFile() ? readFileSync2(file) : void 0;
    } catch {
      return void 0;
    }
  };
  if (v.text && !v.tree) {
    const local = readFile(v.info.text?.mine ?? ctx.abs(v.rel));
    const incoming = readFile(v.info.text?.theirs);
    return local && incoming ? { local, incoming } : void 0;
  }
  if (v.tree && !v.text) {
    const right = v.info.right;
    const local = readFile(ctx.abs(v.rel));
    if (!local || !right || right.kind !== "file" || right.revision < 0 || !right.reposUrl) return void 0;
    const url = `${right.reposUrl.replace(/\/+$/, "")}/${right.pathInRepos.split("/").map(encodeURIComponent).join("/")}@${right.revision}`;
    const out = path8.join(ctx.tmp, `incoming-${Math.random().toString(36).slice(2)}`);
    const result = await ctx.o.run(["export", "--force", url, out], { allowFail: true });
    const incoming = result.code === 0 ? readFile(out) : void 0;
    rmSync2(out, { force: true });
    return incoming ? { local, incoming } : void 0;
  }
  return void 0;
}
async function rulePasses(ctx, rule, v, items, pairOf) {
  if (rule.when === "local-equals-incoming") {
    const pair = await pairOf(v);
    return Boolean(pair && pair.local.equals(pair.incoming));
  }
  if (rule.when === "yaml-keys-only") {
    const pair = await pairOf(v);
    return Boolean(pair && sameExceptTopLevelKeys(pair.local, pair.incoming, rule.keys));
  }
  return localOnlyMissing(ctx, v, items);
}
function localOnlyMissing(ctx, v, items) {
  if (!v.tree || v.text || v.props || v.item.props === "modified") return false;
  const abs = ctx.abs(v.rel);
  const onDisk = existsSync5(abs);
  const isFile = onDisk && statSync(abs).isFile();
  const it = v.item.item;
  const selfOk = it === "missing" || it === "deleted" && !onDisk || it === "added" && v.item.copied && !isFile;
  if (!selfOk) return false;
  return items.every((x) => {
    if (x.rel === v.rel || !isUnder(x.rel, v.rel)) return true;
    return (x.item.item === "missing" || x.item.item === "deleted") && x.item.props !== "modified" && x.item.props !== "conflicted";
  });
}
async function archiveRound(ctx, items, plan, force) {
  const { o } = ctx;
  const diffTargets = [];
  const copies = [];
  const byRel = new Map(items.map((x) => [fold(x.rel), x.item]));
  const alwaysCat = (rel) => {
    const cat = categoryOf(o.rules, rel);
    return Boolean(cat && o.rules.always.includes(cat.name));
  };
  for (const { victim: v, archive } of plan.victims) {
    if (!archive) continue;
    const abs = ctx.abs(v.rel);
    diffTargets.push(v.rel);
    if (v.text) copies.push({ from: v.info.text?.mine ?? abs, to: v.rel });
    else if (existsSync5(abs)) copies.push({ from: abs, to: v.rel });
    if (v.props && v.info.propFile) copies.push({ from: v.info.propFile, to: `${v.rel}.prej` });
  }
  for (const r of plan.reverts) {
    if (!r.archive) continue;
    diffTargets.push(r.target);
    for (const e of r.entries) {
      const it = byRel.get(fold(e.path));
      if (it && (it.item === "modified" || it.item === "added" || it.item === "replaced")) copies.push({ from: ctx.abs(e.path), to: e.path });
    }
  }
  const forced = force.filter((rel) => !alwaysCat(rel));
  for (const rel of forced) {
    diffTargets.push(rel);
    copies.push({ from: ctx.abs(rel), to: rel });
  }
  const acting = plan.victims.length + plan.reverts.length + plan.switches.length;
  if (acting === 0 && forced.length === 0) return;
  const dir = ctx.archiveDir();
  writeReadme(ctx, dir);
  const uniqueTargets = [...new Set(diffTargets)];
  for (let i = 0; i < uniqueTargets.length; i += 50) {
    const batch = uniqueTargets.slice(i, i + 50).map((rel) => peg(ctx.abs(rel)));
    const diff = await o.run(["diff", "--internal-diff", ...batch], { allowFail: true });
    const text = toRelativePatch(diff.stdout, o.wc);
    if (text.trim()) appendFileSync2(path8.join(dir, "changes.patch"), text.endsWith("\n") ? text : `${text}
`, "utf8");
  }
  for (const { from, to } of copies) copyIntoArchive(from, path8.join(dir, "files", ...to.split("/")));
  if (forced.length > 0) {
    appendFileSync2(path8.join(dir, "versioned.txt"), forced.map((rel) => `${o.phase}	archive	\u5C06\u4E0E\u8FDC\u7AEF\u5408\u5E76\u7684\u672C\u5730\u4FEE\u6539	${rel}	
`).join(""), "utf8");
  }
}
function copyIntoArchive(from, to) {
  if (!existsSync5(from) || existsSync5(to)) return;
  mkdirSync5(path8.dirname(to), { recursive: true });
  cpSync(from, to, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (src) => path8.basename(src).toLowerCase() !== ".svn"
  });
}
function writeReadme(ctx, dir) {
  const file = path8.join(dir, "README.txt");
  if (existsSync5(file)) return;
  writeFileSync3(
    file,
    [
      "SVN \u89C4\u5219\u5904\u7406\u5B58\u6863",
      `\u5DE5\u4F5C\u526F\u672C\uFF1A${ctx.o.wc}`,
      `\u89C4\u5219\u6587\u4EF6\uFF1A${ctx.o.rules.file}`,
      `\u65F6\u95F4\uFF1A${ctx.o.now.toISOString()}`,
      "",
      "changes.patch  \u53D7\u63A7\u6539\u52A8\u7684 svn diff\uFF08\u8DEF\u5F84\u76F8\u5BF9\u5DE5\u4F5C\u526F\u672C\u6839\uFF09\uFF1B\u5728\u540C\u4E00\u5206\u652F\u7684\u5DE5\u4F5C\u526F\u672C\u6839\u6267\u884C svn patch changes.patch \u6062\u590D\u3002",
      "files/         \u88AB\u5904\u7406\u8DEF\u5F84\u7684\u672C\u5730\u7248\u672C\u539F\u6837\u62F7\u8D1D\uFF1A\u6587\u672C\u51B2\u7A81\u662F .mine\uFF08\u4E8C\u8FDB\u5236\u4E3A\u672C\u5730\u6587\u4EF6\uFF09\uFF0C\u6811\u51B2\u7A81\u662F\u78C1\u76D8\u4E0A\u7684\u5185\u5BB9\uFF0C\u5C5E\u6027\u51B2\u7A81\u53E6\u5B58 .prej\u3002",
      "versioned.txt  \u5904\u7406\u6E05\u5355\uFF08\u9636\u6BB5\u3001\u52A8\u4F5C\u3001\u73B0\u573A\u3001\u8DEF\u5F84\u3001\u89C4\u5219\uFF09\u3002",
      "unversioned.txt \u88AB\u5220\u9664\u7684\u51B2\u7A81\u9057\u7559\u6587\u4EF6\uFF08\u5DF2\u62F7\u8FDB files/\uFF09\u3002",
      "rules.json     \u6BCF\u8F6E\u5904\u7406\u660E\u7EC6\u3002",
      `\u603B\u662F\u4E22\u5F03\u7684\u7C7B\u522B\uFF08${ctx.o.rules.always.join("\u3001") || "\u65E0"}\uFF09\u662F\u53EF\u518D\u751F\u5185\u5BB9\uFF0C\u53EA\u8BB0\u6E05\u5355\uFF0C\u4E0D\u62F7\u5185\u5BB9\u3002`,
      ""
    ].join("\n"),
    "utf8"
  );
}
async function executePlan(ctx, plan, items) {
  const { o } = ctx;
  const removed = [];
  const unversioned = new Set(items.filter((x) => x.item.item === "unversioned").map((x) => fold(x.rel)));
  const victims = [...plan.victims].sort((a, b) => b.victim.rel.split("/").length - a.victim.rel.split("/").length);
  if (victims.length) o.onStage?.(`${o.phase}\uFF1A\u6309\u89C4\u5219\u5904\u7406 ${victims.length} \u4E2A\u51B2\u7A81`);
  for (const { victim: v, archive } of victims) {
    const abs = ctx.abs(v.rel);
    const artifacts = [v.info.text?.mine, v.info.text?.theirs, v.info.text?.older, v.info.propFile].filter((f) => Boolean(f));
    if (v.tree) {
      await o.run(["resolve", "--accept", "working", peg(abs)]);
      await o.run(["revert", "-R", peg(abs)]);
      await settleTree(ctx, v.rel, archive, removed);
    } else {
      await o.run(["resolve", "--accept", "theirs-full", peg(abs)]);
      await o.run(["revert", "--depth", "empty", peg(abs)]);
    }
    for (const file of artifacts) {
      const meta = `${file}.meta`;
      const rel = ctx.rel(meta);
      if (!unversioned.has(fold(rel)) || !existsSync5(meta)) continue;
      if (archive) copyIntoArchive(meta, path8.join(ctx.archiveDir(), "files", ...rel.split("/")));
      rmSync2(meta, { force: true });
      removed.push(rel);
    }
  }
  if (plan.reverts.length) {
    const count = plan.reverts.reduce((n, r) => n + r.entries.length, 0);
    o.onStage?.(`${o.phase}\uFF1A\u8FD8\u539F\u53EF\u4E22\u5F03\u7C7B\u522B\u7684 ${count} \u5904\u672C\u5730\u6539\u52A8`);
    const targets = plan.reverts.map((r) => r.target);
    for (let i = 0; i < targets.length; i += 50) {
      await o.run(["revert", "-R", ...targets.slice(i, i + 50).map((rel) => peg(ctx.abs(rel)))]);
    }
  }
  if (plan.switches.length) {
    o.onStage?.(`${o.phase}\uFF1A\u5207\u56DE ${plan.switches.length} \u4E2A switched \u8DEF\u5F84`);
    const root = await ctx.rootUrl();
    for (const { rel } of plan.switches) {
      const url = `${root}/${rel.split("/").map(encodeURIComponent).join("/")}`;
      await o.run(["switch", "--ignore-ancestry", "--accept", "postpone", url, peg(ctx.abs(rel))]);
    }
  }
  return removed;
}
async function settleTree(ctx, rel, archive, removed) {
  const abs = ctx.abs(rel);
  for (let i = 0; i < 2; i++) {
    if (!existsSync5(abs)) return;
    const items = await statusItems(ctx, abs);
    const self = items.find((x) => fold(x.rel) === fold(rel));
    if (self?.item.item === "unversioned") {
      if (archive) copyIntoArchive(abs, path8.join(ctx.archiveDir(), "files", ...rel.split("/")));
      rmSync2(abs, { recursive: true, force: true });
      removed.push(rel);
      return;
    }
    if (!items.some((x) => isDirty(x.item) || isVictim(x.item))) return;
    await ctx.o.run(["revert", "-R", peg(abs)]);
  }
}
function recordRound(ctx, round, entries, removed) {
  const acted = removed.length > 0 || entries.some((e) => e.action !== "blocked");
  const dir = acted ? ctx.archiveDir() : ctx.currentArchiveDir();
  if (!dir) return;
  const file = path8.join(dir, "rules.json");
  let runs = [];
  try {
    runs = JSON.parse(readFileSync2(file, "utf8"));
    if (!Array.isArray(runs)) runs = [];
  } catch {
    runs = [];
  }
  runs.push({ phase: ctx.o.phase, round: round || "final", time: (/* @__PURE__ */ new Date()).toISOString(), entries, removed });
  writeFileSync3(file, `${JSON.stringify(runs, null, 2)}
`, "utf8");
  const lines = entries.filter((e) => round > 0 ? e.action !== "blocked" : true).map((e) => `${ctx.o.phase}	${e.action}	${e.what}	${e.path}	${e.rule ?? e.reason ?? ""}
`).join("");
  if (lines) appendFileSync2(path8.join(dir, "versioned.txt"), lines, "utf8");
  if (removed.length) appendFileSync2(path8.join(dir, "unversioned.txt"), removed.map((r) => `${r}
`).join(""), "utf8");
}

// shared/svn-update.ts
async function svnCheckAndUpdate(options) {
  if (!existsSync6(options.workingCopy)) {
    throw new Error(`\u76EE\u5F55\u4E0D\u5B58\u5728: ${options.workingCopy}`);
  }
  if (!existsSync6(path9.join(options.workingCopy, ".svn"))) {
    throw new Error("\u4E0D\u662F SVN \u5DE5\u4F5C\u526F\u672C\uFF08\u7F3A\u5C11 .svn\uFF09");
  }
  const stage = (message) => options.onProgress?.(message, null);
  const policy = options.onConflict ?? "fail";
  const notes = [];
  const canRelease = options.releaseOccupants === true && process.platform === "win32";
  const rulesInput = options.rules;
  if (policy === "rules" && !rulesInput) {
    throw new Error("onConflict=rules \u9700\u8981\u63D0\u4F9B SVN \u89C4\u5219\u6587\u4EF6");
  }
  let rulesArchiveDir;
  const runRules = async (phase, forceArchive = []) => {
    const outcome = await applySvnRules({
      wc: options.workingCopy,
      cwd: options.workingCopy,
      run: (args, o) => runSvn(options, [...args, "--non-interactive"], `svn ${args[0]}`, o?.allowFail ?? false),
      rules: rulesInput.rules,
      enable: rulesInput.enable,
      archiveRoot: rulesInput.archiveRoot,
      archiveDir: rulesArchiveDir,
      now: rulesInput.now ?? /* @__PURE__ */ new Date(),
      phase,
      forceArchive,
      cleanupLocks: true,
      onStage: stage
    });
    rulesArchiveDir = outcome.archiveDir;
    for (const note of outcome.notes) if (!notes.includes(note)) notes.push(note);
    const summary = summarizeRules(outcome);
    if (summary) notes.push(`${phase}${summary}`);
    if (outcome.blocked.length > 0) throw new RulesBlockedError(outcome);
  };
  const done = (result) => rulesArchiveDir ? { ...result, rulesArchiveDir } : result;
  if (existsSync6(path9.join(options.workingCopy, ".svn", "lock"))) {
    if (policy !== "revert" && policy !== "rules") {
      throw new Error("\u5DE5\u4F5C\u526F\u672C\u6709 in-progress \u9501\uFF08.svn/lock\uFF09\uFF0C\u672A\u6267\u884C cleanup");
    }
    if (canRelease) {
      await releasePredicted(options, [], "in-progress \u9501");
    }
    await runSvn(options, ["cleanup"], "svn cleanup");
    notes.push("\u5DF2 svn cleanup \u89E3\u9664 in-progress \u9501");
  }
  stage("\u68C0\u67E5\u5DE5\u4F5C\u526F\u672C\u72B6\u6001");
  const status = await runSvn(options, ["status", "--xml"], "svn status");
  let statusXml = status.stdout;
  let incomingXml;
  if (!options.skipUpdate) {
    stage("\u67E5\u8BE2\u8FDC\u7AEF\u53D8\u66F4");
    const remote = await runSvn(options, ["status", "-u", "--xml"], "svn status -u", true);
    if (remote.code === 0 && remote.stdout.trim()) {
      incomingXml = remote.stdout;
      statusXml = incomingXml;
    } else {
      notes.push("\u65E0\u6CD5\u53D6\u5F97\u8FDC\u7AEF\u72B6\u6001\uFF0C\u4EC5\u6309\u672C\u5730 svn status \u4F30\u8BA1\u5199\u96C6");
    }
  }
  const predicted = predictWriteRelatives(statusXml, incomingXml, {
    skipUpdate: options.skipUpdate,
    willRevertProblems: policy === "revert" && Boolean(findSvnProblem(status.stdout)),
    extraLocal: policy === "rules" ? rulesLocalWrites(options.workingCopy, status.stdout, rulesInput) : []
  });
  logWriteSet(options.logFile, predicted, incomingXml ? "update" : "local");
  if (canRelease && predicted.rels.length > 0) {
    const released = await releasePredicted(options, predicted.rels, "svn-update \u5199\u96C6");
    if (released) {
      notes.push(released);
    }
  } else if (predicted.rels.length > 0 && !canRelease) {
    notes.push(
      `\u9884\u8BA1\u5199\u5165 ${predicted.rels.length} \u4E2A\u8DEF\u5F84\uFF08\u672A\u81EA\u52A8\u91CA\u653E\u5360\u7528\uFF1B\u53EF\u5C06 with.releaseOccupants \u8BBE\u4E3A true\uFF09`
    );
  }
  const problem = findSvnProblem(status.stdout);
  if (policy === "rules") {
    await runRules("\u66F4\u65B0\u524D", mergeTargets(options.workingCopy, incomingXml));
  } else if (problem) {
    if (policy === "postpone") {
      return {
        skipped: true,
        detail: `${problem}\uFF0C\u6309 onConflict=postpone \u4FDD\u7559\u73B0\u573A\u6302\u8D77\uFF0C\u5904\u7406\u5B8C\u4E0B\u8F6E\u81EA\u52A8\u7EE7\u7EED:
  ${conflictedRelatives(status.stdout)}`,
        code: 0
      };
    }
    if (policy !== "revert") {
      throw new Error(`${problem}\u3002\u5DF2\u4FDD\u7559\u73B0\u573A\uFF0C\u672A\u81EA\u52A8 cleanup/revert`);
    }
    const backup2 = await backupDirty(options, status.stdout);
    if (backup2) {
      notes.push(`\u51B2\u7A81/\u6539\u52A8\u5DF2\u5907\u4EFD\u5230 ${backup2}`);
    }
    if (canRelease) {
      await releasePredicted(options, revertWriteRelatives(parseSvnStatusXml(status.stdout)), "svn revert");
    }
    await resetWorkingCopy(options);
    notes.push("\u5DF2\u6309 onConflict=revert \u6267\u884C cleanup/revert");
  }
  if (options.skipUpdate) {
    return done({ skipped: true, detail: notes.join("\uFF1B") || "\u6309\u7B56\u7565\u8DF3\u8FC7 svn update", code: 0 });
  }
  stage(incomingXml ? `\u5F00\u59CB\u66F4\u65B0\uFF0C\u8FDC\u7AEF\u53D8\u66F4\u7EA6 ${predicted.incoming} \u4E2A\u8DEF\u5F84` : "\u5F00\u59CB\u66F4\u65B0");
  const counter = createUpdateProgress({
    total: incomingXml ? predicted.incoming : 0,
    emit: (message, percent) => options.onProgress?.(message, percent)
  });
  const updateConflicts = /* @__PURE__ */ new Set();
  const update = await runSvn(
    options,
    ["update", "--non-interactive", "--accept", "postpone"],
    "svn update",
    true,
    (line) => {
      counter.line(line);
      for (const rel of conflictedRelativesFromUpdateOutput(line)) updateConflicts.add(rel);
    }
  );
  if (update.code === 0) {
    counter.finish();
    const conflicts = [...updateConflicts];
    if (conflicts.length > 0 && policy === "rules") {
      notes.push(`svn update \u4EA7\u751F ${conflicts.length} \u4E2A\u51B2\u7A81\uFF0C\u6309\u89C4\u5219\u5904\u7406`);
      await runRules("\u66F4\u65B0\u540E");
    } else if (conflicts.length > 0 && policy === "postpone") {
      return {
        skipped: true,
        detail: `svn update \u4EA7\u751F ${conflicts.length} \u4E2A\u51B2\u7A81\uFF0C\u6309 onConflict=postpone \u4FDD\u7559\u73B0\u573A\u6302\u8D77\uFF0C\u5904\u7406\u5B8C\u4E0B\u8F6E\u81EA\u52A8\u7EE7\u7EED:
  ${conflicts.slice(0, 20).join("\n  ")}`,
        code: 0
      };
    } else if (conflicts.length > 0) {
      throw new Error(`svn update \u4EA7\u751F ${conflicts.length} \u4E2A\u51B2\u7A81:
  ${conflicts.slice(0, 20).join("\n  ")}`);
    }
    notes.push(tail2(update.stdout) || "svn update \u5B8C\u6210");
    return done({ skipped: false, detail: notes.join("\uFF1B"), code: update.code });
  }
  const updateProblem = findSvnProblem(update.stdout + update.stderr) ?? tail2(update.stderr) ?? `svn update \u9000\u51FA\u7801 ${update.code}`;
  const lockHit = isSvnLockError(update.stdout + update.stderr);
  if (canRelease && lockHit) {
    const extra = pathsFromSvnError(`${update.stdout}
${update.stderr}`).map(
      (item) => path9.isAbsolute(item) ? path9.relative(options.workingCopy, item) : item
    );
    notes.push("\u66F4\u65B0\u88AB\u6587\u4EF6\u72EC\u5360\u6253\u65AD\uFF0Ccleanup \u5E76\u91CA\u653E\u5360\u7528\u540E\u91CD\u8BD5");
    await runSvn(options, ["cleanup"], "svn cleanup", true);
    await releasePredicted(options, [...predicted.rels, ...extra], "update \u72EC\u5360\u91CD\u8BD5");
    const retry2 = await runSvn(options, ["update", "--non-interactive", "--accept", "postpone"], "svn update retry", true);
    if (retry2.code === 0) {
      notes.push("\u91CA\u653E\u5360\u7528\u540E\u5DF2\u91CD\u65B0 update");
      if (policy === "rules") await runRules("\u66F4\u65B0\u540E");
      return done({ skipped: false, detail: [...notes, tail2(retry2.stdout) || "svn update \u5B8C\u6210"].join("\uFF1B"), code: retry2.code });
    }
  }
  if (policy !== "revert") {
    throw new Error(updateProblem);
  }
  const backup = await backupDirty(
    options,
    (await runSvn(options, ["status", "--xml"], "svn status", true)).stdout
  );
  if (backup) {
    notes.push(`\u66F4\u65B0\u5931\u8D25\u540E\u7684\u6539\u52A8\u5DF2\u5907\u4EFD\u5230 ${backup}`);
  }
  if (canRelease) {
    await releasePredicted(options, predicted.rels, "update \u5931\u8D25\u540E revert");
  }
  await resetWorkingCopy(options);
  const retry = await runSvn(options, ["update"], "svn update retry");
  notes.push("revert \u540E\u5DF2\u91CD\u65B0 update");
  return { skipped: false, detail: [...notes, tail2(retry.stdout) || "svn update \u5B8C\u6210"].join("\uFF1B"), code: retry.code };
}
async function svnRevertTree(options) {
  const status = await runSvn(options, ["status", "--xml"], "svn status", true);
  const rels = revertWriteRelatives(parseSvnStatusXml(status.stdout));
  logWriteSet(options.logFile, { rels, incoming: 0, local: rels.length }, "revert");
  if (options.releaseOccupants === true && process.platform === "win32") {
    await releasePredicted(options, rels, "svn revert \u5199\u96C6");
  }
  const args = ["revert", ...options.recursive === false ? [] : ["-R"], "."];
  const result = await runSvn(options, args, "svn revert");
  return { detail: tail2(result.stdout) || "svn revert \u5B8C\u6210", code: result.code };
}
function predictWriteRelatives(localXml, incomingXml, options) {
  const localEntries = parseSvnStatusXml(localXml);
  const local = revertWriteRelatives(localEntries);
  const extra = options.extraLocal ?? [];
  if (options.skipUpdate) {
    return {
      rels: options.willRevertProblems ? local : extra,
      incoming: 0,
      local: local.length
    };
  }
  const incomingEntries = parseSvnStatusXml(incomingXml ?? localXml);
  const incoming = updateWriteRelatives(incomingEntries, false);
  const rels = options.willRevertProblems ? [.../* @__PURE__ */ new Set([...incoming, ...local])] : [.../* @__PURE__ */ new Set([...incoming, ...extra])];
  return { rels, incoming: incoming.length, local: local.length };
}
function rulesLocalWrites(wc, localXml, input) {
  const discard = discardSet(input.rules, input.enable);
  const out = [];
  for (const it of parseStatusItems(localXml)) {
    const rel = relativeTo(wc, it.path, wc);
    if (rel === ".") continue;
    const conflicted = it.item === "conflicted" || it.props === "conflicted" || it.treeConflicted;
    const dirty = conflicted || ["modified", "added", "deleted", "replaced", "missing"].includes(it.item) || it.props === "modified";
    if (!dirty) continue;
    const cat = categoryOf(input.rules, rel);
    if (conflicted || cat && discard.has(cat.name)) out.push(relativeFromStatusPath(rel));
  }
  return out;
}
function mergeTargets(wc, incomingXml) {
  if (!incomingXml) return [];
  const incoming = /* @__PURE__ */ new Set(["modified", "replaced", "deleted"]);
  return parseSvnStatusXml(incomingXml).filter((e) => (e.wcItem === "modified" || e.wcItem === "replaced") && e.reposItem !== void 0 && incoming.has(e.reposItem)).map((e) => relativeTo(wc, e.path.replace(/\\/g, "/"), wc)).filter((rel) => rel !== ".");
}
function logWriteSet(logFile, predicted, kind) {
  const preview = predicted.rels.slice(0, 30).join("\n  ");
  const extra = predicted.rels.length > 30 ? `
  \u2026\u5171 ${predicted.rels.length} \u4E2A` : "";
  appendLog(
    logFile,
    `[novoard-packs] svn \u5199\u96C6(${kind}) incoming=${predicted.incoming} localDirty=${predicted.local} probe=${predicted.rels.length}` + (preview ? `
  ${preview}${extra}` : " (\u65E0)")
  );
}
async function releasePredicted(options, rels, label) {
  const extraFiles = resolveWriteTargets(options.workingCopy, rels);
  const prepared = await prepareExclusiveAccess({
    target: options.workingCopy,
    abortSignal: options.abortSignal,
    extraFiles,
    includeUnityByName: false
  });
  const closed = prepared.closed.map((item) => `${item.name}(${item.pid})`).join(", ");
  appendLog(
    options.logFile,
    `[novoard-packs] ${label} \u91CA\u653E\u5360\u7528 closed=${prepared.closed.length}${closed ? ` ${closed}` : ""} remaining=${prepared.remaining.length}`
  );
  if (prepared.remaining.length > 0) {
    const names = prepared.remaining.map((item) => `${item.name}(${item.pid})`).join(", ");
    throw new Error(`\u65E0\u6CD5\u91CA\u653E SVN \u5199\u8DEF\u5F84\u5360\u7528: ${names}`);
  }
  if (prepared.remainingLocks.length > 0) {
    throw new Error(`\u65E0\u6CD5\u91CA\u653E Unity \u9879\u76EE\u9501: ${prepared.remainingLocks.join(", ")}`);
  }
  if (prepared.closed.length === 0) {
    return void 0;
  }
  return `\u5DF2\u7ED3\u675F\u5360\u7528\u8FDB\u7A0B ${closed}`;
}
async function runSvn(options, args, label, allowFail = false, onStdoutLine) {
  const result = await runCommand({
    command: "svn",
    args,
    cwd: options.workingCopy,
    timeoutMs: args.includes("status") ? Math.min(options.timeoutMs, 10 * 6e4) : options.timeoutMs,
    logFile: options.logFile,
    abortSignal: options.abortSignal,
    gracefulMs: SVN_GRACEFUL_MS,
    onStdoutLine,
    // status/info/diff/list 的输出要整份解析（写集预测、冲突判断、存档）；update/revert 输出只看尾部
    fullStdout: ["status", "info", "diff", "list"].includes(args[0])
  }).done;
  if (result.cancelled) {
    const note = await cleanupAfterInterrupt(args, { cwd: options.workingCopy, logFile: options.logFile });
    throw new Error(`${result.timedOut ? `${label} \u8D85\u65F6` : "\u5DF2\u53D6\u6D88"}${note}`);
  }
  if (!allowFail && result.code !== 0) {
    throw new Error(tail2(result.stderr) || `${label} \u9000\u51FA\u7801 ${result.code}`);
  }
  return result;
}
async function resetWorkingCopy(options) {
  await runSvn(options, ["cleanup"], "svn cleanup", true);
  await runSvn(options, ["revert", "-R", "."], "svn revert");
  await runSvn(options, ["cleanup", "--remove-unversioned", "--remove-ignored"], "svn cleanup unversioned", true);
}
async function backupDirty(options, statusXml) {
  if (options.backupOnRevert === false) {
    return void 0;
  }
  const rels = revertWriteRelatives(parseSvnStatusXml(statusXml)).filter((rel) => !shouldSkipBackup(rel));
  const root = resolveBackupRoot(options.workingCopy, options.backupDir);
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const destRoot = path9.join(root, options.localDate ?? stamp.slice(0, 10), stamp);
  mkdirSync6(destRoot, { recursive: true });
  const copied = [];
  for (const rel of rels) {
    const from = path9.join(options.workingCopy, rel);
    if (!existsSync6(from)) {
      continue;
    }
    const to = path9.join(destRoot, rel);
    mkdirSync6(path9.dirname(to), { recursive: true });
    cpSync2(from, to, {
      recursive: true,
      force: true,
      filter: (src) => !shouldSkipBackup(path9.relative(options.workingCopy, src))
    });
    copied.push(rel);
  }
  writeFileSync4(path9.join(destRoot, "manifest.txt"), copied.join("\n") || "(\u6CA1\u6709\u53EF\u5907\u4EFD\u7684\u810F\u6587\u4EF6)", "utf8");
  return destRoot;
}
function resolveBackupRoot(workingCopy, backupDir) {
  if (backupDir) {
    return path9.isAbsolute(backupDir) ? backupDir : path9.resolve(workingCopy, backupDir);
  }
  return `${workingCopy.replace(/[\\/]+$/, "")}_backup`;
}
function shouldSkipBackup(rel) {
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return norm === ".svn" || norm.startsWith(".svn/") || norm === "Library" || norm.startsWith("Library/") || norm === "Temp" || norm.startsWith("Temp/") || norm === "Logs" || norm.startsWith("Logs/") || norm.includes("/Library/") || norm.includes("/Temp/");
}
function conflictedRelatives(statusXml) {
  const rels = parseSvnStatusXml(statusXml).filter((entry) => entry.wcItem === "conflicted").map((entry) => relativeFromStatusPath(entry.path));
  return rels.length > 0 ? rels.slice(0, 20).join("\n  ") : "(status \u672A\u6807\u51FA\u51B2\u7A81\u6761\u76EE)";
}
function findSvnProblem(xml) {
  if (/item="conflicted"/.test(xml) || />conflicted</.test(xml) || /props="conflicted"/.test(xml) || /tree-conflicted="true"/.test(xml)) {
    return "\u5DE5\u4F5C\u526F\u672C\u5B58\u5728\u51B2\u7A81";
  }
  if (/item="obstructed"/.test(xml)) {
    return "\u5DE5\u4F5C\u526F\u672C\u5B58\u5728 obstructed \u8DEF\u5F84";
  }
  if (/item="incomplete"/.test(xml)) {
    return "\u5DE5\u4F5C\u526F\u672C\u4E0D\u5B8C\u6574";
  }
  if (/wc-locked="true"/.test(xml)) {
    return "\u5DE5\u4F5C\u526F\u672C\u88AB\u9501\u5B9A";
  }
  return void 0;
}
function tail2(text) {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-8).join("\n");
}

// packs/versionControl/src/index.ts
var byId = new Map(manifest.tools.map((t) => [t.id, t]));
async function run(toolId, rawParams, ctx) {
  const tool = byId.get(toolId);
  if (!tool) {
    throw new Error(`versionControl \u6CA1\u6709\u5DE5\u5177: ${toolId}`);
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
          ...params.removeUnversioned === true ? ["--remove-unversioned", "--remove-ignored"] : []
        ],
        "svn cleanup"
      );
    case "svn-revert":
      return svnRevertTree({
        workingCopy: ctx.cwd,
        timeoutMs: ctx.timeoutMs,
        logFile: ctx.logFile,
        abortSignal: ctx.abortSignal,
        recursive: params.recursive !== false,
        releaseOccupants: params.releaseOccupants !== false
      });
    case "svn-switch":
      return runSvnArgs(ctx, ["switch", String(params.url)], "svn switch");
    case "svn-copy":
      return runSvnArgs(
        ctx,
        ["copy", String(params.source), String(params.destination), "-m", String(params.message)],
        "svn copy",
        true
      );
    case "svn-delete":
      return runSvnArgs(ctx, ["delete", String(params.target), "-m", String(params.message)], "svn delete", true);
    default:
      throw new Error(`\u672A\u5B9E\u73B0\u5DE5\u5177: ${toolId}`);
  }
}
async function runSvnUpdate(params, ctx) {
  const strategy = String(params.strategy ?? "follow-latest");
  if (strategy === "disabled") {
    return { detail: "strategy=disabled\uFF0C\u8DF3\u8FC7", code: 0, skipped: true };
  }
  const onConflict = params.onConflict ?? "fail";
  const backupDir = typeof params.backupDir === "string" && params.backupDir ? params.backupDir : void 0;
  let rules;
  if (onConflict === "rules") {
    const file = typeof params.rulesFile === "string" ? params.rulesFile.trim() : "";
    if (!file) {
      throw new Error("onConflict=rules \u9700\u8981\u586B rulesFile\uFF08svn-rules.toml \u7684\u7EDD\u5BF9\u8DEF\u5F84\uFF09");
    }
    const enable = Array.isArray(params.rulesEnable) ? params.rulesEnable.map(String) : [];
    const loaded = loadSvnRules(path10.isAbsolute(file) ? file : path10.resolve(ctx.cwd, file));
    discardSet(loaded, enable);
    const now = /* @__PURE__ */ new Date();
    rules = {
      rules: loaded,
      enable,
      archiveRoot: path10.join(resolveBackupRoot(ctx.cwd, backupDir), ctx.localDate ?? now.toISOString().slice(0, 10), "rules"),
      now
    };
  }
  const result = await svnCheckAndUpdate({
    workingCopy: ctx.cwd,
    timeoutMs: ctx.timeoutMs,
    logFile: ctx.logFile,
    abortSignal: ctx.abortSignal,
    skipUpdate: false,
    onConflict,
    rules,
    backupOnRevert: params.backupOnRevert !== false,
    backupDir,
    localDate: ctx.localDate,
    releaseOccupants: params.releaseOccupants !== false,
    onProgress: ctx.onProgress
  });
  const detail = result.rulesArchiveDir ? `${result.detail}
\u89C4\u5219\u5B58\u6863: ${result.rulesArchiveDir}` : result.detail;
  return { detail, code: result.code, skipped: result.skipped };
}
async function runSvnArgs(ctx, args, label, allowUrlCwd = false) {
  const result = await runCommand({
    command: "svn",
    args,
    cwd: allowUrlCwd ? ctx.workspacePath : ctx.cwd,
    timeoutMs: ctx.timeoutMs,
    logFile: ctx.logFile,
    abortSignal: ctx.abortSignal,
    gracefulMs: SVN_GRACEFUL_MS
  }).done;
  if (result.cancelled) {
    const note = allowUrlCwd ? "" : await cleanupAfterInterrupt(args, { cwd: ctx.cwd, logFile: ctx.logFile });
    throw new Error(`${result.timedOut ? `${label} \u8D85\u65F6` : "\u5DF2\u53D6\u6D88"}${note}`);
  }
  if (result.code !== 0) {
    throw new Error(tail3(result.stderr || result.stdout) || `${label} \u9000\u51FA\u7801 ${result.code}`);
  }
  return { detail: tail3(result.stdout) || `${label} \u5B8C\u6210`, code: result.code };
}
function tail3(text) {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-8).join("\n");
}
if (isCliEntry(import.meta.url)) {
  await main(manifest, run);
}
export {
  manifest,
  run
};
