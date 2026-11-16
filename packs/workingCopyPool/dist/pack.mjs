// packs/workingCopyPool/src/index.ts
import { existsSync as existsSync10 } from "node:fs";
import path13 from "node:path";

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
function displayTime(value, timezone = "Asia/Shanghai") {
  const date = value ? new Date(value) : /* @__PURE__ */ new Date();
  if (Number.isNaN(date.getTime())) {
    return value ?? "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date).replace(/\//g, "-");
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
  let dryRun2 = false;
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
      dryRun2 = parseBool();
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
  return { tool, projectRoot: path.resolve(projectRoot), dryRun: dryRun2, resultJson, params };
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

// packs/workingCopyPool/src/config.ts
import { existsSync, readFileSync } from "node:fs";
import path2 from "node:path";

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

// packs/workingCopyPool/src/config.ts
var ConfigError = class extends UsageError {
};
var CONFIG_FILE = "pool.toml";
var TOP_KEYS = /* @__PURE__ */ new Set(["maxSlots", "defaultTtl", "svnRoot", "resident", "branches", "aliases", "sparse", "patchRetentionDays"]);
var BRANCH_KEYS = /* @__PURE__ */ new Set(["pattern", "listFrom", "recentDays"]);
var SPARSE_KEYS = /* @__PURE__ */ new Set(["exclude"]);
var TTL_RE = /^(\d+)(m|h|d|w)$/;
function isTtl(value) {
  return value === "forever" || TTL_RE.test(value) && Number(value.match(TTL_RE)[1]) > 0;
}
function leaseUntil(ttl, now) {
  if (ttl === "forever") return "forever";
  const match = ttl.match(TTL_RE);
  if (!match || Number(match[1]) <= 0) throw new UsageError(`\u4FDD\u7559\u65F6\u957F\u4E0D\u5408\u6CD5\uFF1A${ttl}\uFF08\u4F8B\uFF1A30m\u300112h\u30011d\u30012w\u3001forever\uFF09`);
  const unit = { m: 6e4, h: 36e5, d: 864e5, w: 7 * 864e5 }[match[2]];
  return new Date(now.getTime() + Number(match[1]) * unit).toISOString();
}
function lineOf(text, section, key) {
  const lines = text.split(/\r?\n/);
  let current = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const header = line.match(/^\[\s*([^\]]+?)\s*\]/);
    if (header) {
      current = header[1];
      if (!key && current === section) return i + 1;
      continue;
    }
    if (!key) continue;
    if (current === section && new RegExp(`^["']?${escapeRe(key)}["']?\\s*=`).test(line)) return i + 1;
    if (current === "" && section && new RegExp(`^${escapeRe(section)}\\.${escapeRe(key)}\\s*=`).test(line)) return i + 1;
  }
  return void 0;
}
function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function parseConfig(text) {
  let raw;
  try {
    raw = parse(text);
  } catch (error) {
    if (error instanceof TomlError) {
      throw new ConfigError(`${CONFIG_FILE} \u7B2C ${error.line} \u884C\uFF1A${error.message.split("\n")[0]}`);
    }
    throw new ConfigError(`${CONFIG_FILE} \u89E3\u6790\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
  }
  const fail = (section, key, message) => {
    const line = lineOf(text, section, key);
    const field = [section, key].filter(Boolean).join(".");
    throw new ConfigError(`${CONFIG_FILE}${line ? ` \u7B2C ${line} \u884C` : ""} ${field}\uFF1A${message}`);
  };
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.has(key)) fail("", key, "\u672A\u77E5\u5B57\u6BB5");
  }
  const int = (section, key, value, fallback, min) => {
    if (value === void 0) {
      if (fallback === void 0) fail(section, void 0, `\u7F3A\u5C11 ${key}`);
      return fallback;
    }
    const n = typeof value === "bigint" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min) fail(section, key, `\u5E94\u4E3A\u4E0D\u5C0F\u4E8E ${min} \u7684\u6574\u6570`);
    return n;
  };
  const str = (section, key, value, fallback) => {
    if (value === void 0) {
      if (fallback === void 0) fail(section, key, "\u7F3A\u5C11\u8BE5\u5B57\u6BB5");
      return fallback;
    }
    if (typeof value !== "string" || value.trim() === "") fail(section, key, "\u5E94\u4E3A\u975E\u7A7A\u5B57\u7B26\u4E32");
    return value.trim();
  };
  const strList = (section, key, value) => {
    if (value === void 0) return [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
      fail(section, key, "\u5E94\u4E3A\u975E\u7A7A\u5B57\u7B26\u4E32\u6570\u7EC4");
    }
    return value.map((v) => v.trim());
  };
  const table = (key, allowed) => {
    const value = raw[key];
    if (value === void 0) return {};
    if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date) fail("", key, "\u5E94\u4E3A\u8868\uFF08[" + key + "]\uFF09");
    if (allowed) {
      for (const k of Object.keys(value)) if (!allowed.has(k)) fail(key, k, "\u672A\u77E5\u5B57\u6BB5");
    }
    return value;
  };
  if (raw.maxSlots === void 0) fail("", void 0, "\u7F3A\u5C11 maxSlots");
  const maxSlots = int("", "maxSlots", raw.maxSlots, void 0, 1);
  if (maxSlots > 99) fail("", "maxSlots", "\u4E0D\u80FD\u8D85\u8FC7 99");
  const defaultTtl = str("", "defaultTtl", raw.defaultTtl, "1d");
  if (!isTtl(defaultTtl)) fail("", "defaultTtl", "\u5E94\u4E3A 30m\u300112h\u30011d\u30012w \u6216 forever");
  if (raw.svnRoot === void 0) fail("", void 0, "\u7F3A\u5C11 svnRoot");
  const svnRoot = str("", "svnRoot", raw.svnRoot).replace(/\/+$/, "");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(svnRoot)) fail("", "svnRoot", "\u5E94\u4E3A\u4ED3\u5E93 URL\uFF08\u5982 https://\u3001svn://\u3001file://\uFF09");
  const resident = strList("", "resident", raw.resident);
  const patchRetentionDays = int("", "patchRetentionDays", raw.patchRetentionDays, 30, 1);
  const b = table("branches", BRANCH_KEYS);
  const pattern = str("branches", "pattern", b.pattern, "branches/{name}").replace(/^\/+|\/+$/g, "");
  if (!pattern.includes("{name}")) fail("branches", "pattern", "\u5FC5\u987B\u5305\u542B {name}");
  const listFrom = strList("branches", "listFrom", b.listFrom).map((p) => p.replace(/^\/+|\/+$/g, ""));
  const recentDays = int("branches", "recentDays", b.recentDays, 30, 1);
  const a = table("aliases");
  const aliases = {};
  for (const [name, value] of Object.entries(a)) {
    aliases[name] = str("aliases", name, value).replace(/^\/+|\/+$/g, "");
  }
  const s = table("sparse", SPARSE_KEYS);
  const exclude = strList("sparse", "exclude", s.exclude).map((p) => p.replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, ""));
  for (const item of exclude) {
    if (item === "" || item.split("/").some((part) => part === ".." || part === ".")) fail("sparse", "exclude", `\u8DEF\u5F84\u4E0D\u5408\u6CD5\uFF1A${item}`);
  }
  for (const name of resident) {
    if (!isBranchName(name)) fail("", "resident", `\u5206\u652F\u540D\u4E0D\u5408\u6CD5\uFF1A${name}`);
  }
  return {
    maxSlots,
    defaultTtl,
    svnRoot,
    resident: [...new Set(resident)],
    branches: { pattern, listFrom, recentDays },
    aliases,
    sparse: { exclude: [...new Set(exclude)] },
    patchRetentionDays
  };
}
function configPath(root) {
  return path2.join(root, CONFIG_FILE);
}
function loadConfig(root) {
  const file = configPath(root);
  if (!existsSync(file)) {
    throw new ConfigError(`\u6C60\u6839 ${root} \u4E0B\u6CA1\u6709 ${CONFIG_FILE}\uFF1B\u5148\u6309 README \u5199\u4E00\u4EFD\u914D\u7F6E`);
  }
  return parseConfig(readFileSync(file, "utf8"));
}
function isBranchName(name) {
  if (!name || name !== name.trim()) return false;
  if (/[\u0000-\u001f]/.test(name)) return false;
  if (name.startsWith("/") || name.includes("://")) return false;
  return !name.split("/").some((part) => part === "" || part === "." || part === "..");
}
function branchPath(config, name) {
  return config.aliases[name] ?? config.branches.pattern.replace("{name}", name);
}
function branchUrl(config, name) {
  return `${config.svnRoot}/${branchPath(config, name)}`;
}
function branchFromPath(config, repoPath) {
  const rel = repoPath.replace(/^\/+|\/+$/g, "");
  for (const [name, value] of Object.entries(config.aliases)) {
    if (value === rel) return name;
  }
  const [prefix, suffix] = config.branches.pattern.split("{name}");
  if (rel.length > prefix.length + suffix.length && rel.startsWith(prefix) && rel.endsWith(suffix)) {
    const name = rel.slice(prefix.length, rel.length - suffix.length);
    if (isBranchName(name)) return name;
  }
  return void 0;
}
function branchFromUrl(config, url) {
  const a = safeDecode(url).replace(/\/+$/, "");
  const root = safeDecode(config.svnRoot);
  if (!a.startsWith(`${root}/`)) return void 0;
  return branchFromPath(config, a.slice(root.length + 1));
}
function sameUrl(a, b) {
  return safeDecode(a).replace(/\/+$/, "") === safeDecode(b).replace(/\/+$/, "");
}
function safeDecode(url) {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

// packs/workingCopyPool/src/manifest.ts
var candidates = {
  id: "candidates",
  displayName: "\u5019\u9009\u5206\u652F",
  description: "\u5F00\u5206\u652F\u7684\u5019\u9009\u9879\uFF1A\u6C60\u4E2D\u5DF2\u6709\u3001\u5E38\u9A7B\u3001\u6700\u8FD1\u4F7F\u7528\u3001listFrom \u4E0B\u6700\u8FD1\u6709\u63D0\u4EA4\u7684\u5206\u652F",
  kind: "query",
  idempotent: true,
  supportsDryRun: true,
  supportsResultJson: true
};
var occupied = {
  id: "occupied",
  displayName: "\u5360\u7528\u4E2D\u7684\u5206\u652F",
  description: "\u91CA\u653E\u5206\u652F\u7684\u5019\u9009\u9879\uFF1A\u5F53\u524D\u6709\u6709\u6548\u79DF\u7EA6\u7684\u5206\u652F",
  kind: "query",
  idempotent: true,
  supportsDryRun: true,
  supportsResultJson: true
};
var status = {
  id: "status",
  displayName: "\u6C60\u72B6\u6001",
  description: "\u6BCF\u4E2A\u69FD\u4F4D\u7684\u5206\u652F\u3001\u72B6\u6001\u3001\u79DF\u7EA6\u3001\u6807\u7B7E\u3001\u672C\u5730\u6539\u52A8\u3001\u843D\u540E revision \u4E0E\u6700\u540E\u4F7F\u7528\u65F6\u95F4",
  kind: "query",
  idempotent: true,
  supportsDryRun: true,
  supportsResultJson: true
};
var acquire = {
  id: "acquire",
  displayName: "\u5360\u7528\u5206\u652F",
  description: "\u6309\u5206\u652F\u5360\u7528\u4E00\u4E2A\u5DE5\u4F5C\u526F\u672C\uFF0C\u5165\u53E3\u56FA\u5B9A\u4E3A <\u6C60\u6839>/branch/<\u5206\u652F>",
  kind: "action",
  idempotent: true,
  supportsDryRun: true,
  supportsResultJson: true,
  params: [
    { name: "branch", type: "string", required: true, label: "\u5206\u652F" },
    { name: "ttl", type: "string", label: "\u4FDD\u7559\u65F6\u957F", description: "\u5982 1d\u30013d\u300112h \u6216 forever\uFF1B\u7F3A\u7701\u53D6 pool.toml \u7684 defaultTtl" },
    { name: "tag", type: "string", label: "\u6807\u7B7E", description: "\u5982 bug-12345\uFF0C\u6C60\u6EE1\u65F6\u4F1A\u5217\u51FA" }
  ]
};
var release = {
  id: "release",
  displayName: "\u91CA\u653E\u5206\u652F",
  description: "\u6E05\u9664\u79DF\u7EA6\uFF0C\u4E0D\u52A8\u6587\u4EF6\uFF1B\u4E0B\u6B21\u518D\u8981\u8FD9\u4E2A\u5206\u652F\u65F6\u4E0D\u7528\u5207\u6362",
  kind: "action",
  idempotent: true,
  supportsDryRun: true,
  supportsResultJson: true,
  params: [{ name: "branch", type: "string", required: true, label: "\u5206\u652F" }]
};
var gc = {
  id: "gc",
  displayName: "\u6C60\u56DE\u6536",
  description: "\u63A8\u8FDB\u4E2D\u65AD\u6062\u590D\u3001\u590D\u67E5\u963B\u585E\u69FD\u4F4D\u3001\u7F29\u5BB9\u5220\u9664\u591A\u51FA\u7684\u7A7A\u95F2\u69FD\u4F4D\u3001\u6E05\u7406\u65AD\u94FE\u4E0E\u8FC7\u671F\u5B58\u6863",
  kind: "action",
  idempotent: true,
  supportsDryRun: true,
  supportsResultJson: true
};
var refresh = {
  id: "refresh",
  displayName: "\u66F4\u65B0\u5E38\u9A7B\u5206\u652F",
  description: "\u5E38\u9A7B\u5206\u652F\u5728\u6C60\u91CC\u5C31\u66F4\u65B0\u5230\u6700\u65B0\uFF0C\u4E0D\u5728\u6C60\u91CC\u5C31\u7528\u7A7A\u95F2\u69FD\u4F4D\u51C6\u5907\u597D",
  kind: "action",
  idempotent: true,
  supportsDryRun: true,
  supportsResultJson: true
};
var manifest = {
  id: "workingCopyPool",
  displayName: "\u5DE5\u4F5C\u526F\u672C\u6C60",
  schemaVersion: 1,
  runtime: "node",
  entry: "dist/pack.mjs",
  tools: [candidates, occupied, status, acquire, release, gc, refresh]
};

// packs/workingCopyPool/src/pool.ts
import { existsSync as existsSync8, readdirSync as readdirSync2, rmSync as rmSync3, statSync as statSync4 } from "node:fs";
import path11 from "node:path";

// shared/occupants.ts
import { closeSync, existsSync as existsSync2, mkdtempSync, openSync, rmSync, unlinkSync, writeFileSync as writeFileSync2 } from "node:fs";
import os2 from "node:os";
import path4 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// shared/exec.ts
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync as mkdirSync2 } from "node:fs";
import path3 from "node:path";
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
  mkdirSync2(path3.dirname(options.logFile), { recursive: true });
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
function tailLines(text, count = 8) {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-count).join("\n");
}

// shared/svn-update.ts
import { cpSync, existsSync as existsSync4, mkdirSync as mkdirSync4, writeFileSync as writeFileSync3 } from "node:fs";
import path7 from "node:path";

// shared/svn-status.ts
import { existsSync as existsSync3 } from "node:fs";
import path6 from "node:path";
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
  return entryPath.replace(/\//g, path6.sep);
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
  return LOCK_PRONE_EXT.has(path6.extname(rel).toLowerCase());
}
function svnMetadataPaths(workingCopy) {
  return [
    path6.join(workingCopy, ".svn", "wc.db"),
    path6.join(workingCopy, ".svn", "lock"),
    path6.join(workingCopy, "Temp", "UnityLockfile"),
    path6.join(workingCopy, "Project", "Temp", "UnityLockfile")
  ];
}
function resolveWriteTargets(workingCopy, relatives) {
  const abs2 = /* @__PURE__ */ new Set();
  for (const rel of prioritizeLockTargets(relatives)) {
    const file = path6.resolve(workingCopy, rel);
    abs2.add(file);
    if (!existsSync3(file)) {
      abs2.add(path6.dirname(file));
    }
  }
  for (const extra of svnMetadataPaths(workingCopy)) {
    abs2.add(extra);
  }
  abs2.add(path6.resolve(workingCopy));
  return [...abs2];
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

// shared/svn-update.ts
async function svnCheckAndUpdate(options) {
  if (!existsSync4(options.workingCopy)) {
    throw new Error(`\u76EE\u5F55\u4E0D\u5B58\u5728: ${options.workingCopy}`);
  }
  if (!existsSync4(path7.join(options.workingCopy, ".svn"))) {
    throw new Error("\u4E0D\u662F SVN \u5DE5\u4F5C\u526F\u672C\uFF08\u7F3A\u5C11 .svn\uFF09");
  }
  const stage2 = (message) => options.onProgress?.(message, null);
  const policy = options.onConflict ?? "fail";
  const notes = [];
  const canRelease = options.releaseOccupants === true && process.platform === "win32";
  if (existsSync4(path7.join(options.workingCopy, ".svn", "lock"))) {
    if (policy !== "revert") {
      throw new Error("\u5DE5\u4F5C\u526F\u672C\u6709 in-progress \u9501\uFF08.svn/lock\uFF09\uFF0C\u672A\u6267\u884C cleanup");
    }
    if (canRelease) {
      await releasePredicted(options, [], "in-progress \u9501");
    }
    await runSvn(options, ["cleanup"], "svn cleanup");
    notes.push("\u5DF2 svn cleanup \u89E3\u9664 in-progress \u9501");
  }
  stage2("\u68C0\u67E5\u5DE5\u4F5C\u526F\u672C\u72B6\u6001");
  const status3 = await runSvn(options, ["status", "--xml"], "svn status");
  let statusXml = status3.stdout;
  let incomingXml;
  if (!options.skipUpdate) {
    stage2("\u67E5\u8BE2\u8FDC\u7AEF\u53D8\u66F4");
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
    willRevertProblems: policy === "revert" && Boolean(findSvnProblem(status3.stdout))
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
  const problem = findSvnProblem(status3.stdout);
  if (problem) {
    if (policy === "postpone") {
      return {
        skipped: true,
        detail: `${problem}\uFF0C\u6309 onConflict=postpone \u4FDD\u7559\u73B0\u573A\u6302\u8D77\uFF0C\u5904\u7406\u5B8C\u4E0B\u8F6E\u81EA\u52A8\u7EE7\u7EED:
  ${conflictedRelatives(status3.stdout)}`,
        code: 0
      };
    }
    if (policy !== "revert") {
      throw new Error(`${problem}\u3002\u5DF2\u4FDD\u7559\u73B0\u573A\uFF0C\u672A\u81EA\u52A8 cleanup/revert`);
    }
    const backup2 = await backupDirty(options, status3.stdout);
    if (backup2) {
      notes.push(`\u51B2\u7A81/\u6539\u52A8\u5DF2\u5907\u4EFD\u5230 ${backup2}`);
    }
    if (canRelease) {
      await releasePredicted(options, revertWriteRelatives(parseSvnStatusXml(status3.stdout)), "svn revert");
    }
    await resetWorkingCopy(options);
    notes.push("\u5DF2\u6309 onConflict=revert \u6267\u884C cleanup/revert");
  }
  if (options.skipUpdate) {
    return { skipped: true, detail: notes.join("\uFF1B") || "\u6309\u7B56\u7565\u8DF3\u8FC7 svn update", code: 0 };
  }
  stage2(incomingXml ? `\u5F00\u59CB\u66F4\u65B0\uFF0C\u8FDC\u7AEF\u53D8\u66F4\u7EA6 ${predicted.incoming} \u4E2A\u8DEF\u5F84` : "\u5F00\u59CB\u66F4\u65B0");
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
    notes.push(tail(update.stdout) || "svn update \u5B8C\u6210");
    return { skipped: false, detail: notes.join("\uFF1B"), code: update.code };
  }
  const updateProblem = findSvnProblem(update.stdout + update.stderr) ?? tail(update.stderr) ?? `svn update \u9000\u51FA\u7801 ${update.code}`;
  const lockHit = isSvnLockError(update.stdout + update.stderr);
  if (canRelease && lockHit) {
    const extra = pathsFromSvnError(`${update.stdout}
${update.stderr}`).map(
      (item) => path7.isAbsolute(item) ? path7.relative(options.workingCopy, item) : item
    );
    notes.push("\u66F4\u65B0\u88AB\u6587\u4EF6\u72EC\u5360\u6253\u65AD\uFF0Ccleanup \u5E76\u91CA\u653E\u5360\u7528\u540E\u91CD\u8BD5");
    await runSvn(options, ["cleanup"], "svn cleanup", true);
    await releasePredicted(options, [...predicted.rels, ...extra], "update \u72EC\u5360\u91CD\u8BD5");
    const retry2 = await runSvn(options, ["update"], "svn update retry", true);
    if (retry2.code === 0) {
      notes.push("\u91CA\u653E\u5360\u7528\u540E\u5DF2\u91CD\u65B0 update");
      return { skipped: false, detail: [...notes, tail(retry2.stdout) || "svn update \u5B8C\u6210"].join("\uFF1B"), code: retry2.code };
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
  return { skipped: false, detail: [...notes, tail(retry.stdout) || "svn update \u5B8C\u6210"].join("\uFF1B"), code: retry.code };
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
async function runSvn(options, args, label, allowFail = false, onStdoutLine) {
  const result = await runCommand({
    command: "svn",
    args,
    cwd: options.workingCopy,
    timeoutMs: args.includes("status") ? Math.min(options.timeoutMs, 10 * 6e4) : options.timeoutMs,
    logFile: options.logFile,
    abortSignal: options.abortSignal,
    gracefulMs: SVN_GRACEFUL_MS,
    onStdoutLine
  }).done;
  if (result.cancelled) {
    const note = await cleanupAfterInterrupt(args, { cwd: options.workingCopy, logFile: options.logFile });
    throw new Error(`${result.timedOut ? `${label} \u8D85\u65F6` : "\u5DF2\u53D6\u6D88"}${note}`);
  }
  if (!allowFail && result.code !== 0) {
    throw new Error(tail(result.stderr) || `${label} \u9000\u51FA\u7801 ${result.code}`);
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
  const destRoot = path7.join(root, options.localDate ?? stamp.slice(0, 10), stamp);
  mkdirSync4(destRoot, { recursive: true });
  const copied = [];
  for (const rel of rels) {
    const from = path7.join(options.workingCopy, rel);
    if (!existsSync4(from)) {
      continue;
    }
    const to = path7.join(destRoot, rel);
    mkdirSync4(path7.dirname(to), { recursive: true });
    cpSync(from, to, {
      recursive: true,
      force: true,
      filter: (src) => !shouldSkipBackup(path7.relative(options.workingCopy, src))
    });
    copied.push(rel);
  }
  writeFileSync3(path7.join(destRoot, "manifest.txt"), copied.join("\n") || "(\u6CA1\u6709\u53EF\u5907\u4EFD\u7684\u810F\u6587\u4EF6)", "utf8");
  return destRoot;
}
function resolveBackupRoot(workingCopy, backupDir) {
  if (backupDir) {
    return path7.isAbsolute(backupDir) ? backupDir : path7.resolve(workingCopy, backupDir);
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
function tail(text) {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-8).join("\n");
}

// packs/workingCopyPool/src/archive.ts
import { copyFileSync, existsSync as existsSync7, lstatSync, mkdirSync as mkdirSync6, readlinkSync, rmSync as rmSync2, statSync as statSync3, symlinkSync, unlinkSync as unlinkSync3, writeFileSync as writeFileSync5 } from "node:fs";
import path10 from "node:path";

// packs/workingCopyPool/src/state.ts
import { appendFileSync as appendFileSync2, closeSync as closeSync2, existsSync as existsSync5, mkdirSync as mkdirSync5, openSync as openSync2, readFileSync as readFileSync2, renameSync, statSync, unlinkSync as unlinkSync2, writeFileSync as writeFileSync4, writeSync } from "node:fs";
import path8 from "node:path";
function poolPaths(root) {
  const meta = path8.join(root, ".pool");
  return {
    root,
    slots: path8.join(root, "slots"),
    branch: path8.join(root, "branch"),
    patches: path8.join(root, "patches"),
    meta,
    state: path8.join(meta, "state.json"),
    lock: path8.join(meta, "lock"),
    cache: path8.join(meta, "cache"),
    history: path8.join(meta, "history.jsonl")
  };
}
function slotDir(paths, id) {
  return path8.join(paths.slots, id);
}
function branchDirName(branch) {
  return branch.replace(/[\\/:*?"<>|\s]/g, "_");
}
function branchLink(paths, branch) {
  return path8.join(paths.branch, branchDirName(branch));
}
function ensureLayout(paths) {
  for (const dir of [paths.slots, paths.branch, paths.patches, paths.meta, paths.cache]) {
    mkdirSync5(dir, { recursive: true });
  }
  if (!existsSync5(paths.state)) {
    writeJsonAtomic(paths.state, { version: 1, slots: [] });
  }
}
function readState(paths) {
  if (!existsSync5(paths.state)) return { version: 1, slots: [] };
  const value = JSON.parse(readFileSync2(paths.state, "utf8"));
  if (!value || !Array.isArray(value.slots)) throw new Error(`${paths.state} \u683C\u5F0F\u4E0D\u5BF9`);
  return value;
}
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync4(tmp, `${JSON.stringify(value, null, 2)}
`, "utf8");
  renameSync(tmp, file);
}
function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
var LOCK_STALE_MS = 5 * 6e4;
var LOCK_WAIT_MS = 15e3;
function isStaleLock(file, now = Date.now()) {
  let info;
  try {
    info = JSON.parse(readFileSync2(file, "utf8"));
  } catch {
    try {
      return now - statSync(file).mtimeMs > 1e4;
    } catch {
      return true;
    }
  }
  if (!pidAlive(info?.pid)) return true;
  const at = Date.parse(info?.at ?? "");
  return Number.isFinite(at) && now - at > LOCK_STALE_MS;
}
function tryLock(file) {
  try {
    const fd = openSync2(file, "wx");
    writeSync(fd, JSON.stringify({ pid: process.pid, at: (/* @__PURE__ */ new Date()).toISOString() }));
    closeSync2(fd);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}
async function acquireLock(file, waitMs2 = LOCK_WAIT_MS) {
  const deadline = Date.now() + waitMs2;
  while (true) {
    if (tryLock(file)) {
      return () => {
        try {
          unlinkSync2(file);
        } catch {
        }
      };
    }
    if (isStaleLock(file)) {
      try {
        unlinkSync2(file);
      } catch {
      }
      continue;
    }
    if (Date.now() >= deadline) {
      let holder = "";
      try {
        holder = readFileSync2(file, "utf8");
      } catch {
      }
      throw new Error(`\u6C60\u72B6\u6001\u9501\u88AB\u5360\u7528\u8D85\u8FC7 ${Math.round(waitMs2 / 1e3)} \u79D2\uFF1A${holder || file}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function mutate(paths, fn) {
  const release2 = await acquireLock(paths.lock);
  try {
    const state = readState(paths);
    const result = fn(state);
    writeJsonAtomic(paths.state, state);
    return result;
  } finally {
    release2();
  }
}
function leaseActive(lease, now) {
  if (!lease) return false;
  if (lease.until === "forever") return true;
  const until = Date.parse(lease.until);
  return Number.isFinite(until) && until > now.getTime();
}
function isResident(slot, config) {
  return Boolean(slot.branch) && config.resident.includes(slot.branch);
}
function isIdle(slot, config, now) {
  return slot.phase === "ready" && !isResident(slot, config) && !leaseActive(slot.lease, now);
}
function isInterrupted(slot) {
  return Boolean(slot.op) && !pidAlive(slot.op.pid);
}
function laterLease(a, b) {
  if (!a) return b;
  if (a.until === "forever" || b.until === "forever") return { until: "forever", tag: b.tag ?? a.tag };
  return Date.parse(a.until) >= Date.parse(b.until) ? { until: a.until, tag: b.tag ?? a.tag } : { until: b.until, tag: b.tag ?? a.tag };
}
function nextSlotId(state) {
  const used = new Set(state.slots.map((s) => s.id));
  for (let i = 1; i < 1e3; i++) {
    const id = `s${String(i).padStart(2, "0")}`;
    if (!used.has(id)) return id;
  }
  throw new Error("\u69FD\u4F4D\u53F7\u7528\u5B8C");
}
function appendHistory(paths, entry) {
  try {
    appendFileSync2(paths.history, `${JSON.stringify(entry)}
`, "utf8");
  } catch {
  }
}
function recentBranches(paths, limit = 20) {
  if (!existsSync5(paths.history)) return [];
  const lines = readFileSync2(paths.history, "utf8").split(/\r?\n/).filter(Boolean);
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.action !== "acquire" || !entry.branch || seen.has(entry.branch)) continue;
      seen.add(entry.branch);
      out.push(entry.branch);
    } catch {
    }
  }
  return out;
}

