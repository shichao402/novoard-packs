/**
 * 读取并校验 `<池根>/pool.toml`（PRD working-copy-pool「配置」）。
 * 配置由用户手写，工具只读不写；每次运行重新读取。校验失败抛 ConfigError（CLI 退出码 64），
 * 报错写明行号与字段。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse, TomlError } from "smol-toml";
import { UsageError } from "../../../shared/cli";
import { DEPTHS, isDepth, specErrors, specFromExclude, type Depth, type SparseSpec } from "./sparse";

/** 一个允许放槽位的存储目录；minFreeGiB 是在这里新建槽位前要求的剩余空间。 */
export type StorageRoot = { path: string; minFreeGiB: number };

export type PoolConfig = {
  maxSlots: number;
  defaultTtl: string;
  svnRoot: string;
  /** 当前需要的工作分支（工程清单）；消费方按它生成工程卡片，换出槽位时优先保留它们。 */
  projects: string[];
  branches: { pattern: string; listFrom: string[]; recentDays: number };
  aliases: Record<string, string>;
  sparse: SparseSpec;
  patchRetentionDays: number;
  /** roots 至少一项；minFreeGiB 是没有单独写下限的目录使用的默认值。 */
  storage: { roots: StorageRoot[]; minFreeGiB: number };
  hooks?: { beforeUpdate?: string[]; retryBlocked: boolean };
};

export class ConfigError extends UsageError {}

export const CONFIG_FILE = "pool.toml";

const TOP_KEYS = new Set(["maxSlots", "defaultTtl", "svnRoot", "projects", "branches", "aliases", "sparse", "patchRetentionDays", "storage", "hooks"]);
const BRANCH_KEYS = new Set(["pattern", "listFrom", "recentDays"]);
const SPARSE_KEYS = new Set(["exclude", "root", "depth"]);
const STORAGE_KEYS = new Set(["roots", "minFreeGiB"]);
const ROOT_KEYS = new Set(["path", "minFreeGiB"]);
const HOOK_KEYS = new Set(["beforeUpdate", "retryBlocked"]);

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

  if (raw.resident !== undefined) {
    fail("", "resident", "已移除：池里不再有常驻分支。日常使用的工程（如 trunk）请移出池单独管理，其余需要的分支写进 projects");
  }
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
  const projects = strList("", "projects", raw.projects);
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

  const h = table("hooks", HOOK_KEYS);
  const beforeUpdate = h.beforeUpdate === undefined ? undefined : strList("hooks", "beforeUpdate", h.beforeUpdate);
  if (beforeUpdate && (beforeUpdate.length === 0 || beforeUpdate.length > 64 || beforeUpdate.some((v) => /[\u0000-\u001f]/.test(v)))) {
    fail("hooks", "beforeUpdate", "应为非空命令 argv 数组（最多 64 项，不含控制字符）；不会经过 shell");
  }
  if (h.retryBlocked !== undefined && typeof h.retryBlocked !== "boolean") fail("hooks", "retryBlocked", "应为布尔值");
  if (h.retryBlocked === true && !beforeUpdate) fail("hooks", "retryBlocked", "需同时配置 beforeUpdate，默认不重试阻塞槽位");

  const s = table("sparse", SPARSE_KEYS);
  const sparse = parseSparse(s, fail, strList);

  for (const name of projects) {
    if (!isBranchName(name)) fail("", "projects", `分支名不合法：${name}`);
  }

  const storage = parseStorage(table("storage", STORAGE_KEYS), fail, int);

  return {
    maxSlots,
    defaultTtl,
    svnRoot,
    projects: [...new Set(projects)],
    branches: { pattern, listFrom, recentDays },
    aliases,
    sparse,
    patchRetentionDays,
    storage,
    ...(raw.hooks !== undefined ? { hooks: { beforeUpdate, retryBlocked: h.retryBlocked === true } } : {}),
  };
}

type Fail = (section: string, key: string | undefined, message: string) => never;
type Int = (section: string, key: string, value: unknown, fallback: number | undefined, min: number) => number;

