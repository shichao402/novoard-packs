/**
 * 读取并校验 `<池根>/pool.toml`（PRD working-copy-pool「配置」）。
 * 配置由用户手写，工具只读不写；每次运行重新读取。校验失败抛 ConfigError（CLI 退出码 64），
 * 报错写明行号与字段。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse, TomlError } from "smol-toml";
import { UsageError } from "../../../shared/cli";

export type PoolConfig = {
  maxSlots: number;
  defaultTtl: string;
  svnRoot: string;
  resident: string[];
  branches: { pattern: string; listFrom: string[]; recentDays: number };
  aliases: Record<string, string>;
  sparse: { exclude: string[] };
  patchRetentionDays: number;
};

export class ConfigError extends UsageError {}

export const CONFIG_FILE = "pool.toml";

const TOP_KEYS = new Set(["maxSlots", "defaultTtl", "svnRoot", "resident", "branches", "aliases", "sparse", "patchRetentionDays"]);
const BRANCH_KEYS = new Set(["pattern", "listFrom", "recentDays"]);
const SPARSE_KEYS = new Set(["exclude"]);

/** 时长：`30m`、`12h`、`1d`、`2w`，或 `forever`。 */
export const TTL_RE = /^(\d+)(m|h|d|w)$/;

export function isTtl(value: string): boolean {
  return value === "forever" || (TTL_RE.test(value) && Number(value.match(TTL_RE)![1]) > 0);
}