// packs/workingCopyPool/src/svn.ts
import { existsSync as existsSync6, readdirSync, statSync as statSync2 } from "node:fs";
import path9 from "node:path";
var SvnError = class extends Error {
  constructor(message, output) {
    super(message);
    this.output = output;
  }
};
var Cancelled = class extends Error {
};
async function svn(ctx, args, options = {}) {
  if (ctx.abortSignal.aborted) throw new Cancelled("\u5DF2\u53D6\u6D88");
  const counter = options.progress ? createUpdateProgress({ total: 0, emit: (message, percent) => ctx.onProgress?.(`${options.progress}\uFF1A${message}`, percent) }) : void 0;
  const result = await runCommand({
    command: "svn",
    args: [...args, "--non-interactive"],
    cwd: ctx.cwd,
    timeoutMs: options.timeoutMs ?? ctx.timeoutMs,
    logFile: ctx.logFile,
    abortSignal: ctx.abortSignal,
    gracefulMs: SVN_GRACEFUL_MS,
    onStdoutLine: counter?.line
  }).done;
  if (result.cancelled) {
    const note = options.wc && existsSync6(path9.join(options.wc, ".svn")) ? await cleanupAfterInterrupt(args, { cwd: options.wc, logFile: ctx.logFile }) : "";
    if (result.timedOut && !ctx.abortSignal.aborted) throw new SvnError(`svn ${args[0]} \u8D85\u65F6${note}`, result.stderr);
    throw new Cancelled(`\u5DF2\u53D6\u6D88${note}`);
  }
  if (!options.allowFail && result.code !== 0) {
    throw new SvnError(tailLines(result.stderr || result.stdout) || `svn ${args[0]} \u9000\u51FA\u7801 ${result.code}`, `${result.stdout}
${result.stderr}`);
  }
  if (counter && result.code === 0) counter.finish();
  return result;
}
function unescapeXml(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function parseInfoXml(xml) {
  const out = [];
  const re = /<entry\b([^>]*)>([\s\S]*?)<\/entry>/g;
  let match;
  while (match = re.exec(xml)) {
    const attrs = match[1];
    const body = match[2];
    const attr2 = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
    const url = /<url>([\s\S]*?)<\/url>/.exec(body)?.[1];
    const commit = /<commit\b[^>]*\brevision="(\d+)"/.exec(body)?.[1];
    out.push({
      path: unescapeXml(attr2("path") ?? "").replace(/\\/g, "/"),
      kind: attr2("kind") ?? "",
      revision: Number(attr2("revision") ?? -1),
      url: unescapeXml(url ?? ""),
      depth: /<depth>([\s\S]*?)<\/depth>/.exec(body)?.[1],
      lastChangedRev: commit ? Number(commit) : void 0
    });
  }
  return out;
}
async function svnInfo(ctx, target, extra = []) {
  const result = await svn(ctx, ["info", "--xml", ...extra, target], { allowFail: true, timeoutMs: Math.min(ctx.timeoutMs, 6e4) });
  if (result.code !== 0) return void 0;
  return parseInfoXml(result.stdout)[0];
}
function parseStatusXml(xml) {
  const out = [];
  const re = /<entry\b([^>]*)>([\s\S]*?)<\/entry>/g;
  let match;
  while (match = re.exec(xml)) {
    const p = /\bpath="([^"]*)"/.exec(match[1])?.[1];
    const wc = /<wc-status\b([^>]*)>([\s\S]*?)<\/wc-status>|<wc-status\b([^>]*)\/>/.exec(match[2]);
    if (p === void 0 || !wc) continue;
    const attrs = wc[1] ?? wc[3] ?? "";
    const body = wc[2] ?? "";
    const attr2 = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
    out.push({
      path: unescapeXml(p).replace(/\\/g, "/"),
      item: attr2("item") ?? "normal",
      props: attr2("props") ?? "none",
      treeConflicted: attr2("tree-conflicted") === "true",
      wcLocked: attr2("wc-locked") === "true",
      switched: attr2("switched") === "true",
      locked: /<lock>/.test(body)
    });
  }
  return out;
}
var VERSIONED_CHANGE = /* @__PURE__ */ new Set(["modified", "added", "deleted", "replaced", "missing"]);
function summarizeStatus(items) {
  const versioned = [];
  const unversioned = [];
  const conflicted = [];
  const tree = [];
  const obstructed = [];
  const locks = [];
  let incomplete = false;
  let switched = false;
  let wcLocked = false;
  for (const it of items) {
    if (it.item === "conflicted" || it.props === "conflicted") conflicted.push(it.path);
    if (it.treeConflicted) tree.push(it.path);
    if (it.item === "obstructed") obstructed.push(it.path);
    if (it.locked) locks.push(it.path);
    if (it.item === "incomplete") incomplete = true;
    if (it.switched) switched = true;
    if (it.wcLocked) wcLocked = true;
    if (it.item === "unversioned") unversioned.push(it);
    else if (VERSIONED_CHANGE.has(it.item) || it.props === "modified") versioned.push(it);
  }
  const list = (xs) => xs.slice(0, 5).join("\u3001") + (xs.length > 5 ? ` \u7B49 ${xs.length} \u4E2A` : "");
  const problems = [];
  if (conflicted.length) problems.push(`\u51B2\u7A81\uFF1A${list(conflicted)}`);
  if (tree.length) problems.push(`\u6811\u51B2\u7A81\uFF1A${list(tree)}`);
  if (obstructed.length) problems.push(`\u8DEF\u5F84\u88AB\u963B\u788D\uFF1A${list(obstructed)}`);
  if (locks.length) problems.push(`\u6301\u6709 svn \u9501\uFF1A${list(locks)}`);
  return { versioned, unversioned, problems, incomplete, switched, wcLocked };
}
async function svnStatus(ctx, wc, timeoutMs) {
  const result = await svn(ctx, ["status", "--xml", wc], { timeoutMs: timeoutMs ?? Math.min(ctx.timeoutMs, 10 * 6e4) });
  return summarizeStatus(parseStatusXml(result.stdout).map((it) => ({ ...it, path: relTo(wc, it.path, ctx.cwd) })));
}
function relTo(wc, p, cwd) {
  const norm = (cwd && !path9.isAbsolute(p) ? path9.resolve(cwd, p) : p).replace(/\\/g, "/");
  const root = wc.replace(/\\/g, "/").replace(/\/+$/, "");
  if (norm === root) return ".";
  if (norm.startsWith(`${root}/`)) return norm.slice(root.length + 1);
  return norm;
}
function isObstruction(text) {
  return /E155000|E155037|E195016|obstruct|tree conflict|树冲突|阻碍/i.test(text);
}
function sparseParents(exclude) {
  const parents = /* @__PURE__ */ new Set();
  for (const item of exclude) {
    const parts = item.split("/");
    for (let i = 0; i < parts.length; i++) parents.add(parts.slice(0, i).join("/"));
  }
  return parents;
}
function localChildDirs(dir) {
  if (!existsSync6(dir)) return [];
  return readdirSync(dir).filter((name) => name !== ".svn").filter((name) => {
    try {
      return statSync2(path9.join(dir, name)).isDirectory();
    } catch {
      return false;
    }
  }).sort();
}
function abs(wc, rel) {
  return rel ? path9.join(wc, ...rel.split("/")) : wc;
}
async function setDepth(ctx, wc, depth, rels, label) {
  for (let i = 0; i < rels.length; i += 50) {
    const batch = rels.slice(i, i + 50).map((rel) => abs(wc, rel));
    await svn(ctx, ["update", "--set-depth", depth, ...batch], { wc, progress: label });
  }
}
async function sparseCheckout(ctx, url, wc, exclude) {
  if (exclude.length === 0) {
    await svn(ctx, ["checkout", url, wc], { wc, progress: "\u68C0\u51FA" });
    return;
  }
  await svn(ctx, ["checkout", "--depth", "empty", url, wc], { wc });
  await expandLevel(ctx, wc, "", new Set(exclude), sparseParents(exclude));
}
async function expandLevel(ctx, wc, rel, exclude, parents) {
  await svn(ctx, ["update", "--set-depth", "immediates", abs(wc, rel)], { wc });
  const toExclude = [];
  const toFull = [];
  const toRecurse = [];
  for (const name of localChildDirs(abs(wc, rel))) {
    const child = rel ? `${rel}/${name}` : name;
    if (exclude.has(child)) toExclude.push(child);
    else if (parents.has(child)) toRecurse.push(child);
    else toFull.push(child);
  }
  if (toExclude.length) await setDepth(ctx, wc, "exclude", toExclude, "\u6392\u9664");
  if (toFull.length) await setDepth(ctx, wc, "infinity", toFull, "\u68C0\u51FA");
  for (const child of toRecurse) await expandLevel(ctx, wc, child, exclude, parents);
}
async function reapplySparse(ctx, wc, exclude) {
  if (exclude.length === 0) return [];
  const excludeSet = new Set(exclude);
  const parents = sparseParents(exclude);
  const notes = [];
  const walk = async (rel) => {
    const result = await svn(ctx, ["info", "--xml", "--depth", "immediates", abs(wc, rel)], { allowFail: true });
    if (result.code !== 0) return;
    const entries = parseInfoXml(result.stdout);
    const self = entries.find((e) => relTo(wc, e.path, ctx.cwd) === (rel || "."));
    if (self && self.depth !== "immediates" && self.depth !== "infinity") {
      await svn(ctx, ["update", "--set-depth", "immediates", abs(wc, rel)], { wc });
      notes.push(`\u5C55\u5F00 ${rel || "."}`);
      return walk(rel);
    }
    const toExclude = [];
    const toFull = [];
    const toRecurse = [];
    for (const entry of entries) {
      const child = relTo(wc, entry.path, ctx.cwd);
      if (child === (rel || ".") || entry.kind !== "dir") continue;
      if (entry.depth === "exclude") continue;
      if (excludeSet.has(child)) toExclude.push(child);
      else if (parents.has(child)) toRecurse.push(child);
      else if (entry.depth && entry.depth !== "infinity") toFull.push(child);
    }
    if (toExclude.length) {
      await setDepth(ctx, wc, "exclude", toExclude, "\u6392\u9664");
      notes.push(`\u6392\u9664 ${toExclude.join("\u3001")}`);
    }
    if (toFull.length) {
      await setDepth(ctx, wc, "infinity", toFull, "\u68C0\u51FA");
      notes.push(`\u8865\u5168 ${toFull.join("\u3001")}`);
    }
    for (const child of toRecurse) await walk(child);
  };
  await walk("");
  return notes;
}
async function behindCount(ctx, wc) {
  const local = await svnInfo(ctx, wc);
  if (!local) return void 0;
  const remote = await svnInfo(ctx, local.url, ["-r", "HEAD"]);
  if (!remote || remote.lastChangedRev === void 0) return void 0;
  if (remote.lastChangedRev <= local.revision) return 0;
  const log = await svn(ctx, ["log", "-q", "-r", `${local.revision + 1}:HEAD`, local.url], { allowFail: true, timeoutMs: 6e4 });
  if (log.code !== 0) return void 0;
  return log.stdout.split(/\r?\n/).filter((line) => /^r\d+ /.test(line)).length;
}
async function svnBusy(wc, abortSignal) {
  if (process.platform === "win32") {
    const list = await listOccupants(wc, abortSignal);
    return list.some((item) => /(^|[\\/])svn(\.exe)?$/i.test(item.name) || /^svn/i.test(path9.parse(item.name).name));
  }
  try {
    const result = await spawnCaptured({ command: "ps", args: ["-Ao", "pid=,command="], timeoutMs: 1e4, abortSignal });
    const needle = path9.resolve(wc);
    return result.stdout.split(/\r?\n/).some((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match || Number(match[1]) === process.pid) return false;
      const command = match[2];
      return /(^|\/)svn\s/.test(command) && command.includes(needle);
    });
  } catch {
    return false;
  }
}