function storageKey(p: string): string {
  const normalized = path.normalize(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * `[storage]`：槽位放在哪些本机目录（可跨盘）。roots 必填；每项是目录字符串，或 `{ path, minFreeGiB }`
 * 单独指定这个目录的剩余空间下限；顶层 minFreeGiB 是没写下限的目录用的默认值。
 */
function parseStorage(disk: Record<string, unknown>, fail: Fail, int: Int): PoolConfig["storage"] {
  const minFreeGiB = int("storage", "minFreeGiB", disk.minFreeGiB, 0, 0);
  const need = "列出允许放槽位的本机目录（可跨盘），例：roots = [\"E:/pool-slots\", { path = \"F:/pool-slots\", minFreeGiB = 150 }]；池定义目录里不放槽位";
  if (disk.roots === undefined) fail("storage", undefined, `缺少 [storage].roots：${need}`);
  if (!Array.isArray(disk.roots) || disk.roots.length === 0) fail("storage", "roots", `应为非空数组：${need}`);
  const roots: StorageRoot[] = [];
  const seen = new Map<string, StorageRoot>();
  for (const item of disk.roots as unknown[]) {
    let dir: unknown = item;
    let min = minFreeGiB;
    if (item && typeof item === "object" && !Array.isArray(item) && !(item instanceof Date)) {
      const entry = item as Record<string, unknown>;
      for (const k of Object.keys(entry)) if (!ROOT_KEYS.has(k)) fail("storage", "roots", `未知字段 ${k}（每项只能写 path 与 minFreeGiB）`);
      dir = entry.path;
      if (entry.minFreeGiB !== undefined) {
        const n = typeof entry.minFreeGiB === "bigint" ? Number(entry.minFreeGiB) : entry.minFreeGiB;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0) fail("storage", "roots", `${String(dir)} 的 minFreeGiB 应为不小于 0 的整数`);
        min = n as number;
      }
    }
    if (typeof dir !== "string" || dir.trim() === "") fail("storage", "roots", "每项应为目录字符串或 { path, minFreeGiB }");
    const root = (dir as string).trim();
    if (!path.isAbsolute(root) || (process.platform === "win32" && !/^[a-z]:[\\/]/i.test(root))) {
      fail("storage", "roots", `应为本机绝对目录：${root}`);
    }
    if (path.resolve(root) === path.parse(path.resolve(root)).root || /[\u0000-\u001f]/.test(root)) {
      fail("storage", "roots", `不能使用盘根或含控制字符的目录：${root}`);
    }
    const value: StorageRoot = { path: path.normalize(root), minFreeGiB: min };
    const prev = seen.get(storageKey(root));
    if (prev) {
      if (prev.minFreeGiB !== min) fail("storage", "roots", `${root} 重复且下限不同（${prev.minFreeGiB} / ${min}）`);
      continue;
    }
    seen.set(storageKey(root), value);
    roots.push(value);
  }
  return { roots, minFreeGiB };
}

/** 相对工作副本根的路径：正斜杠、去掉首尾斜杠和 ./；空、含 . 或 .. 段返回 undefined。 */
function normalizeRel(raw: string): string | undefined {
  const p = raw.trim().replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "");
  if (p === "" || p.split("/").some((part) => part === "" || part === ".." || part === ".")) return undefined;
  return p;
}

/**
 * `[sparse]`：`root` + `[sparse.depth]` 映射表；或兼容写法 `exclude = [...]`（等价于根 infinity、这些路径 exclude）。
 * 两种写法不能混用，避免同一目录有两套事实来源。
 */
function parseSparse(s: Record<string, unknown>, fail: Fail, strList: (section: string, key: string, value: unknown) => string[]): SparseSpec {
  const hasNew = s.root !== undefined || s.depth !== undefined;
  if (s.exclude !== undefined && hasNew) fail("sparse", "exclude", "不能和 root / [sparse.depth] 同时使用；白名单写法里用 \"路径\" = \"exclude\"");
  if (s.exclude !== undefined) {
    const exclude: string[] = [];
    for (const item of strList("sparse", "exclude", s.exclude)) {
      const p = normalizeRel(item);
      if (!p) fail("sparse", "exclude", `路径不合法：${item}`);
      exclude.push(p!);
    }
    const spec = specFromExclude([...new Set(exclude)]);
    const errors = specErrors(spec);
    if (errors.length) fail("sparse", "exclude", errors[0]);
    return spec;
  }

  const depthChoices = `${DEPTHS.join(" / ")}`;
  let root: SparseSpec["root"] = "infinity";
  if (s.root !== undefined) {
    if (!isDepth(s.root) || s.root === "exclude") fail("sparse", "root", `应为 ${DEPTHS.filter((d) => d !== "exclude").join(" / ")}`);
    root = s.root as SparseSpec["root"];
  }
  const paths: Record<string, Depth> = {};
  if (s.depth !== undefined) {
    const d = s.depth;
    if (!d || typeof d !== "object" || Array.isArray(d) || d instanceof Date) fail("sparse", "depth", "应为表（[sparse.depth]）");
    for (const [key, value] of Object.entries(d as Record<string, unknown>)) {
      const p = normalizeRel(key);
      if (!p) fail("sparse.depth", key, `路径不合法：${key}`);
      if (!isDepth(value)) fail("sparse.depth", key, `应为 ${depthChoices}`);
      if (p! in paths && paths[p!] !== value) fail("sparse.depth", key, `与同一路径的另一条写法冲突`);
      paths[p!] = value as Depth;
    }
  }
  const spec: SparseSpec = { root, paths };
  for (const error of specErrors(spec)) {
    const rel = error.split(" ")[0];
    const key = Object.keys((s.depth as Record<string, unknown>) ?? {}).find((k) => normalizeRel(k) === rel);
    fail("sparse.depth", key, error);
  }
  return spec;
}

export function configPath(root: string): string {
  return path.join(root, CONFIG_FILE);
}

export function loadConfig(root: string): PoolConfig {
  const file = configPath(root);
  if (!existsSync(file)) {
    throw new ConfigError(`池根 ${root} 下没有 ${CONFIG_FILE}；先按 README 写一份配置`);
  }
  const config = parseConfig(readFileSync(file, "utf8"));
  const pool = storageKey(path.resolve(root));
  for (const r of config.storage.roots) {
    const rel = path.relative(pool, storageKey(path.resolve(r.path)));
    if (rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) {
      throw new ConfigError(`${CONFIG_FILE} storage.roots：${r.path} 在池定义目录 ${root} 里面；槽位应放在池定义目录之外`);
    }
  }
  return config;
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