/** 返回租约到期时间：`forever` 或 ISO 时间戳。 */
export function leaseUntil(ttl: string, now: Date): string {
  if (ttl === "forever") return "forever";
  const match = ttl.match(TTL_RE);
  if (!match || Number(match[1]) <= 0) throw new UsageError(`保留时长不合法：${ttl}（例：30m、12h、1d、2w、forever）`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[match[2] as "m" | "h" | "d" | "w"];
  return new Date(now.getTime() + Number(match[1]) * unit).toISOString();
}

/** 在源文本里找 `key =` 所在行（1 起）；section 为空表示顶层。找不到返回 undefined。 */
export function lineOf(text: string, section: string, key?: string): number | undefined {
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
    // 顶层的点号写法：branches.pattern = ...
    if (current === "" && section && new RegExp(`^${escapeRe(section)}\\.${escapeRe(key)}\\s*=`).test(line)) return i + 1;
  }
  return undefined;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseConfig(text: string): PoolConfig {
  let raw: Record<string, unknown>;
  try {
    raw = parse(text) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof TomlError) {
      throw new ConfigError(`${CONFIG_FILE} 第 ${error.line} 行：${error.message.split("\n")[0]}`);
    }
    throw new ConfigError(`${CONFIG_FILE} 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const fail = (section: string, key: string | undefined, message: string): never => {
    const line = lineOf(text, section, key);
    const field = [section, key].filter(Boolean).join(".");
    throw new ConfigError(`${CONFIG_FILE}${line ? ` 第 ${line} 行` : ""} ${field}：${message}`);
  };

  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.has(key)) fail("", key, "未知字段");
  }

  const int = (section: string, key: string, value: unknown, fallback: number | undefined, min: number): number => {
    if (value === undefined) {
      if (fallback === undefined) fail(section, undefined, `缺少 ${key}`);
      return fallback!;
    }
    const n = typeof value === "bigint" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min) fail(section, key, `应为不小于 ${min} 的整数`);
    return n as number;
  };
  const str = (section: string, key: string, value: unknown, fallback?: string): string => {
    if (value === undefined) {
      if (fallback === undefined) fail(section, key, "缺少该字段");
      return fallback!;
    }
    if (typeof value !== "string" || value.trim() === "") fail(section, key, "应为非空字符串");
    return (value as string).trim();
  };
  const strList = (section: string, key: string, value: unknown): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
      fail(section, key, "应为非空字符串数组");
    }
    return (value as string[]).map((v) => v.trim());
  };
  const table = (key: string, allowed?: Set<string>): Record<string, unknown> => {
    const value = raw[key];
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date) fail("", key, "应为表（[" + key + "]）");
    if (allowed) {
      for (const k of Object.keys(value as object)) if (!allowed.has(k)) fail(key, k, "未知字段");
    }
    return value as Record<string, unknown>;
  };

  if (raw.maxSlots === undefined) fail("", undefined, "缺少 maxSlots");
  const maxSlots = int("", "maxSlots", raw.maxSlots, undefined, 1);
  if (maxSlots > 99) fail("", "maxSlots", "不能超过 99");
  const defaultTtl = str("", "defaultTtl", raw.defaultTtl, "1d");
  if (!isTtl(defaultTtl)) fail("", "defaultTtl", "应为 30m、12h、1d、2w 或 forever");
  if (raw.svnRoot === undefined) fail("", undefined, "缺少 svnRoot");
  const svnRoot = str("", "svnRoot", raw.svnRoot).replace(/\/+$/, "");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(svnRoot)) fail("", "svnRoot", "应为仓库 URL（如 https://、svn://、file://）");
  const resident = strList("", "resident", raw.resident);
  const patchRetentionDays = int("", "patchRetentionDays", raw.patchRetentionDays, 30, 1);

  const b = table("branches", BRANCH_KEYS);
  const pattern = str("branches", "pattern", b.pattern, "branches/{name}").replace(/^\/+|\/+$/g, "");
  if (!pattern.includes("{name}")) fail("branches", "pattern", "必须包含 {name}");
  const listFrom = strList("branches", "listFrom", b.listFrom).map((p) => p.replace(/^\/+|\/+$/g, ""));
  const recentDays = int("branches", "recentDays", b.recentDays, 30, 1);

  const a = table("aliases");
  const aliases: Record<string, string> = {};
  for (const [name, value] of Object.entries(a)) {
    aliases[name] = str("aliases", name, value).replace(/^\/+|\/+$/g, "");
  }

  const s = table("sparse", SPARSE_KEYS);
  const exclude = strList("sparse", "exclude", s.exclude).map((p) => p.replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, ""));
  for (const item of exclude) {
    if (item === "" || item.split("/").some((part) => part === ".." || part === ".")) fail("sparse", "exclude", `路径不合法：${item}`);
  }

  for (const name of resident) {
    if (!isBranchName(name)) fail("", "resident", `分支名不合法：${name}`);
  }

  return {
    maxSlots,
    defaultTtl,
    svnRoot,
    resident: [...new Set(resident)],
    branches: { pattern, listFrom, recentDays },
    aliases,
    sparse: { exclude: [...new Set(exclude)] },
    patchRetentionDays,
  };
}

export function configPath(root: string): string {
  return path.join(root, CONFIG_FILE);
}

export function loadConfig(root: string): PoolConfig {
  const file = configPath(root);
  if (!existsSync(file)) {
    throw new ConfigError(`池根 ${root} 下没有 ${CONFIG_FILE}；先按 README 写一份配置`);
  }
  return parseConfig(readFileSync(file, "utf8"));
}

/** 分支名：非空、不含控制字符、不以 / 开头、不含 .. 段。 */
export function isBranchName(name: string): boolean {
  if (!name || name !== name.trim()) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return false;
  if (name.startsWith("/") || name.includes("://")) return false;
  return !name.split("/").some((part) => part === "" || part === "." || part === "..");
}

/** 分支名对应的仓库相对路径：aliases 优先，否则套 pattern。 */
export function branchPath(config: PoolConfig, name: string): string {
  return config.aliases[name] ?? config.branches.pattern.replace("{name}", name);
}

export function branchUrl(config: PoolConfig, name: string): string {
  return `${config.svnRoot}/${branchPath(config, name)}`;
}

/** 仓库相对路径反推分支名：先查 aliases，再按 pattern 匹配；都不符合返回 undefined。 */
export function branchFromPath(config: PoolConfig, repoPath: string): string | undefined {
  const rel = repoPath.replace(/^\/+|\/+$/g, "");
  for (const [name, value] of Object.entries(config.aliases)) {
    if (value === rel) return name;
  }
  const [prefix, suffix] = config.branches.pattern.split("{name}");
  if (rel.length > prefix.length + suffix.length && rel.startsWith(prefix) && rel.endsWith(suffix)) {
    const name = rel.slice(prefix.length, rel.length - suffix.length);
    if (isBranchName(name)) return name;
  }
  return undefined;
}

/** svn info 读到的 URL 反推分支名（URL 需在 svnRoot 下）。 */
export function branchFromUrl(config: PoolConfig, url: string): string | undefined {
  const a = safeDecode(url).replace(/\/+$/, "");
  const root = safeDecode(config.svnRoot);
  if (!a.startsWith(`${root}/`)) return undefined;
  return branchFromPath(config, a.slice(root.length + 1));
}

export function sameUrl(a: string, b: string): boolean {
  return safeDecode(a).replace(/\/+$/, "") === safeDecode(b).replace(/\/+$/, "");
}

function safeDecode(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}
