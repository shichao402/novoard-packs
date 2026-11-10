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
      writeResult(parsed.resultJson, { detail });
      err(detail);
      return EXIT.FAIL;
    }
    writeResult(parsed.resultJson, { detail: result.detail, ...result.skipped ? { skipped: true } : {} });
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
  const code = await runCli(manifest2, run2, process.argv.slice(2));
  process.stdout.write("", () => process.exit(code));
}

// shared/exec.ts
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync as mkdirSync2 } from "node:fs";
import path2 from "node:path";
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
    let stdout = "";
    let stderr = "";
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
      resolve({ stdout, stderr, code, timedOut, cancelled });
    };
    const onAbort = () => {
      cancelled = true;
      forceKill();
    };
    if (!ignoreOutput) {
      proc.stdout?.setEncoding("utf8");
      proc.stderr?.setEncoding("utf8");
      proc.stdout?.on("data", (chunk) => {
        stdout = cap(stdout + chunk);
      });
      proc.stderr?.on("data", (chunk) => {
        stderr = cap(stderr + chunk);
      });
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
  let stdout = "";
  let stderr = "";
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
      resolve({ code, signal, stdout, stderr, cancelled, timedOut });
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
      stdio: ["ignore", "pipe", "pipe"]
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
    proc.stdout?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout = cap(stdout + text);
      log.write(chunk);
      emitLines(text, false);
    });
    proc.stderr?.on("data", (chunk) => {
      stderr = cap(stderr + chunk.toString("utf8"));
      log.write(chunk);
    });
    proc.on("error", (error) => {
      const message = `${error.message}
`;
      stderr = cap(stderr + message);
      log.write(message);
      finish(1, null);
    });
    proc.on("close", (code, signal) => {
      emitLines("", true);
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
function cap(text, max = 2e5) {
  if (text.length <= max) {
    return text;
  }
  return text.slice(text.length - max);
}

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
    params: [{ name: "path", type: "string", description: "\u76F8\u5BF9\u5DE5\u4F5C\u76EE\u5F55\u7684\u5B50\u8DEF\u5F84" }]
  },
  {
    id: "git-fetch",
    displayName: "Git Fetch",
    description: "\u62C9\u53D6\u8FDC\u7AEF\u5F15\u7528\uFF0C\u4E0D\u5408\u5E76",
    idempotent: true,
    supportsDryRun: true,
    params: [
      { name: "remote", type: "string", description: "\u8FDC\u7AEF\u540D\uFF1B\u7559\u7A7A\u5219 --all" },
      { name: "prune", type: "boolean", default: true, description: "\u5220\u9664\u8FDC\u7AEF\u5DF2\u4E0D\u5B58\u5728\u7684\u8DDF\u8E2A\u5206\u652F" },
      { name: "path", type: "string" }
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
        description: "follow-latest \u6BCF\u6B21\u62C9\u53D6\uFF1Bmanual \u4EC5\u624B\u52A8\u89E6\u53D1\uFF1Bdisabled \u8DF3\u8FC7"
      },
      { name: "remote", type: "string", description: "\u8FDC\u7AEF\u540D\uFF0C\u9ED8\u8BA4 origin\uFF08\u6307\u5B9A branch \u65F6\uFF09" },
      { name: "branch", type: "string", description: "\u5206\u652F\u540D\uFF1B\u7559\u7A7A\u5219\u62C9\u5F53\u524D\u5206\u652F\u7684\u4E0A\u6E38" },
      { name: "ffOnly", type: "boolean", default: true, description: "\u4EC5\u5FEB\u8FDB\uFF0C\u907F\u514D\u81EA\u52A8\u5408\u5E76\u63D0\u4EA4" },
      { name: "rebase", type: "boolean", default: false },
      { name: "path", type: "string" }
    ]
  },
  {
    id: "git-checkout",
    displayName: "Git Checkout",
    description: "\u5207\u6362\u5206\u652F\u6216\u68C0\u51FA\u6307\u5B9A\u5F15\u7528",
    idempotent: false,
    requiresExclusiveWorkspace: true,
    params: [
      { name: "ref", type: "string", required: true, description: "\u5206\u652F\u3001tag \u6216 commit" },
      { name: "create", type: "boolean", default: false, description: "\u4E0D\u5B58\u5728\u5219\u65B0\u5EFA\u5206\u652F\uFF08-b\uFF09" },
      { name: "path", type: "string" }
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
        required: true
      },
      { name: "message", type: "string", description: "push \u65F6\u7684\u8BF4\u660E" },
      { name: "includeUntracked", type: "boolean", default: false, description: "push \u65F6\u5305\u542B\u672A\u8DDF\u8E2A\u6587\u4EF6" },
      { name: "path", type: "string" }
    ]
  },
  {
    id: "git-clean",
    displayName: "Git Clean",
    description: "\u5220\u9664\u672A\u8DDF\u8E2A\u6587\u4EF6",
    idempotent: true,
    requiresExclusiveWorkspace: true,
    params: [
      { name: "directories", type: "boolean", default: true, description: "\u540C\u65F6\u5220\u9664\u672A\u8DDF\u8E2A\u76EE\u5F55\uFF08-d\uFF09" },
      { name: "ignored", type: "boolean", default: false, description: "\u540C\u65F6\u5220\u9664\u88AB ignore \u7684\u6587\u4EF6\uFF08-x\uFF09" },
      { name: "path", type: "string" }
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
        description: "mixed \u4FDD\u7559\u5DE5\u4F5C\u533A\u6539\u52A8\uFF1Bhard \u4E22\u5F03\u672C\u5730\u6539\u52A8"
      },
      { name: "ref", type: "string", default: "HEAD", description: "\u91CD\u7F6E\u5230\u7684\u5F15\u7528" },
      { name: "path", type: "string" }
    ]
  },
  {
    id: "git-commit",
    displayName: "Git Commit",
    description: "\u63D0\u4EA4\u672C\u5730\u6539\u52A8",
    idempotent: false,
    requiresExclusiveWorkspace: true,
    params: [
      { name: "message", type: "string", required: true },
      { name: "all", type: "boolean", default: true, description: "\u63D0\u4EA4\u524D git add -A" },
      { name: "allowEmpty", type: "boolean", default: false },
      { name: "path", type: "string" }
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
      { name: "remote", type: "string", default: "origin" },
      { name: "ref", type: "string", description: "\u8981\u63A8\u9001\u7684\u5F15\u7528\uFF1B\u7559\u7A7A\u5219\u63A8\u5F53\u524D\u5206\u652F" },
      { name: "setUpstream", type: "boolean", default: false },
      {
        name: "force",
        type: "boolean",
        default: false,
        description: "\u4F7F\u7528 --force-with-lease\uFF0C\u907F\u514D\u8986\u76D6\u672A\u77E5\u8FDC\u7AEF\u63D0\u4EA4"
      },
      { name: "path", type: "string" }
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
      required: true
    },
    {
      name: "onConflict",
      type: "enum",
      enum: ["fail", "postpone", "revert"],
      default: "fail",
      description: "fail: \u51B2\u7A81\u5373\u5931\u8D25\uFF1Bpostpone: \u4FDD\u7559\u73B0\u573A\u6302\u8D77\u672C\u8F6E\uFF0C\u4E0B\u8F6E\u81EA\u52A8\u7EE7\u7EED\uFF1Brevert: \u5907\u4EFD\u540E\u8FD8\u539F"
    },
    { name: "backupOnRevert", type: "boolean", default: true },
    { name: "backupDir", type: "string" },
    {
      name: "releaseOccupants",
      type: "boolean",
      default: true,
      description: "\u6309\u672C\u6B21\u5C06\u5199\u5165\u7684\u6587\u4EF6\u91CA\u653E\u5360\u7528\uFF1B\u72EC\u5360\u5931\u8D25\u4F1A cleanup \u540E\u91CD\u8BD5\u4E00\u6B21\u3002\u4E0D\u60F3\u5F3A\u6740\u5C31\u5173\u6389"
    },
    { name: "path", type: "string" }
  ]
};
var svnCleanup = {
  id: "svn-cleanup",
  displayName: "SVN Cleanup",
  idempotent: true,
  requiresExclusiveWorkspace: true,
  params: [
    { name: "removeUnversioned", type: "boolean", default: false },
    { name: "path", type: "string" }
  ]
};
var svnRevert = {
  id: "svn-revert",
  displayName: "SVN Revert",
  description: "\u6309 svn status \u7684\u672C\u5730\u6539\u52A8\u4F30\u8BA1\u5C06\u6539\u5199\u7684\u6587\u4EF6\uFF1BWindows \u4E0A\u53EF\u5148\u91CA\u653E\u5360\u7528",
  idempotent: true,
  requiresExclusiveWorkspace: true,
  params: [
    { name: "recursive", type: "boolean", default: true },
    {
      name: "releaseOccupants",
      type: "boolean",
      default: true,
      description: "\u6309\u672C\u5730\u810F\u6587\u4EF6\u91CA\u653E\u5360\u7528\u3002\u4E0D\u60F3\u5F3A\u6740\u5C31\u5173\u6389"
    },
    { name: "path", type: "string" }
  ]
};
var svnSwitch = {
  id: "svn-switch",
  displayName: "SVN Switch",
  idempotent: false,
  requiresExclusiveWorkspace: true,
  remoteWrite: false,
  params: [
    { name: "url", type: "string", required: true },
    { name: "path", type: "string" }
  ]
};
var svnCopy = {
  id: "svn-copy",
  displayName: "SVN Copy\uFF08\u8FDC\u7AEF\u5199\uFF09",
  idempotent: false,
  remoteWrite: true,
  params: [
    { name: "source", type: "string", required: true },
    { name: "destination", type: "string", required: true },
    { name: "message", type: "string", required: true }
  ]
};
var svnDelete = {
  id: "svn-delete",
  displayName: "SVN Delete\uFF08\u8FDC\u7AEF\u5199\uFF09",
  idempotent: false,
  remoteWrite: true,
  params: [
    { name: "target", type: "string", required: true },
    { name: "message", type: "string", required: true }
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

// packs/versionControl/src/svn.ts
import { appendFileSync, cpSync, existsSync as existsSync4, mkdirSync as mkdirSync3, writeFileSync as writeFileSync3 } from "node:fs";
import path6 from "node:path";

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
  const found = path4.resolve(here, "../scripts/list-occupants.ps1");
  if (!existsSync2(found)) {
    throw new Error(`\u627E\u4E0D\u5230 ${found}`);
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

// packs/versionControl/src/svn-status.ts
import { existsSync as existsSync3 } from "node:fs";
import path5 from "node:path";
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
function decodeXml(value) {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function relativeFromStatusPath(entryPath) {
  return entryPath.replace(/\//g, path5.sep);
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
  return LOCK_PRONE_EXT.has(path5.extname(rel).toLowerCase());
}
function svnMetadataPaths(workingCopy) {
  return [
    path5.join(workingCopy, ".svn", "wc.db"),
    path5.join(workingCopy, ".svn", "lock"),
    path5.join(workingCopy, "Temp", "UnityLockfile"),
    path5.join(workingCopy, "Project", "Temp", "UnityLockfile")
  ];
}
function resolveWriteTargets(workingCopy, relatives) {
  const abs = /* @__PURE__ */ new Set();
  for (const rel of prioritizeLockTargets(relatives)) {
    const file = path5.resolve(workingCopy, rel);
    abs.add(file);
    if (!existsSync3(file)) {
      abs.add(path5.dirname(file));
    }
  }
  for (const extra of svnMetadataPaths(workingCopy)) {
    abs.add(extra);
  }
  abs.add(path5.resolve(workingCopy));
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
    const match = /^(C\s{2,}|\s+C\s{2,})(.+)$/.exec(line);
    if (match) {
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

// packs/versionControl/src/svn.ts
async function svnCheckAndUpdate(options) {
  if (!existsSync4(options.workingCopy)) {
    throw new Error(`\u76EE\u5F55\u4E0D\u5B58\u5728: ${options.workingCopy}`);
  }
  if (!existsSync4(path6.join(options.workingCopy, ".svn"))) {
    throw new Error("\u4E0D\u662F SVN \u5DE5\u4F5C\u526F\u672C\uFF08\u7F3A\u5C11 .svn\uFF09");
  }
  const stage = (message) => options.onProgress?.(message, null);
  const policy = options.onConflict ?? "fail";
  const notes = [];
  const canRelease = options.releaseOccupants === true && process.platform === "win32";
  if (existsSync4(path6.join(options.workingCopy, ".svn", "lock"))) {
    if (policy !== "revert") {
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
    willRevertProblems: policy === "revert" && Boolean(findSvnProblem(status.stdout))
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
  if (problem) {
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
    return { skipped: true, detail: notes.join("\uFF1B") || "\u6309\u7B56\u7565\u8DF3\u8FC7 svn update", code: 0 };
  }
  stage(incomingXml ? `\u5F00\u59CB\u66F4\u65B0\uFF0C\u8FDC\u7AEF\u53D8\u66F4\u7EA6 ${predicted.incoming} \u4E2A\u8DEF\u5F84` : "\u5F00\u59CB\u66F4\u65B0");
  const counter = createUpdateProgress({
    total: incomingXml ? predicted.incoming : 0,
    emit: (message, percent) => options.onProgress?.(message, percent)
  });
  const update = await runSvn(
    options,
    ["update", "--non-interactive", "--accept", "postpone"],
    "svn update",
    true,
    counter.line
  );
  if (update.code === 0) {
    counter.finish();
    const conflicts = conflictedRelativesFromUpdateOutput(update.stdout);
    if (conflicts.length > 0 && policy === "postpone") {
      return {
        skipped: true,
        detail: `svn update \u4EA7\u751F ${conflicts.length} \u4E2A\u51B2\u7A81\uFF0C\u6309 onConflict=postpone \u4FDD\u7559\u73B0\u573A\u6302\u8D77\uFF0C\u5904\u7406\u5B8C\u4E0B\u8F6E\u81EA\u52A8\u7EE7\u7EED:
  ${conflicts.slice(0, 20).join("\n  ")}`,
        code: 0
      };
    }
    if (conflicts.length > 0) {
      throw new Error(`svn update \u4EA7\u751F ${conflicts.length} \u4E2A\u51B2\u7A81:
  ${conflicts.slice(0, 20).join("\n  ")}`);
    }
    notes.push(tail2(update.stdout) || "svn update \u5B8C\u6210");
    return { skipped: false, detail: notes.join("\uFF1B"), code: update.code };
  }
  const updateProblem = findSvnProblem(update.stdout + update.stderr) ?? tail2(update.stderr) ?? `svn update \u9000\u51FA\u7801 ${update.code}`;
  const lockHit = isSvnLockError(update.stdout + update.stderr);
  if (canRelease && lockHit) {
    const extra = pathsFromSvnError(`${update.stdout}
${update.stderr}`).map(
      (item) => path6.isAbsolute(item) ? path6.relative(options.workingCopy, item) : item
    );
    notes.push("\u66F4\u65B0\u88AB\u6587\u4EF6\u72EC\u5360\u6253\u65AD\uFF0Ccleanup \u5E76\u91CA\u653E\u5360\u7528\u540E\u91CD\u8BD5");
    await runSvn(options, ["cleanup"], "svn cleanup", true);
    await releasePredicted(options, [...predicted.rels, ...extra], "update \u72EC\u5360\u91CD\u8BD5");
    const retry2 = await runSvn(options, ["update"], "svn update retry", true);
    if (retry2.code === 0) {
      notes.push("\u91CA\u653E\u5360\u7528\u540E\u5DF2\u91CD\u65B0 update");
      return { skipped: false, detail: [...notes, tail2(retry2.stdout) || "svn update \u5B8C\u6210"].join("\uFF1B"), code: retry2.code };
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
  if (options.skipUpdate) {
    return {
      rels: options.willRevertProblems ? local : [],
      incoming: 0,
      local: local.length
    };
  }
  const incomingEntries = parseSvnStatusXml(incomingXml ?? localXml);
  const incoming = updateWriteRelatives(incomingEntries, false);
  const rels = options.willRevertProblems ? [.../* @__PURE__ */ new Set([...incoming, ...local])] : incoming;
  return { rels, incoming: incoming.length, local: local.length };
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
function appendLog(logFile, line) {
  mkdirSync3(path6.dirname(logFile), { recursive: true });
  appendFileSync(logFile, `${line}
`, "utf8");
}
async function runSvn(options, args, label, allowFail = false, onStdoutLine) {
  const result = await runCommand({
    command: "svn",
    args,
    cwd: options.workingCopy,
    timeoutMs: args.includes("status") ? Math.min(options.timeoutMs, 10 * 6e4) : options.timeoutMs,
    logFile: options.logFile,
    abortSignal: options.abortSignal,
    onStdoutLine
  }).done;
  if (result.cancelled) {
    throw new Error(result.timedOut ? `${label} \u8D85\u65F6` : "\u5DF2\u53D6\u6D88");
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
  const destRoot = path6.join(root, options.localDate ?? stamp.slice(0, 10), stamp);
  mkdirSync3(destRoot, { recursive: true });
  const copied = [];
  for (const rel of rels) {
    const from = path6.join(options.workingCopy, rel);
    if (!existsSync4(from)) {
      continue;
    }
    const to = path6.join(destRoot, rel);
    mkdirSync3(path6.dirname(to), { recursive: true });
    cpSync(from, to, {
      recursive: true,
      force: true,
      filter: (src) => !shouldSkipBackup(path6.relative(options.workingCopy, src))
    });
    copied.push(rel);
  }
  writeFileSync3(path6.join(destRoot, "manifest.txt"), copied.join("\n") || "(\u6CA1\u6709\u53EF\u5907\u4EFD\u7684\u810F\u6587\u4EF6)", "utf8");
  return destRoot;
}
function resolveBackupRoot(workingCopy, backupDir) {
  if (backupDir) {
    return path6.isAbsolute(backupDir) ? backupDir : path6.resolve(workingCopy, backupDir);
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
  if (/item="conflicted"/.test(xml) || />conflicted</.test(xml)) {
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
  const result = await svnCheckAndUpdate({
    workingCopy: ctx.cwd,
    timeoutMs: ctx.timeoutMs,
    logFile: ctx.logFile,
    abortSignal: ctx.abortSignal,
    skipUpdate: false,
    onConflict: params.onConflict ?? "fail",
    backupOnRevert: params.backupOnRevert !== false,
    backupDir: typeof params.backupDir === "string" ? params.backupDir : void 0,
    localDate: ctx.localDate,
    releaseOccupants: params.releaseOccupants !== false,
    onProgress: ctx.onProgress
  });
  return { detail: result.detail, code: result.code, skipped: result.skipped };
}
async function runSvnArgs(ctx, args, label, allowUrlCwd = false) {
  const result = await runCommand({
    command: "svn",
    args,
    cwd: allowUrlCwd ? ctx.workspacePath : ctx.cwd,
    timeoutMs: ctx.timeoutMs,
    logFile: ctx.logFile,
    abortSignal: ctx.abortSignal
  }).done;
  if (result.cancelled) {
    throw new Error(result.timedOut ? `${label} \u8D85\u65F6` : "\u5DF2\u53D6\u6D88");
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