// packs/workingCopyPool/src/archive.ts
function archiveStamp(now) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
async function archiveChanges(ctx, paths, wc, branch, now, status3) {
  const st = status3 ?? await svnStatus(ctx, wc);
  if (st.problems.length > 0) {
    return { versioned: st.versioned.length, unversioned: st.unversioned.length, blocked: st.problems.join("\uFF1B") };
  }
  if (st.versioned.length === 0 && st.unversioned.length === 0) {
    return { versioned: 0, unversioned: 0 };
  }
  const base = path10.join(paths.patches, branchDirName(branch || "_unknown"), archiveStamp(now));
  let dir = base;
  for (let i = 2; existsSync7(dir); i++) dir = `${base}_${i}`;
  mkdirSync6(dir, { recursive: true });
  if (st.versioned.length > 0) {
    const diff = await svn(ctx, ["diff", "--internal-diff", wc], { timeoutMs: Math.min(ctx.timeoutMs, 30 * 6e4) });
    writeFileSync5(path10.join(dir, "changes.patch"), toRelativePatch(diff.stdout, wc), "utf8");
    const copied = [];
    for (const it of st.versioned) {
      if (it.item !== "modified" && it.item !== "added" && it.item !== "replaced") continue;
      const from = path10.join(wc, ...it.path.split("/"));
      try {
        if (!statSync3(from).isFile()) continue;
      } catch {
        continue;
      }
      const to = path10.join(dir, "files", ...it.path.split("/"));
      mkdirSync6(path10.dirname(to), { recursive: true });
      copyFileSync(from, to);
      copied.push(it.path);
    }
    writeFileSync5(
      path10.join(dir, "versioned.txt"),
      `${st.versioned.map((it) => `${it.item.padEnd(9)} ${it.path}`).join("\n")}
`,
      "utf8"
    );
    await svn(ctx, ["revert", "-R", wc], { wc, timeoutMs: Math.min(ctx.timeoutMs, 30 * 6e4) });
  }
  if (st.unversioned.length > 0) {
    writeFileSync5(path10.join(dir, "unversioned.txt"), `${st.unversioned.map((it) => it.path).join("\n")}
`, "utf8");
  }
  writeFileSync5(
    path10.join(dir, "README.txt"),
    [
      `\u5206\u652F\uFF1A${branch}`,
      `\u65F6\u95F4\uFF1A${now.toISOString()}`,
      `\u53D7\u7248\u672C\u63A7\u5236\u7684\u6539\u52A8 ${st.versioned.length} \u9879\uFF08changes.patch\uFF1B\u6539\u52A8\u6587\u4EF6\u539F\u6837\u62F7\u5728 files/\uFF09`,
      `\u672A\u7EB3\u7BA1\u6587\u4EF6 ${st.unversioned.length} \u9879\uFF08unversioned.txt\uFF0C\u4EC5\u6E05\u5355\uFF0C\u6587\u4EF6\u4ECD\u7559\u5728\u5DE5\u4F5C\u526F\u672C\u91CC\uFF09`,
      "\u6062\u590D\uFF1A\u5728\u8BE5\u5206\u652F\u7684\u5DE5\u4F5C\u526F\u672C\u6839\u6267\u884C svn patch <\u672C\u76EE\u5F55>/changes.patch\uFF1B\u4E8C\u8FDB\u5236\u6587\u4EF6\u4ECE files/ \u62F7\u56DE\u3002",
      ""
    ].join("\n"),
    "utf8"
  );
  return { dir, versioned: st.versioned.length, unversioned: st.unversioned.length };
}
function toRelativePatch(diff, wc) {
  const variants = [wc, wc.replace(/\\/g, "/")].map((p) => p.replace(/[\\/]+$/, ""));
  let out = diff;
  for (const v of new Set(variants)) {
    out = out.split(`${v}/`).join("").split(`${v}\\`).join("");
  }
  return out;
}
function linkExists(link) {
  try {
    lstatSync(link);
    return true;
  } catch {
    return false;
  }
}
function isLink(link) {
  try {
    return lstatSync(link).isSymbolicLink() || process.platform === "win32" && isJunction(link);
  } catch {
    return false;
  }
}
function isJunction(link) {
  try {
    readlinkSync(link);
    return true;
  } catch {
    return false;
  }
}
function linkTarget(link) {
  try {
    return path10.resolve(path10.dirname(link), readlinkSync(link));
  } catch {
    return void 0;
  }
}
function removeLink(link) {
  if (!linkExists(link)) return;
  if (!isLink(link)) throw new Error(`${link} \u4E0D\u662F\u94FE\u63A5\uFF0C\u6C60\u5B50\u4E0D\u5220\u9664\u5B83`);
  try {
    unlinkSync3(link);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    rmSync2(link, { force: true });
  }
}
function createLink(target, link) {
  if (linkExists(link)) {
    if (isLink(link) && samePath(linkTarget(link), target)) return;
    removeLink(link);
  }
  mkdirSync6(path10.dirname(link), { recursive: true });
  symlinkSync(path10.resolve(target), link, process.platform === "win32" ? "junction" : "dir");
}
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    const r = path10.resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

