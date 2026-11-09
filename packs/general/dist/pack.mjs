// packs/general/src/index.ts
import path5 from "node:path";

// shared/occupants.ts
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path2 from "node:path";
import { fileURLToPath } from "node:url";

// shared/exec.ts
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
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
  mkdirSync(path.dirname(options.logFile), { recursive: true });
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
    proc.stdout?.on("data", (chunk) => {
      stdout = cap(stdout + chunk.toString("utf8"));
      log.write(chunk);
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
    proc.on("close", (code, signal) => finish(code, signal));
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

// shared/occupants.ts
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
  const here = path2.dirname(fileURLToPath(import.meta.url));
  const found = path2.resolve(here, "../scripts/list-occupants.ps1");
  if (!existsSync(found)) {
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
  const files = [...new Set((extraFiles ?? []).filter((item) => item && existsSync(item)))];
  if (files.length === 0) {
    return void 0;
  }
  const dir = mkdtempSync(path2.join(os.tmpdir(), "novoard-packs-occ-"));
  const listFile = path2.join(dir, "files.txt");
  writeFileSync(listFile, `\uFEFF${files.join("\r\n")}\r
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
  const base = path2.parse(item.name).name.toLowerCase();
  const full = item.name.toLowerCase();
  return [...ALWAYS_RELEASE].some((name) => base.includes(name) || full.includes(name));
}
function isNeverForceKill(item) {
  const base = path2.parse(item.name).name.toLowerCase();
  return NEVER_FORCE_KILL.some((name) => base.includes(name));
}
function isUnityEditorFamily(item) {
  const base = path2.parse(item.name).name.toLowerCase();
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
    const base = path2.parse(item.name).name.toLowerCase();
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
function isUnityLockHeld(lockFile) {
  if (!existsSync(lockFile)) {
    return false;
  }
  if (process.platform !== "win32") {
    return true;
  }
  try {
    closeSync(openSync(lockFile, "r+"));
    return false;
  } catch {
    return true;
  }
}
function unityLockFiles(workspaceRoot) {
  return [
    path2.join(workspaceRoot, "Temp", "UnityLockfile"),
    path2.join(workspaceRoot, "Project", "Temp", "UnityLockfile")
  ].filter((file) => existsSync(file));
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
async function releaseOccupants(options) {
  const prepared = await prepareExclusiveAccess(options);
  return { closed: prepared.closed, remaining: prepared.remaining };
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

// packs/general/src/idle-quit.ts
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2 } from "node:fs";
import path3 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// shared/time.ts
function parseTimeout(value) {
  const match = value.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) {
    throw new Error(`\u65E0\u6548 timeout: ${value}`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "ms") return amount;
  if (unit === "s") return amount * 1e3;
  if (unit === "m") return amount * 6e4;
  return amount * 36e5;
}

// packs/general/src/idle-quit.ts
function helperScript2() {
  const here = path3.dirname(fileURLToPath2(import.meta.url));
  const found = path3.resolve(here, "../scripts/quit-idle-apps.ps1");
  if (!existsSync2(found)) {
    throw new Error(`\u627E\u4E0D\u5230 ${found}`);
  }
  return found;
}
function parseJsonTail(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
    }
  }
  throw new Error(stdout.trim() || "quit-idle \u6CA1\u6709\u8F93\u51FA");
}
async function quitIdleApps(step, logFile) {
  mkdirSync2(path3.dirname(logFile), { recursive: true });
  const log = (line) => {
    appendFileSync(logFile, `${line}
`, "utf8");
  };
  const script = helperScript2();
  const idleForMs = parseTimeout(step.idleFor);
  const retryIntervalMs = step.retryInterval ? parseTimeout(step.retryInterval) : 0;
  const waitMs2 = retryIntervalMs > 0 ? parseTimeout(step.closeWait ?? "3m") : parseTimeout(step.timeout);
  const spawnTimeoutMs = parseTimeout(step.timeout) + 3e4;
  log(
    `quit-idle names=${step.processNames.join(",")} idleFor=${step.idleFor} from=${step.countIdleFrom} until=${step.until} waitMs=${waitMs2} spawnTimeoutMs=${spawnTimeoutMs} script=${script}` + (retryIntervalMs > 0 ? ` retryInterval=${step.retryInterval}` : "")
  );
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-ProcessNames",
      step.processNames.join(","),
      "-IdleForMs",
      String(idleForMs),
      "-CountIdleFrom",
      step.countIdleFrom,
      "-Until",
      step.until,
      "-WaitMs",
      String(waitMs2),
      "-RetryIntervalMs",
      String(retryIntervalMs)
    ],
    { encoding: "utf8", windowsHide: true, timeout: spawnTimeoutMs }
  );
  if (result.stderr?.trim()) {
    log(result.stderr.trim());
  }
  if (result.stdout?.trim()) {
    log(result.stdout.trim());
  }
  log(
    `powershell status=${result.status ?? "null"} signal=${result.signal ?? ""} error=${result.error?.message ?? ""}`
  );
  if (result.error) {
    throw new Error(result.error.message);
  }
  const parsed = parseJsonTail(result.stdout || result.stderr || "");
  log(`parsed action=${String(parsed.action ?? "")} reason=${String(parsed.reason ?? "")} json=${JSON.stringify(parsed)}`);
  const action = String(parsed.action ?? "");
  const reason = describeIdleReason(action, String(parsed.reason ?? ""), parsed);
  if (result.status === 2 || action === "timeout") {
    throw new Error(reason);
  }
  if (result.status !== 0) {
    throw new Error(reason || `\u9000\u51FA\u7801 ${result.status}`);
  }
  return { detail: reason, code: 0, skipped: action === "skip" || action === "none" };
}
function formatTags(parsed, key) {
  const value = parsed[key];
  return Array.isArray(value) && value.length > 0 ? value.map(String).join(",") : "";
}
function describeIdleReason(action, code, parsed) {
  const extra = [
    formatTags(parsed, "remaining") ? `remaining=${formatTags(parsed, "remaining")}` : "",
    formatTags(parsed, "killed") ? `killed=${formatTags(parsed, "killed")}` : "",
    formatTags(parsed, "closed") ? `closed=${formatTags(parsed, "closed")}` : ""
  ].filter(Boolean).join(" ");
  const suffix = extra ? ` (${extra})` : "";
  if (code === "leftover-forced-kill") {
    return `\u8B66\u544A: \u65E0\u7A97\u53E3\u6B8B\u7559\u8FDB\u7A0B\uFF0C\u5DF2\u5F3A\u5236\u7ED3\u675F${suffix}`;
  }
  if (code === "timeout-forced-kill") {
    return `\u8B66\u544A: \u6B63\u5E38\u9000\u51FA\u8D85\u65F6\uFF0C\u5DF2\u5F3A\u5236\u7ED3\u675F${suffix}`;
  }
  if (code === "leftover-no-window") {
    return `\u8B66\u544A: \u8FDB\u7A0B\u4ECD\u5728\u4F46\u6CA1\u6709\u7A97\u53E3\uFF0C\u5DF2\u5C1D\u8BD5\u5F3A\u5236\u7ED3\u675F${suffix}`;
  }
  if (action === "timeout" || code === "graceful-timeout") {
    return `\u7B49\u5F85\u6B63\u5E38\u9000\u51FA\u8D85\u65F6\uFF0C\u672A\u5F3A\u5236\u7ED3\u675F\uFF08\u907F\u514D\u7D22\u5F15\u635F\u574F\uFF09${suffix}`;
  }
  if (code === "outside-window") {
    return "\u4E0D\u5728\u591C\u95F4\u7A97\u53E3\u5185";
  }
  if (code === "idle-too-short") {
    const elapsed = Number(parsed.elapsedMs ?? 0);
    const need = Number(parsed.needMs ?? 0);
    return `\u7A7A\u95F2\u672A\u6EE1\u9608\u503C\uFF08\u5DF2 ${(elapsed / 6e4).toFixed(0)} / \u9700 ${(need / 6e4).toFixed(0)} \u5206\u949F\uFF09`;
  }
  if (code === "no-process" || action === "none") {
    return "\u6CA1\u6709 Rider \u8FDB\u7A0B";
  }
  if (code === "closed" || action === "close") {
    return `\u5DF2\u53D1\u9001\u5173\u95ED\u5E76\u6B63\u5E38\u9000\u51FA${suffix}`;
  }
  return `${code || action}${suffix}`;
}

// packs/general/src/manifest.ts
var unityWarmup = {
  id: "unity-warmup",
  displayName: "Unity \u9884\u70ED",
  idempotent: true,
  requiresExclusiveWorkspace: true,
  lowPriority: true,
  supportsDryRun: true,
  platforms: ["win32", "darwin"],
  params: [
    { name: "nographics", type: "boolean", default: false },
    { name: "executeMethod", type: "string" },
    { name: "path", type: "string" }
  ]
};
var quitIdle = {
  id: "quit-idle",
  displayName: "\u7A7A\u95F2\u9000\u51FA\u8FDB\u7A0B",
  idempotent: true,
  supportsDryRun: true,
  platforms: ["win32"],
  params: [
    { name: "processNames", type: "string[]", required: true },
    { name: "idleFor", type: "string", required: true },
    { name: "countIdleFrom", type: "string", default: "00:00" },
    { name: "until", type: "string", default: "08:00" },
    { name: "retryInterval", type: "string" },
    { name: "closeWait", type: "string", default: "3m" }
  ]
};
var releaseOccupants2 = {
  id: "release-occupants",
  displayName: "\u91CA\u653E\u5360\u7528\u8FDB\u7A0B",
  description: "\u5173\u95ED\u5360\u7528\u6307\u5B9A\u76EE\u5F55\uFF08\u53CA\u989D\u5916\u6587\u4EF6\uFF09\u7684\u8FDB\u7A0B\uFF1BIDE \u53EA\u8BF7\u6C42\u6B63\u5E38\u5173\u95ED\uFF0C\u4E0D\u5F3A\u6740",
  idempotent: true,
  supportsDryRun: true,
  platforms: ["win32"],
  params: [
    { name: "path", type: "string", required: true, description: "\u8981\u91CA\u653E\u5360\u7528\u7684\u76EE\u5F55\uFF08\u76F8\u5BF9\u5DE5\u4F5C\u76EE\u5F55\u6216\u7EDD\u5BF9\u8DEF\u5F84\uFF09" },
    { name: "extraFiles", type: "string[]", description: "\u76EE\u5F55\u4E4B\u5916\u8FD8\u8981\u68C0\u67E5\u7684\u6587\u4EF6" }
  ]
};
var manifest = {
  id: "general",
  displayName: "\u901A\u7528\u5DE5\u5177",
  schemaVersion: 1,
  runtime: "node",
  entry: "dist/pack.mjs",
  tools: [unityWarmup, quitIdle, releaseOccupants2]
};

// packs/general/src/unity.ts
import { closeSync as closeSync2, existsSync as existsSync3, openSync as openSync2, readFileSync, readdirSync, readSync, statSync, unlinkSync as unlinkSync2 } from "node:fs";
import { homedir } from "node:os";
import path4 from "node:path";
var UNITY_WARN_KEYWORDS = ["error", "exception", "failed"];
function splitCompleteLines(buffer) {
  const parts = buffer.split(/\r?\n/);
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}
function followUnityLog(logFile, onProgress) {
  let stopped = false;
  let offset = 0;
  let partial = "";
  const warnLines = [];
  const warnSeen = /* @__PURE__ */ new Set();
  const HEARTBEAT_MS = 2e4;
  const MAX_WARNINGS = 40;
  const sample = () => {
    if (stopped) {
      return;
    }
    let size = 0;
    try {
      size = statSync(logFile).size;
    } catch {
      return;
    }
    let text = "";
    if (size > offset) {
      try {
        const fd = openSync2(logFile, "r");
        try {
          const chunk = Buffer.alloc(size - offset);
          readSync(fd, chunk, 0, chunk.length, offset);
          text = chunk.toString("utf8");
        } finally {
          closeSync2(fd);
        }
      } catch {
        return;
      }
      if (offset === 0) {
        text = text.replace(/^\uFEFF/, "");
      }
      offset = size;
    } else if (size < offset) {
      offset = 0;
      partial = "";
      return;
    } else {
      return;
    }
    const { lines, rest } = splitCompleteLines(partial + text);
    partial = rest;
    let lastLine = "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      lastLine = trimmed;
      const lower = trimmed.toLowerCase();
      if (UNITY_WARN_KEYWORDS.some((kw) => lower.includes(kw))) {
        if (warnLines.length < MAX_WARNINGS && !warnSeen.has(trimmed)) {
          warnSeen.add(trimmed);
          warnLines.push(trimmed);
        }
      }
    }
    if (lastLine) {
      onProgress(lastLine);
    }
  };
  const timer = setInterval(sample, HEARTBEAT_MS);
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    warnings: () => warnLines,
    tickForTest: sample
  };
}
function readProjectVersion(projectPath) {
  const file = path4.join(projectPath, "ProjectSettings", "ProjectVersion.txt");
  if (!existsSync3(file)) {
    throw new Error(`\u672A\u627E\u5230 ${file}`);
  }
  const text = readFileSync(file, "utf8");
  const match = text.match(/m_EditorVersion:\s*(\S+)/);
  if (!match) {
    throw new Error("ProjectVersion.txt \u6CA1\u6709 m_EditorVersion");
  }
  return match[1];
}
function listUnityEditors() {
  const found = /* @__PURE__ */ new Map();
  const add = (version, exe) => {
    if (existsSync3(exe)) {
      found.set(exe.toLowerCase(), { version, exe });
    }
  };
  const hubDir = path4.join(homedir(), "AppData", "Roaming", "UnityHub");
  const editorsV2 = path4.join(hubDir, "editors-v2.json");
  if (existsSync3(editorsV2)) {
    try {
      const json = JSON.parse(readFileSync(editorsV2, "utf8"));
      for (const editor of json.data ?? []) {
        for (const location of editor.location ?? []) {
          add(editor.version ?? path4.basename(path4.dirname(location)), location);
        }
      }
    } catch {
    }
  }
  const secondary = path4.join(hubDir, "secondaryInstallPath.json");
  const extraRoots = [
    path4.join(process.env["ProgramFiles"] ?? "C:/Program Files", "Unity/Hub/Editor"),
    path4.join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "Unity/Hub/Editor")
  ];
  if (existsSync3(secondary)) {
    const raw = readFileSync(secondary, "utf8").replace(/^"|"$/g, "").trim();
    if (raw) {
      extraRoots.push(raw);
    }
  }
  for (const root of extraRoots) {
    if (!existsSync3(root)) {
      continue;
    }
    for (const name of readdirSync(root, { withFileTypes: true })) {
      if (!name.isDirectory()) {
        continue;
      }
      const exe = path4.join(root, name.name, "Editor", "Unity.exe");
      add(name.name, exe);
    }
  }
  return [...found.values()];
}
function resolveUnityEditor(version) {
  const editors = listUnityEditors();
  const exact = editors.find((item) => item.version === version);
  if (exact) {
    return exact;
  }
  const prefix = editors.find(
    (item) => item.version.startsWith(version) || version.startsWith(item.version)
  );
  if (prefix) {
    return prefix;
  }
  const available = editors.map((item) => `${item.version} @ ${item.exe}`).join("\n") || "(\u672A\u53D1\u73B0\u4EFB\u4F55\u7F16\u8F91\u5668)";
  throw new Error(`\u627E\u4E0D\u5230 Unity ${version}\u3002\u5DF2\u53D1\u73B0:
${available}`);
}
async function warmupUnity(options) {
  if (!existsSync3(options.projectPath)) {
    throw new Error(`\u5DE5\u7A0B\u4E0D\u5B58\u5728: ${options.projectPath}`);
  }
  const lockFile = path4.join(options.projectPath, "Temp", "UnityLockfile");
  if (isUnityLockHeld(lockFile)) {
    throw new Error("Unity \u6B63\u5728\u4F7F\u7528\u8BE5\u9879\u76EE\uFF08Temp/UnityLockfile \u88AB\u5360\u7528\uFF09\uFF0C\u9884\u70ED\u524D\u672A\u80FD\u91CA\u653E\u5DF2\u6253\u5F00\u7684 Unity");
  }
  if (existsSync3(lockFile)) {
    try {
      unlinkSync2(lockFile);
    } catch {
    }
  }
  const version = readProjectVersion(options.projectPath);
  const editor = resolveUnityEditor(version);
  const args = [
    "-batchmode",
    "-quit",
    "-projectPath",
    options.projectPath,
    "-logFile",
    options.logFile,
    // 无人值守预热不向共享 Cache Server 上传，避免污染团队缓存
    "-cacheServerEnableUpload",
    "false"
  ];
  if (options.nographics) {
    args.push("-nographics");
  }
  if (options.executeMethod) {
    args.push("-executeMethod", options.executeMethod);
  }
  const tail = options.onProgress ? followUnityLog(options.logFile, options.onProgress) : void 0;
  try {
    const result = await runCommand({
      command: editor.exe,
      args,
      cwd: options.projectPath,
      timeoutMs: options.timeoutMs,
      logFile: `${options.logFile}.spawn.log`,
      abortSignal: options.abortSignal,
      lowPriority: options.lowPriority ?? true
    }).done;
    if (result.cancelled) {
      throw new Error(result.timedOut ? "Unity \u9884\u70ED\u8D85\u65F6" : "\u5DF2\u53D6\u6D88");
    }
    if (result.code !== 0) {
      throw new Error(tailText(result.stderr || result.stdout) || `Unity \u9000\u51FA\u7801 ${result.code}`);
    }
    const warnings = tail?.warnings() ?? [];
    const warnNote = warnings.length > 0 ? `\uFF08\u65E5\u5FD7\u4E2D\u6709 ${warnings.length} \u6761\u544A\u8B66\uFF09` : "";
    return { detail: `Unity ${version} \u9884\u70ED\u5B8C\u6210${warnNote}`, code: result.code };
  } finally {
    tail?.stop();
  }
}
function tailText(text) {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-12).join("\n");
}

// packs/general/src/index.ts
var byId = new Map(manifest.tools.map((t) => [t.id, t]));
async function run(toolId, rawParams, ctx) {
  const tool = byId.get(toolId);
  if (!tool) {
    throw new Error(`general \u6CA1\u6709\u5DE5\u5177: ${toolId}`);
  }
  const { params, errors } = validateToolParams(tool, rawParams);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
  if (tool.platforms && !tool.platforms.includes(process.platform)) {
    throw new Error(`${toolId} \u4E0D\u652F\u6301\u5F53\u524D\u5E73\u53F0 ${process.platform}\uFF08\u652F\u6301 ${tool.platforms.join("/")}\uFF09`);
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
        onProgress: ctx.onProgress
      });
    case "quit-idle":
      return quitIdleApps(
        {
          processNames: params.processNames,
          idleFor: String(params.idleFor),
          countIdleFrom: String(params.countIdleFrom ?? "00:00"),
          until: String(params.until ?? "08:00"),
          // cronkit 传的是 step 原始 timeout 字符串；这里由 ctx.timeoutMs 还原。
          timeout: `${Math.max(0, Math.floor(ctx.timeoutMs))}ms`,
          retryInterval: typeof params.retryInterval === "string" ? params.retryInterval : void 0,
          closeWait: typeof params.closeWait === "string" ? params.closeWait : void 0
        },
        ctx.logFile
      );
    case "release-occupants":
      return runReleaseOccupants(params, ctx);
    default:
      throw new Error(`\u672A\u5B9E\u73B0\u5DE5\u5177: ${toolId}`);
  }
}
async function runReleaseOccupants(params, ctx) {
  const target = path5.resolve(ctx.cwd, String(params.path));
  const extraFiles = params.extraFiles?.map((f) => path5.resolve(ctx.cwd, f));
  const { closed, remaining } = await releaseOccupants({ target, extraFiles, abortSignal: ctx.abortSignal });
  const fmt = (list) => list.map((o) => `${o.name}(${o.pid})`).join(", ");
  if (remaining.length > 0) {
    throw new Error(`\u65E0\u6CD5\u91CA\u653E\u5360\u7528: ${fmt(remaining)}`);
  }
  return {
    detail: closed.length > 0 ? `\u5DF2\u7ED3\u675F\u5360\u7528\u8FDB\u7A0B ${fmt(closed)}` : "\u6CA1\u6709\u9700\u8981\u91CA\u653E\u7684\u5360\u7528\u8FDB\u7A0B",
    code: 0
  };
}
export {
  manifest,
  run
};