// packs/workingCopyPool/src/pool.ts
function openPool(ctx, now = () => /* @__PURE__ */ new Date()) {
  const root = path11.resolve(ctx.cwd);
  const config = loadConfig(root);
  const paths = poolPaths(root);
  ensureLayout(paths);
  return { root, paths, config, ctx, now };
}
function svnCtx(pool) {
  return { ...pool.ctx, cwd: pool.root };
}
function stage(pool, message) {
  pool.ctx.onProgress?.(message, null);
  appendLog(pool.ctx.logFile, `[workingCopyPool] ${message}`);
}
function timeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
function fmtTime(iso) {
  if (!iso) return "";
  if (iso === "forever") return "\u6C38\u4E45";
  return displayTime(iso, timeZone()).slice(5, 16);
}
function describeLease(lease, now) {
  if (!leaseActive(lease, now)) return "";
  const until = lease.until === "forever" ? "\u6C38\u4E45" : `\u5230 ${fmtTime(lease.until)}`;
  return `${until}${lease.tag ? `\uFF08${lease.tag}\uFF09` : ""}`;
}
function slotState(slot, config, now) {
  if (slot.op && !pidAlive(slot.op.pid)) return "interrupted";
  if (slot.phase === "switching") return "switching";
  if (slot.phase === "retiring") return "retiring";
  if (slot.phase === "blocked") return "blocked";
  if (leaseActive(slot.lease, now)) return "occupied";
  if (isResident(slot, config)) return "resident";
  return "idle";
}
function viewSlots(pool, state) {
  const now = pool.now();
  return state.slots.map((slot) => ({
    id: slot.id,
    branch: slot.branch,
    state: slotState(slot, pool.config, now),
    phase: slot.phase,
    lease: leaseActive(slot.lease, now) ? slot.lease : null,
    lastUsed: slot.lastUsed ?? null,
    behind: typeof slot.behind === "number" ? slot.behind : null,
    blockedReason: slot.blockedReason ?? null,
    path: slotDir(pool.paths, slot.id),
    link: slot.branch ? branchLink(pool.paths, slot.branch) : null,
    target: slot.op?.target ?? null
  }));
}
function poolView(pool, state) {
  return { root: pool.root, maxSlots: pool.config.maxSlots, resident: pool.config.resident, slots: viewSlots(pool, state) };
}
var STATE_TEXT = {
  occupied: "\u5360\u7528",
  resident: "\u5E38\u9A7B",
  idle: "\u7A7A\u95F2",
  switching: "\u5207\u6362\u4E2D",
  blocked: "\u963B\u585E",
  retiring: "\u5220\u9664\u4E2D",
  interrupted: "\u4E2D\u65AD\u5F85\u6062\u590D"
};
function describeSlot(view, now) {
  const parts = [`${view.id} ${view.branch || "(\u672A\u5B9A)"}`, STATE_TEXT[view.state]];
  if (view.lease) parts.push(`\u79DF\u7EA6${describeLease(view.lease, now)}`);
  if (view.target && (view.state === "switching" || view.state === "interrupted")) parts.push(`\u2192 ${view.target}`);
  if (view.behind !== null && view.behind > 0) parts.push(`\u843D\u540E ${view.behind}`);
  if (view.blockedReason) parts.push(view.blockedReason);
  if (view.lastUsed) parts.push(`\u6700\u540E\u4F7F\u7528 ${fmtTime(view.lastUsed)}`);
  return parts.join("\uFF0C");
}
async function releaseSlotOccupants(pool, wc) {
  if (process.platform !== "win32" || !existsSync8(wc)) return void 0;
  stage(pool, `\u91CA\u653E ${path11.basename(wc)} \u7684\u5360\u7528`);
  const prepared = await prepareExclusiveAccess({ target: wc, abortSignal: pool.ctx.abortSignal, includeUnityByName: false });
  if (prepared.remaining.length > 0) {
    throw new Error(`\u65E0\u6CD5\u91CA\u653E\u5360\u7528\uFF1A${prepared.remaining.map((o) => `${o.name}(${o.pid})`).join(", ")}\uFF0C\u8BF7\u5148\u5173\u95ED\u540E\u518D\u8BD5`);
  }
  if (prepared.closed.length === 0) return void 0;
  return `\u5DF2\u5173\u95ED ${prepared.closed.map((o) => `${o.name}(${o.pid})`).join(", ")}`;
}
async function dropLink(pool, link, wc, notes) {
  try {
    removeLink(link);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    const released = await releaseSlotOccupants(pool, wc);
    if (released) notes.push(released);
    removeLink(link);
  }
}
function restoreLink(pool, slot) {
  if (!slot.branch) return;
  try {
    createLink(slotDir(pool.paths, slot.id), branchLink(pool.paths, slot.branch));
  } catch (error) {
    appendLog(pool.ctx.logFile, `[workingCopyPool] \u6062\u590D\u94FE\u63A5\u5931\u8D25 ${slot.branch}: ${String(error)}`);
  }
}
function findSlot(state, id) {
  const slot = state.slots.find((s) => s.id === id);
  if (!slot) throw new Error(`\u69FD\u4F4D ${id} \u4E0D\u5728\u72B6\u6001\u6587\u4EF6\u91CC\uFF08\u88AB\u5176\u4ED6\u8FDB\u7A0B\u5220\u4E86\uFF1F\uFF09`);
  return slot;
}
function ourOp(slot) {
  return slot.op?.pid === process.pid;
}
async function recover(pool) {
  const claimed = await mutate(pool.paths, (state) => {
    const out = [];
    for (const slot of state.slots) {
      if (!isInterrupted(slot)) continue;
      out.push({ id: slot.id, op: { ...slot.op }, branch: slot.branch });
      slot.op = { ...slot.op, pid: process.pid, at: pool.now().toISOString() };
    }
    return out;
  });
  const notes = [];
  for (const item of claimed) {
    try {
      notes.push(await recoverSlot(pool, item.id, item.op, item.branch));
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      const message = error instanceof Error ? error.message : String(error);
      await mutate(pool.paths, (state) => {
        const slot = state.slots.find((s) => s.id === item.id);
        if (slot && ourOp(slot)) {
          slot.phase = "blocked";
          slot.blockedReason = `\u4E2D\u65AD\u6062\u590D\u5931\u8D25\uFF1A${message}`;
          slot.op = void 0;
        }
      });
      notes.push(`${item.id} \u4E2D\u65AD\u6062\u590D\u5931\u8D25\uFF0C\u5DF2\u6807\u4E3A\u963B\u585E\uFF1A${message}`);
    }
  }
  return notes;
}
async function recoverSlot(pool, id, op, branch) {
  const wc = slotDir(pool.paths, id);
  const sctx = svnCtx(pool);
  const removeSlot = async (why) => {
    if (existsSync8(wc)) rmSync3(wc, { recursive: true, force: true, maxRetries: 3 });
    await mutate(pool.paths, (state) => {
      state.slots = state.slots.filter((s) => s.id !== id);
    });
    return `${id} ${why}\uFF0C\u5DF2\u5220\u9664\u69FD\u4F4D`;
  };
  if (op.kind === "delete") return removeSlot("\u5220\u9664\u4E2D\u65AD");
  if (!existsSync8(path11.join(wc, ".svn"))) return removeSlot(op.kind === "create" ? "\u65B0\u5EFA\u4E2D\u65AD" : "\u5DE5\u4F5C\u526F\u672C\u7F3A\u5931");
  if (await svnBusy(wc, pool.ctx.abortSignal)) {
    await mutate(pool.paths, (state) => {
      const slot = state.slots.find((s) => s.id === id);
      if (slot && ourOp(slot)) slot.op = op;
    });
    return `${id} \u6709 svn \u8FDB\u7A0B\u6B63\u5728\u64CD\u4F5C\uFF0C\u6682\u4E0D\u6062\u590D`;
  }
  let info = await svnInfo(sctx, wc);
  const st0 = info ? await svnStatus(sctx, wc).catch(() => void 0) : void 0;
  if (!info || !st0 || st0.wcLocked) {
    stage(pool, `${id} svn cleanup`);
    await svn(sctx, ["cleanup", wc], { allowFail: true });
    info = await svnInfo(sctx, wc);
  }
  if (!info) {
    if (op.kind === "create") return removeSlot("\u65B0\u5EFA\u4E2D\u65AD");
    throw new Error("\u8BFB\u4E0D\u51FA svn info");
  }
  const st = await svnStatus(sctx, wc);
  const actual = branchFromUrl(pool.config, info.url) ?? "";
  const target = op.kind === "create" || op.kind === "switch" ? op.target : branch;
  let complete = Boolean(target) && sameUrl(info.url, branchUrl(pool.config, target)) && !st.incomplete && !st.wcLocked;
  if (complete && op.kind === "create" && pool.config.sparse.exclude.length > 0) {
    await reapplySparse(sctx, wc, pool.config.sparse.exclude);
  }
  const done = await mutate(pool.paths, (state) => {
    const slot = findSlot(state, id);
    if (!ourOp(slot)) return false;
    slot.url = info.url;
    slot.branch = complete ? target : st.incomplete ? "" : actual;
    slot.phase = "ready";
    slot.blockedReason = void 0;
    slot.op = void 0;
    return true;
  });
  if (!done) return `${id} \u5DF2\u88AB\u5176\u4ED6\u8FDB\u7A0B\u63A5\u624B`;
  const fresh = findSlot(readState(pool.paths), id);
  if (fresh.branch) restoreLink(pool, fresh);
  complete = complete && Boolean(fresh.branch);
  return complete ? `${id} \u4E2D\u65AD\u524D\u5DF2\u5B8C\u6210 ${target}\uFF0C\u5DF2\u8865\u5EFA\u5165\u53E3` : `${id} \u4E2D\u65AD\u65F6\u672A\u5B8C\u6210${target ? ` ${target}` : ""}\uFF0C\u5F53\u524D ${fresh.branch || "\u72B6\u6001\u4E0D\u660E"}\uFF0C\u4E0B\u6B21\u5360\u7528\u65F6\u91CD\u65B0\u5207\u6362`;
}
function claimSlot(state, config, branch, lease, now, excluded = /* @__PURE__ */ new Set()) {
  const existing = state.slots.find((s) => s.branch === branch && (s.phase === "ready" || s.phase === "blocked") && !s.op);
  if (existing) {
    if (lease) existing.lease = laterLease(leaseActive(existing.lease, now) ? existing.lease : null, lease);
    existing.lastUsed = now.toISOString();
    return { kind: "hit", slot: { ...existing } };
  }
  const moving = state.slots.find((s) => s.op && (s.op.target === branch || s.branch === branch) && pidAlive(s.op.pid));
  if (moving) return { kind: "busy", slot: { ...moving } };
  const idle = state.slots.filter((s) => isIdle(s, config, now) && !s.op && !excluded.has(s.id)).sort((a, b) => (a.lastUsed ?? "").localeCompare(b.lastUsed ?? "") || a.id.localeCompare(b.id));
  const op = (kind, from) => ({ kind, target: branch, pid: process.pid, at: now.toISOString(), lease, from });
  if (idle.length > 0) {
    const slot = idle[0];
    slot.phase = "switching";
    slot.op = op("switch", slot.branch);
    return { kind: "switch", slot: { ...slot } };
  }
  if (state.slots.length < config.maxSlots) {
    const slot = { id: nextSlotId(state), branch: "", url: "", phase: "switching", lease: null, op: op("create") };
    state.slots.push(slot);
    return { kind: "create", slot: { ...slot } };
  }
  return { kind: "full", slots: state.slots.map((s) => ({ ...s })) };
}
function describeFull(pool, slots) {
  const now = pool.now();
  const lines = viewSlots(pool, { version: 1, slots }).map((v) => `  ${describeSlot(v, now)}`);
  return `\u6C60\u6EE1\uFF08${slots.length}/${pool.config.maxSlots}\uFF09\uFF0C\u6CA1\u6709\u53EF\u7528\u69FD\u4F4D\uFF1A
${lines.join("\n")}
\u53EF\u4EE5\u91CA\u653E\u4E00\u4E2A\u5206\u652F\u3001\u7B49\u79DF\u7EA6\u5230\u671F\uFF0C\u6216\u8C03\u5927 pool.toml \u7684 maxSlots`;
}
async function obtain(pool, branch, lease) {
  if (!isBranchName(branch)) throw new UsageError(`\u5206\u652F\u540D\u4E0D\u5408\u6CD5\uFF1A${branch}`);
  const url = branchUrl(pool.config, branch);
  const sctx = svnCtx(pool);
  const notes = [];
  const peek = readState(pool.paths).slots.some((s) => s.branch === branch && (s.phase === "ready" || s.phase === "blocked") && !s.op);
  if (!peek) {
    stage(pool, `\u68C0\u67E5\u5206\u652F ${branch}`);
    const remote = await svnInfo(sctx, url);
    if (!remote) throw new Error(`\u5206\u652F\u4E0D\u5B58\u5728\u6216\u4ED3\u5E93\u4E0D\u53EF\u8FBE\uFF1A${url}`);
  }
  const skipped = /* @__PURE__ */ new Set();
  for (; ; ) {
    const now = pool.now();
    const claim = await mutate(pool.paths, (state) => claimSlot(state, pool.config, branch, lease, now, skipped));
    if (claim.kind === "full") throw new Error(describeFull(pool, claim.slots));
    if (claim.kind === "busy") throw new Error(`${branch} \u6B63\u5728 ${claim.slot.id} \u4E0A\u88AB\u53E6\u4E00\u4E2A\u4EFB\u52A1\u5904\u7406\uFF0C\u7A0D\u540E\u518D\u8BD5`);
    if (claim.kind === "hit") {
      const wc2 = slotDir(pool.paths, claim.slot.id);
      restoreLink(pool, claim.slot);
      if (claim.slot.phase === "blocked") notes.push(`\u6CE8\u610F\uFF1A${claim.slot.id} \u5904\u4E8E\u963B\u585E\uFF08${claim.slot.blockedReason ?? "\u539F\u56E0\u672A\u8BB0\u5F55"}\uFF09\uFF0C\u8BF7\u5148\u5904\u7406`);
      const behind2 = await behindCount(sctx, wc2).catch(() => void 0);
      await mutate(pool.paths, (state) => {
        const slot = state.slots.find((s) => s.id === claim.slot.id);
        if (slot && behind2 !== void 0) slot.behind = behind2;
      });
      if (lease) appendHistory(pool.paths, { at: now.toISOString(), action: "acquire", branch, slot: claim.slot.id });
      return { slot: claim.slot.id, branch, mode: "hit", behind: behind2, notes };
    }
    const result = claim.kind === "create" ? await createFlow(pool, claim.slot, branch, url, notes) : await switchFlow(pool, claim.slot, branch, url, notes);
    if (result === "blocked") {
      skipped.add(claim.slot.id);
      continue;
    }
    const wc = slotDir(pool.paths, claim.slot.id);
    const behind = await behindCount(sctx, wc).catch(() => void 0);
    const done = pool.now();
    await mutate(pool.paths, (state) => {
      const slot = findSlot(state, claim.slot.id);
      slot.phase = "ready";
      slot.branch = branch;
      slot.url = result.url;
      slot.lease = lease;
      slot.lastUsed = done.toISOString();
      slot.behind = behind;
      slot.blockedReason = void 0;
      slot.op = void 0;
    });
    createLink(wc, branchLink(pool.paths, branch));
    appendHistory(pool.paths, { at: done.toISOString(), action: lease ? "acquire" : "prepare", branch, slot: claim.slot.id });
    return { slot: claim.slot.id, branch, mode: claim.kind, behind, notes };
  }
}
async function finishCheck(pool, wc, url) {
  const info = await svnInfo(svnCtx(pool), wc);
  if (!info) throw new Error("\u5207\u6362\u540E\u8BFB\u4E0D\u51FA svn info");
  if (!sameUrl(info.url, url)) throw new Error(`\u5207\u6362\u540E URL \u4E0D\u7B26\uFF1A${info.url}\uFF0C\u5E94\u4E3A ${url}`);
  return { url: info.url };
}
async function switchFlow(pool, claimed, branch, url, notes) {
  const wc = slotDir(pool.paths, claimed.id);
  const sctx = svnCtx(pool);
  const from = claimed.branch;
  const back = async (patch) => {
    await mutate(pool.paths, (state) => {
      const slot = findSlot(state, claimed.id);
      Object.assign(slot, { phase: "ready", op: void 0 }, patch);
    });
    const fresh = findSlot(readState(pool.paths), claimed.id);
    restoreLink(pool, fresh);
  };
  stage(pool, `${claimed.id}\uFF1A${from || "(\u672A\u5B9A)"} \u2192 ${branch}`);
  if (from) {
    const link = branchLink(pool.paths, from);
    if (linkExists(link) && samePath(linkTarget(link), wc)) await dropLink(pool, link, wc, notes);
  }
  try {
    stage(pool, `${claimed.id}\uFF1A\u5B58\u6863\u672C\u5730\u6539\u52A8`);
    const archived = await archiveChanges(sctx, pool.paths, wc, from, pool.now());
    if (archived.blocked) {
      await back({ phase: "blocked", blockedReason: archived.blocked });
      notes.push(`${claimed.id}\uFF08${from}\uFF09\u6709\u9700\u8981\u4EBA\u5904\u7406\u7684\u95EE\u9898\uFF0C\u5DF2\u6807\u4E3A\u963B\u585E\uFF1A${archived.blocked}`);
      return "blocked";
    }
    if (archived.dir) notes.push(`${from} \u7684\u6539\u52A8\u5DF2\u5B58\u6863\u5230 ${archived.dir}\uFF08\u53D7\u63A7 ${archived.versioned}\uFF0C\u672A\u7EB3\u7BA1 ${archived.unversioned}\uFF09`);
  } catch (error) {
    if (error instanceof Cancelled) throw error;
    await back({});
    throw error;
  }
  try {
    const released = await releaseSlotOccupants(pool, wc);
    if (released) notes.push(released);
  } catch (error) {
    await back({});
    throw error;
  }
  try {
    stage(pool, `${claimed.id}\uFF1Asvn switch ${url}`);
    await svn(sctx, ["switch", "--ignore-ancestry", url, wc], { wc, progress: "\u5207\u6362" });
    const sparse = await reapplySparse(sctx, wc, pool.config.sparse.exclude);
    if (sparse.length) notes.push(`\u7A00\u758F\uFF1A${sparse.join("\uFF1B")}`);
    return await finishCheck(pool, wc, url);
  } catch (error) {
    if (error instanceof Cancelled) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const info = await svnInfo(sctx, wc).catch(() => void 0);
    const actual = info ? branchFromUrl(pool.config, info.url) ?? "" : "";
    if (error instanceof SvnError && isObstruction(`${message}
${error.output}`)) {
      await back({ phase: "blocked", blockedReason: `\u5207\u6362\u5230 ${branch} \u88AB\u963B\u788D\uFF1A${message}`, branch: actual, url: info?.url ?? "" });
      notes.push(`${claimed.id} \u5207\u6362\u88AB\u963B\u788D\uFF0C\u5DF2\u6807\u4E3A\u963B\u585E\uFF1A${message}`);
      return "blocked";
    }
    await back({ branch: actual === branch ? "" : actual, url: info?.url ?? "" });
    throw error;
  }
}
async function createFlow(pool, claimed, branch, url, notes) {
  const wc = slotDir(pool.paths, claimed.id);
  const sctx = svnCtx(pool);
  if (existsSync8(wc)) rmSync3(wc, { recursive: true, force: true, maxRetries: 3 });
  const exclude = pool.config.sparse.exclude;
  stage(pool, `${claimed.id}\uFF1A\u65B0\u5EFA ${branch}${exclude.length ? `\uFF08\u6392\u9664 ${exclude.join("\u3001")}\uFF09` : ""}`);
  try {
    await sparseCheckout(sctx, url, wc, exclude);
    notes.push(`\u65B0\u5EFA\u69FD\u4F4D ${claimed.id}`);
    return await finishCheck(pool, wc, url);
  } catch (error) {
    if (error instanceof Cancelled) throw error;
    rmSync3(wc, { recursive: true, force: true, maxRetries: 3 });
    await mutate(pool.paths, (state) => {
      state.slots = state.slots.filter((s) => s.id !== claimed.id);
    });
    throw error;
  }
}
function acquireSummary(outcome) {
  const mode = { hit: "\u5DF2\u5728\u6C60\u4E2D", switch: "\u5207\u6362", create: "\u65B0\u5EFA" }[outcome.mode];
  const behind = outcome.behind === void 0 ? "\u843D\u540E\u672A\u77E5" : `\u843D\u540E ${outcome.behind}`;
  return `${outcome.branch} \u5C31\u7EEA\uFF08${outcome.slot}\uFF0C${mode}\uFF0C${behind}\uFF09`;
}
async function releaseBranch(pool, branch) {
  const now = pool.now();
  const result = await mutate(pool.paths, (state) => {
    const slot = state.slots.find((s) => s.branch === branch);
    if (!slot) return { released: false, detail: `${branch} \u4E0D\u5728\u6C60\u91CC` };
    if (!leaseActive(slot.lease, now)) {
      slot.lease = null;
      return { released: false, slot: slot.id, detail: `${branch}\uFF08${slot.id}\uFF09\u6CA1\u6709\u6709\u6548\u79DF\u7EA6` };
    }
    slot.lease = null;
    return { released: true, slot: slot.id, detail: `\u5DF2\u91CA\u653E ${branch}\uFF08${slot.id}\uFF09\uFF0C\u5DE5\u4F5C\u526F\u672C\u7559\u5728\u539F\u5206\u652F` };
  });
  if (result.released) appendHistory(pool.paths, { at: now.toISOString(), action: "release", branch, slot: result.slot });
  return result;
}
async function gc2(pool) {
  const report = { recovered: await recover(pool), unblocked: [], blocked: [], retired: [], pendingShrink: [], links: [], patches: 0, errors: [] };
  const sctx = svnCtx(pool);
  for (const slot of readState(pool.paths).slots.filter((s) => s.phase === "blocked" && !s.op)) {
    const wc = slotDir(pool.paths, slot.id);
    try {
      const st = await svnStatus(sctx, wc);
      if (st.problems.length > 0 || st.wcLocked) {
        report.blocked.push(`${slot.id} ${slot.branch}\uFF1A${st.problems.join("\uFF1B") || "\u5DE5\u4F5C\u526F\u672C\u88AB\u9501"}`);
        continue;
      }
      const info = await svnInfo(sctx, wc);
      await mutate(pool.paths, (state) => {
        const s = state.slots.find((x) => x.id === slot.id);
        if (!s || s.phase !== "blocked" || s.op) return;
        s.phase = "ready";
        s.blockedReason = void 0;
        if (info) {
          s.url = info.url;
          s.branch = st.incomplete ? "" : branchFromUrl(pool.config, info.url) ?? "";
        }
      });
      report.unblocked.push(`${slot.id} ${slot.branch}`);
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      report.errors.push(`${slot.id} \u590D\u67E5\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const tried = /* @__PURE__ */ new Set();
  for (; ; ) {
    const now = pool.now();
    const pick = await mutate(pool.paths, (state) => {
      if (state.slots.length <= pool.config.maxSlots) return void 0;
      const idle = state.slots.filter((s) => isIdle(s, pool.config, now) && !s.op && !tried.has(s.id)).sort((a, b) => (a.lastUsed ?? "").localeCompare(b.lastUsed ?? "") || b.id.localeCompare(a.id));
      if (idle.length === 0) return { none: state.slots.length - pool.config.maxSlots };
      const slot = idle[0];
      slot.phase = "retiring";
      slot.op = { kind: "delete", pid: process.pid, at: now.toISOString(), from: slot.branch };
      return { slot: { ...slot } };
    });
    if (!pick) break;
    if ("none" in pick) {
      report.pendingShrink.push(`\u8FD8\u9700\u7F29\u51CF ${pick.none} \u4E2A\u69FD\u4F4D\uFF0C\u7B49\u79DF\u7EA6\u7ED3\u675F\u6216\u963B\u585E\u5904\u7406\u540E\u518D\u56DE\u6536`);
      break;
    }
    tried.add(pick.slot.id);
    try {
      report.retired.push(await retireSlot(pool, pick.slot));
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      report.errors.push(`${pick.slot.id} \u5220\u9664\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
    }
  }
  report.links = syncLinks(pool);
  report.patches = prunePatches(pool);
  return report;
}
async function retireSlot(pool, claimed) {
  const wc = slotDir(pool.paths, claimed.id);
  const notes = [];
  const back = async (patch) => {
    await mutate(pool.paths, (state) => {
      const slot = findSlot(state, claimed.id);
      Object.assign(slot, { phase: "ready", op: void 0 }, patch);
    });
    restoreLink(pool, findSlot(readState(pool.paths), claimed.id));
  };
  if (claimed.branch) {
    const link = branchLink(pool.paths, claimed.branch);
    if (linkExists(link) && samePath(linkTarget(link), wc)) await dropLink(pool, link, wc, notes);
  }
  if (existsSync8(path11.join(wc, ".svn"))) {
    const archived = await archiveChanges(svnCtx(pool), pool.paths, wc, claimed.branch, pool.now()).catch(async (error) => {
      if (error instanceof Cancelled) throw error;
      await back({});
      throw error;
    });
    if (archived.blocked) {
      await back({ phase: "blocked", blockedReason: archived.blocked });
      return `${claimed.id} \u6709\u9700\u8981\u4EBA\u5904\u7406\u7684\u95EE\u9898\uFF0C\u6682\u4E0D\u5220\u9664\uFF1A${archived.blocked}`;
    }
    if (archived.dir) notes.push(`\u6539\u52A8\u5DF2\u5B58\u6863\u5230 ${archived.dir}`);
  }
  try {
    const released = await releaseSlotOccupants(pool, wc);
    if (released) notes.push(released);
  } catch (error) {
    await back({});
    throw error;
  }
  stage(pool, `\u5220\u9664\u69FD\u4F4D ${claimed.id}`);
  rmSync3(wc, { recursive: true, force: true, maxRetries: 3 });
  await mutate(pool.paths, (state) => {
    state.slots = state.slots.filter((s) => s.id !== claimed.id);
  });
  return `\u5DF2\u5220\u9664 ${claimed.id}\uFF08${claimed.branch || "\u672A\u5B9A"}\uFF09${notes.length ? `\uFF1A${notes.join("\uFF1B")}` : ""}`;
}
function syncLinks(pool) {
  const state = readState(pool.paths);
  const notes = [];
  const wanted = /* @__PURE__ */ new Map();
  for (const slot of state.slots) {
    if (!slot.branch || slot.op || slot.phase !== "ready" && slot.phase !== "blocked") continue;
    wanted.set(branchDirName(slot.branch), slotDir(pool.paths, slot.id));
  }
  const busyDirs = new Set(state.slots.filter((s) => s.op).map((s) => slotDir(pool.paths, s.id)));
  if (existsSync8(pool.paths.branch)) {
    for (const name of readdirSync2(pool.paths.branch)) {
      const link = path11.join(pool.paths.branch, name);
      if (!isLink(link)) continue;
      const target = linkTarget(link);
      const want = wanted.get(name);
      if (want && samePath(target, want)) continue;
      if (!want && target && [...busyDirs].some((d) => samePath(d, target))) continue;
      try {
        removeLink(link);
        notes.push(`\u5220\u9664\u5931\u6548\u5165\u53E3 branch/${name}`);
      } catch (error) {
        notes.push(`\u5220\u9664\u5165\u53E3 branch/${name} \u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  for (const [name, dir] of wanted) {
    const link = path11.join(pool.paths.branch, name);
    if (isLink(link) && samePath(linkTarget(link), dir)) continue;
    if (!existsSync8(dir)) continue;
    try {
      createLink(dir, link);
      notes.push(`\u8865\u5EFA\u5165\u53E3 branch/${name}`);
    } catch (error) {
      notes.push(`\u8865\u5EFA\u5165\u53E3 branch/${name} \u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return notes;
}
function prunePatches(pool) {
  const cutoff = pool.now().getTime() - pool.config.patchRetentionDays * 864e5;
  let removed = 0;
  if (!existsSync8(pool.paths.patches)) return 0;
  for (const branch of readdirSync2(pool.paths.patches)) {
    const dir = path11.join(pool.paths.patches, branch);
    if (!statSync4(dir).isDirectory()) continue;
    for (const stamp of readdirSync2(dir)) {
      const entry = path11.join(dir, stamp);
      try {
        if (statSync4(entry).mtimeMs < cutoff) {
          rmSync3(entry, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
      }
    }
    try {
      if (readdirSync2(dir).length === 0) rmSync3(dir, { recursive: true, force: true });
    } catch {
    }
  }
  return removed;
}
async function refresh2(pool) {
  const recovered = await recover(pool);
  const items = [];
  for (const branch of pool.config.resident) {
    try {
      items.push(await refreshOne(pool, branch));
    } catch (error) {
      if (error instanceof Cancelled || pool.ctx.abortSignal.aborted) throw error instanceof Cancelled ? error : new Cancelled("\u5DF2\u53D6\u6D88");
      items.push({ branch, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return { recovered, items };
}
async function refreshOne(pool, branch) {
  const now = pool.now();
  const claim = await mutate(pool.paths, (state) => {
    const slot = state.slots.find((s) => s.branch === branch || s.op?.target === branch);
    if (!slot) return { kind: "absent" };
    if (slot.op) return { kind: "skip", why: `${slot.id} \u6B63\u5728\u88AB\u53E6\u4E00\u4E2A\u4EFB\u52A1\u5904\u7406` };
    if (slot.phase === "blocked") return { kind: "skip", why: `${slot.id} \u963B\u585E\uFF1A${slot.blockedReason ?? ""}` };
    if (slot.phase !== "ready") return { kind: "skip", why: `${slot.id} ${slot.phase}` };
    if (leaseActive(slot.lease, now)) return { kind: "skip", why: `${slot.id} \u88AB\u5360\u7528${describeLease(slot.lease, now)}\uFF0C\u4E0D\u62A2` };
    slot.op = { kind: "update", target: branch, pid: process.pid, at: now.toISOString() };
    return { kind: "update", slot: { ...slot } };
  });
  if (claim.kind === "skip") return { branch, ok: true, skipped: true, detail: `\u8DF3\u8FC7\uFF1A${claim.why}` };
  if (claim.kind === "absent") {
    try {
      const outcome = await obtain(pool, branch, null);
      return { branch, ok: true, detail: `\u5DF2\u51C6\u5907\uFF08${outcome.slot}\uFF0C${outcome.mode === "create" ? "\u65B0\u5EFA" : "\u5207\u6362"}\uFF09${outcome.notes.length ? `\uFF1A${outcome.notes.join("\uFF1B")}` : ""}` };
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("\u6C60\u6EE1")) return { branch, ok: false, detail: "\u672A\u5C31\u7EEA\uFF1A\u6C60\u6EE1" };
      throw error;
    }
  }
  const wc = slotDir(pool.paths, claim.slot.id);
  const sctx = svnCtx(pool);
  stage(pool, `\u66F4\u65B0 ${branch}\uFF08${claim.slot.id}\uFF09`);
  try {
    const result = await svnCheckAndUpdate({
      workingCopy: wc,
      timeoutMs: pool.ctx.timeoutMs,
      logFile: pool.ctx.logFile,
      abortSignal: pool.ctx.abortSignal,
      skipUpdate: false,
      onConflict: "fail",
      releaseOccupants: true,
      onProgress: (message, percent) => pool.ctx.onProgress?.(`${branch}\uFF1A${message}`, percent)
    });
    const sparse = await reapplySparse(sctx, wc, pool.config.sparse.exclude);
    const behind = await behindCount(sctx, wc).catch(() => void 0);
    await mutate(pool.paths, (state) => {
      const slot = state.slots.find((s) => s.id === claim.slot.id);
      if (!slot || !ourOp(slot)) return;
      slot.op = void 0;
      if (behind !== void 0) slot.behind = behind;
    });
    const last = result.detail.split(/\r?\n/).filter(Boolean).pop() ?? "\u5B8C\u6210";
    return { branch, ok: true, detail: `\u5DF2\u66F4\u65B0\uFF08${claim.slot.id}\uFF0C\u843D\u540E ${behind ?? "\u672A\u77E5"}\uFF09${sparse.length ? `\uFF1B\u7A00\u758F\uFF1A${sparse.join("\uFF1B")}` : ""}\uFF1B${last}` };
  } catch (error) {
    if (error instanceof Cancelled || pool.ctx.abortSignal.aborted) throw error;
    await mutate(pool.paths, (state) => {
      const slot = state.slots.find((s) => s.id === claim.slot.id);
      if (slot && ourOp(slot)) slot.op = void 0;
    });
    throw error;
  }
}
function resolveLease(pool, ttl, tag) {
  const value = typeof ttl === "string" && ttl.trim() ? ttl.trim() : pool.config.defaultTtl;
  const lease = { until: leaseUntil(value, pool.now()) };
  if (typeof tag === "string" && tag.trim()) lease.tag = tag.trim();
  return lease;
}

// packs/workingCopyPool/src/queries.ts
import { existsSync as existsSync9, mkdirSync as mkdirSync7, readFileSync as readFileSync3, writeFileSync as writeFileSync6 } from "node:fs";
import path12 from "node:path";
var LIST_CACHE_MS = 10 * 6e4;
var LIST_TIMEOUT_MS = 1e4;
var STATUS_BUDGET_MS = 12e3;
function peekPool(ctx, now = () => /* @__PURE__ */ new Date()) {
  const root = path12.resolve(ctx.cwd);
  return { root, paths: poolPaths(root), config: loadConfig(root), ctx, now };
}
function readOnlyCtx(pool, timeoutMs) {
  return { cwd: pool.root, timeoutMs, logFile: pool.ctx.logFile, abortSignal: pool.ctx.abortSignal };
}
function parseListXml(xml) {
  const out = [];
  for (const m of xml.matchAll(/<entry\b[^>]*kind="dir"[^>]*>([\s\S]*?)<\/entry>/g)) {
    const name = /<name>([\s\S]*?)<\/name>/.exec(m[1])?.[1];
    const date = /<date>([\s\S]*?)<\/date>/.exec(m[1])?.[1];
    if (name) out.push({ name: unescape(name), date: date ?? "" });
  }
  return out;
}
function unescape(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function cacheFile(pool) {
  return path12.join(pool.paths.cache, "list-from.json");
}
function cacheKey(config) {
  return JSON.stringify([config.svnRoot, config.branches.listFrom, config.branches.pattern, config.aliases]);
}
function readCache(pool) {
  try {
    const value = JSON.parse(readFileSync3(cacheFile(pool), "utf8"));
    if (value.key !== cacheKey(pool.config) || !Array.isArray(value.entries)) return void 0;
    return value;
  } catch {
    return void 0;
  }
}
function writeCache(pool, entries) {
  try {
    mkdirSync7(pool.paths.cache, { recursive: true });
    const value = { at: pool.now().toISOString(), key: cacheKey(pool.config), entries };
    writeFileSync6(cacheFile(pool), `${JSON.stringify(value, null, 2)}
`, "utf8");
  } catch {
  }
}
async function listRemoteBranches(pool) {
  const dirs = pool.config.branches.listFrom;
  if (dirs.length === 0 || !existsSync9(path12.join(pool.root, "pool.toml"))) return { entries: [], cached: false };
  const cache = readCache(pool);
  if (cache && pool.now().getTime() - Date.parse(cache.at) < LIST_CACHE_MS) return { entries: cache.entries, cached: true };
  const ctx = readOnlyCtx(pool, LIST_TIMEOUT_MS);
  const entries = [];
  const suffix = pool.config.branches.pattern.split("{name}")[1] ?? "";
  try {
    for (const dir of dirs) {
      const result = await svn(ctx, ["ls", "--xml", `${pool.config.svnRoot}/${dir}`]);
      for (const item of parseListXml(result.stdout)) {
        const branch = branchFromPath(pool.config, `${dir}/${item.name}${suffix}`);
        if (branch) entries.push({ branch, date: item.date });
      }
    }
  } catch (error) {
    if (error instanceof Cancelled) throw error;
    const message = error instanceof Error ? error.message.split(/\r?\n/)[0] : String(error);
    if (cache) return { entries: cache.entries, cached: true, error: `\u8FDC\u7AEF\u5217\u4E0D\u51FA\uFF08${message}\uFF09\uFF0C\u7528 ${fmtTime(cache.at)} \u7684\u7F13\u5B58` };
    return { entries: [], cached: false, error: `\u8FDC\u7AEF\u5217\u4E0D\u51FA\uFF1A${message}` };
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));
  writeCache(pool, entries);
  return { entries, cached: false };
}
function slotHint(view, now) {
  const parts = [];
  switch (view.state) {
    case "occupied":
      parts.push(`\u5DF2\u5360\u7528${describeLease(view.lease, now)}`);
      break;
    case "resident":
      parts.push("\u5E38\u9A7B\uFF0C\u5C31\u7EEA");
      break;
    case "idle":
      parts.push("\u5C31\u7EEA");
      break;
    case "blocked":
      parts.push(`\u963B\u585E\uFF1A${view.blockedReason ?? ""}`);
      break;
    case "switching":
      parts.push("\u5207\u6362\u4E2D");
      break;
    case "retiring":
      parts.push("\u5220\u9664\u4E2D");
      break;
    case "interrupted":
      parts.push("\u4E2D\u65AD\u5F85\u6062\u590D");
      break;
  }
  if (view.behind !== null && view.behind > 0) parts.push(`\u843D\u540E ${view.behind}`);
  return parts.join("\uFF0C");
}
function missHint(state, config, now) {
  if (state.slots.some((s) => isIdle(s, config, now) && !s.op)) return "\u9700\u5207\u6362";
  if (state.slots.length < config.maxSlots) return "\u9700\u65B0\u5EFA\u69FD\u4F4D";
  return "\u6C60\u6EE1\uFF0C\u9700\u5148\u91CA\u653E";
}
function mergeCandidates(input) {
  const { views, state, config, recent, remote, remoteError, now } = input;
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (choice) => {
    if (!choice.value || seen.has(choice.value)) return;
    seen.add(choice.value);
    out.push(choice);
  };
  const miss = missHint(state, config, now);
  const known = new Set(remote.map((r) => r.branch));
  const unchecked = remoteError ? "\uFF08\u8FDC\u7AEF\u4E0D\u53EF\u8FBE\uFF0C\u672A\u6838\u5BF9\uFF09" : "";
  for (const view of views) if (view.branch) push({ value: view.branch, hint: slotHint(view, now) });
  for (const branch of config.resident) push({ value: branch, hint: `\u5E38\u9A7B\uFF0C${miss}` });
  for (const branch of recent) {
    const gone = !remoteError && remote.length > 0 && config.branches.listFrom.length > 0 && !known.has(branch) && !config.aliases[branch];
    push({ value: branch, hint: `\u6700\u8FD1\u4F7F\u7528\uFF0C${miss}${gone ? "\uFF08listFrom \u4E0B\u6CA1\u627E\u5230\uFF0C\u53EF\u80FD\u5DF2\u5220\u9664\uFF09" : unchecked}` });
  }
  const cutoff = now.getTime() - config.branches.recentDays * 864e5;
  for (const item of remote) {
    const at = Date.parse(item.date);
    if (Number.isFinite(at) && at < cutoff) continue;
    push({ value: item.branch, hint: `${item.date ? `\u6700\u8FD1\u63D0\u4EA4 ${fmtTime(item.date)}\uFF0C` : ""}${miss}` });
  }
  return out;
}
async function candidates2(pool) {
  const now = pool.now();
  const state = readState(pool.paths);
  const views = poolView(pool, state).slots;
  const remote = await listRemoteBranches(pool);
  const choices = mergeCandidates({
    views,
    state,
    config: pool.config,
    recent: recentBranches(pool.paths, 20),
    remote: remote.entries,
    remoteError: remote.error,
    now
  });
  const lines = [`${choices.length} \u4E2A\u5019\u9009\u5206\u652F${remote.cached ? "\uFF08\u8FDC\u7AEF\u5217\u8868\u6765\u81EA\u7F13\u5B58\uFF09" : ""}`];
  if (remote.error) lines.push(remote.error);
  return { choices, detail: lines.join("\n") };
}
function occupiedChoices(state, now) {
  return state.slots.filter((s) => s.branch && leaseActive(s.lease, now)).map((s) => ({ value: s.branch, hint: `${s.id}\uFF0C${describeLease(s.lease, now)}` }));
}
function occupied2(pool) {
  const choices = occupiedChoices(readState(pool.paths), pool.now());
  return { choices, detail: choices.length ? `${choices.length} \u4E2A\u5206\u652F\u88AB\u5360\u7528` : "\u6CA1\u6709\u88AB\u5360\u7528\u7684\u5206\u652F" };
}
async function status2(pool) {
  const now = pool.now();
  const state = readState(pool.paths);
  const view = poolView(pool, state);
  const deadline = Date.now() + STATUS_BUDGET_MS;
  const changes = /* @__PURE__ */ new Map();
  let skipped = 0;
  for (const slot of view.slots) {
    const left = deadline - Date.now();
    if (left < 500 || slot.state === "switching" || slot.state === "retiring" || !existsSync9(path12.join(slotDir(pool.paths, slot.id), ".svn"))) {
      if (left < 500) skipped += 1;
      changes.set(slot.id, null);
      continue;
    }
    try {
      const st = await svnStatus(readOnlyCtx(pool, left), slotDir(pool.paths, slot.id), left);
      changes.set(slot.id, { versioned: st.versioned.length, unversioned: st.unversioned.length, problems: st.problems });
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      changes.set(slot.id, null);
    }
  }
  const lines = view.slots.map((v) => {
    const c = changes.get(v.id);
    const text = c ? c.versioned || c.unversioned ? `\uFF0C\u6539\u52A8 ${c.versioned} / \u672A\u7EB3\u7BA1 ${c.unversioned}` : "\uFF0C\u65E0\u6539\u52A8" : "";
    return `${describeSlot(v, now)}${text}`;
  });
  const count = (s) => view.slots.filter((v) => v.state === s).length;
  const summary = `${view.slots.length}/${view.maxSlots} \u4E2A\u69FD\u4F4D\uFF1A\u5360\u7528 ${count("occupied")}\uFF0C\u5E38\u9A7B ${count("resident")}\uFF0C\u7A7A\u95F2 ${count("idle")}${count("blocked") ? `\uFF0C\u963B\u585E ${count("blocked")}` : ""}${count("interrupted") ? `\uFF0C\u4E2D\u65AD ${count("interrupted")}` : ""}`;
  const missingResident = view.resident.filter((b) => !view.slots.some((v) => v.branch === b));
  if (missingResident.length) lines.push(`\u5E38\u9A7B\u5206\u652F\u4E0D\u5728\u6C60\u91CC\uFF1A${missingResident.join("\u3001")}\uFF08\u4E0B\u6B21 refresh \u51C6\u5907\uFF09`);
  if (skipped) lines.push(`${skipped} \u4E2A\u69FD\u4F4D\u8D85\u51FA\u7EDF\u8BA1\u65F6\u95F4\uFF0C\u672A\u8BFB\u6539\u52A8`);
  return {
    summary,
    detail: [summary, ...lines].join("\n"),
    pool: { ...view, slots: view.slots.map((v) => ({ ...v, changes: changes.get(v.id) ?? null })) }
  };
}

// packs/workingCopyPool/src/index.ts
var byId = new Map(manifest.tools.map((t) => [t.id, t]));
async function run(toolId, rawParams, ctx) {
  const tool = byId.get(toolId);
  if (!tool) throw new UsageError(`workingCopyPool \u6CA1\u6709\u5DE5\u5177: ${toolId}`);
  const { params, errors } = validateToolParams(tool, rawParams);
  if (errors.length > 0) throw new UsageError(errors.join("; "));
  if (typeof params.branch === "string" && !isBranchName(params.branch)) throw new UsageError(`\u5206\u652F\u540D\u4E0D\u5408\u6CD5\uFF1A${params.branch}`);
  if (typeof params.ttl === "string" && params.ttl.trim() && params.ttl.trim() !== "forever" && !isTtl(params.ttl.trim())) {
    throw new UsageError(`ttl \u4E0D\u5408\u6CD5\uFF1A${params.ttl}\uFF08\u5982 12h\u30011d\u30013d\u30011w \u6216 forever\uFF09`);
  }
  if (ctx.dryRun) return { detail: dryRun(tool.displayName, toolId, params, ctx), code: 0 };
  switch (toolId) {
    case "candidates": {
      const result = await candidates2(peekPool(ctx));
      return { detail: result.detail, code: 0, choices: result.choices };
    }
    case "occupied": {
      const result = occupied2(peekPool(ctx));
      return { detail: result.detail, code: 0, choices: result.choices };
    }
    case "status": {
      const result = await status2(peekPool(ctx));
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
    default:
      throw new UsageError(`\u672A\u5B9E\u73B0\u5DE5\u5177: ${toolId}`);
  }
}
async function runAcquire(params, ctx) {
  const pool = openPool(ctx);
  const recovered = await recover(pool);
  const branch = String(params.branch);
  const lease = resolveLease(pool, params.ttl, params.tag);
  const outcome = await obtain(pool, branch, lease);
  const summary = acquireSummary(outcome);
  const view = poolView(pool, readState(pool.paths));
  const entry = view.slots.find((s) => s.id === outcome.slot)?.link ?? "";
  const lines = [summary, `\u5165\u53E3\uFF1A${entry}`];
  if (outcome.notes.length) lines.push(...outcome.notes);
  if (recovered.length) lines.push(`\u4E2D\u65AD\u6062\u590D\uFF1A${recovered.join("\uFF1B")}`);
  return { detail: lines.join("\n"), code: 0, summary, pool: view };
}
async function runGc(ctx) {
  const pool = openPool(ctx);
  const report = await gc2(pool);
  const lines = [];
  const section = (title, items) => {
    if (items.length) lines.push(`${title}\uFF1A`, ...items.map((s) => `  ${s}`));
  };
  section("\u4E2D\u65AD\u6062\u590D", report.recovered);
  section("\u89E3\u9664\u963B\u585E", report.unblocked);
  section("\u4ECD\u963B\u585E", report.blocked);
  section("\u5DF2\u56DE\u6536", report.retired);
  section("\u5F85\u7F29\u5BB9", report.pendingShrink);
  section("\u5165\u53E3", report.links);
  section("\u5931\u8D25", report.errors);
  if (report.patches) lines.push(`\u5220\u9664\u8FC7\u671F\u5B58\u6863 ${report.patches} \u4E2A`);
  const summary = `\u56DE\u6536 ${report.retired.length}\uFF0C\u963B\u585E ${report.blocked.length}\uFF0C\u5F85\u7F29\u5BB9 ${report.pendingShrink.length ? "\u6709" : "\u65E0"}${report.errors.length ? `\uFF0C\u5931\u8D25 ${report.errors.length}` : ""}`;
  return { detail: [summary, ...lines].join("\n"), code: report.errors.length ? 1 : 0, summary };
}
async function runRefresh(ctx) {
  const pool = openPool(ctx);
  if (pool.config.resident.length === 0) {
    const recovered = await recover(pool);
    return { detail: `pool.toml \u6CA1\u6709\u5E38\u9A7B\u5206\u652F${recovered.length ? `\uFF1B\u4E2D\u65AD\u6062\u590D\uFF1A${recovered.join("\uFF1B")}` : ""}`, code: 0, skipped: true };
  }
  const result = await refresh2(pool);
  const failed = result.items.filter((i) => !i.ok);
  const lines = result.items.map((i) => `${i.ok ? i.skipped ? "-" : "\u2713" : "\u2717"} ${i.branch}\uFF1A${i.detail}`);
  if (result.recovered.length) lines.push(`\u4E2D\u65AD\u6062\u590D\uFF1A${result.recovered.join("\uFF1B")}`);
  const summary = `\u5E38\u9A7B ${result.items.length} \u4E2A\uFF1A\u6210\u529F ${result.items.filter((i) => i.ok && !i.skipped).length}\uFF0C\u8DF3\u8FC7 ${result.items.filter((i) => i.skipped).length}\uFF0C\u5931\u8D25 ${failed.length}`;
  return { detail: [summary, ...lines].join("\n"), code: failed.length ? 1 : 0, summary };
}
function dryRun(displayName, toolId, params, ctx) {
  const head = `dry-run: ${displayName} ${JSON.stringify(params)}`;
  const root = path13.resolve(ctx.cwd);
  if (!existsSync10(path13.join(root, CONFIG_FILE))) return head;
  const config = loadConfig(root);
  const lines = [head, `\u6C60\u6839 ${root}\uFF0C\u6700\u591A ${config.maxSlots} \u4E2A\u69FD\u4F4D`];
  if (toolId === "acquire") {
    lines.push(`\u5206\u652F URL\uFF1A${branchUrl(config, String(params.branch))}`);
    lines.push(`\u4FDD\u7559\uFF1A${typeof params.ttl === "string" && params.ttl ? params.ttl : config.defaultTtl}${params.tag ? `\uFF0C\u6807\u7B7E ${params.tag}` : ""}`);
    lines.push(...sparsePlan(config));
  } else if (toolId === "refresh") {
    lines.push(config.resident.length ? `\u5E38\u9A7B\u5206\u652F\uFF1A${config.resident.join("\u3001")}` : "\u6CA1\u6709\u5E38\u9A7B\u5206\u652F");
    lines.push(...sparsePlan(config));
  } else if (toolId === "gc") {
    lines.push(`\u8D85\u8FC7 ${config.maxSlots} \u4E2A\u69FD\u4F4D\u65F6\u56DE\u6536\u7A7A\u95F2\u69FD\u4F4D\uFF1B\u5220\u9664 ${config.patchRetentionDays} \u5929\u524D\u7684\u5B58\u6863`);
  }
  return lines.join("\n");
}
function sparsePlan(config) {
  const exclude = config.sparse.exclude;
  if (exclude.length === 0) return ["\u7A00\u758F\uFF1A\u4E0D\u6392\u9664\uFF0C\u5B8C\u6574\u68C0\u51FA"];
  const parents = [...sparseParents(exclude)].map((p) => p || "(\u6839)");
  return [`\u7A00\u758F\uFF1A\u6392\u9664 ${exclude.join("\u3001")}`, `  \u9010\u5C42\u5C55\u5F00\uFF08immediates\uFF09\uFF1A${parents.join("\u3001")}`, "  \u5176\u4F59\u76EE\u5F55\u5B8C\u6574\u68C0\u51FA\uFF08infinity\uFF09"];
}
if (isCliEntry(import.meta.url)) {
  await main(manifest, run);
}
export {
  manifest,
  run,
  sparsePlan
};
