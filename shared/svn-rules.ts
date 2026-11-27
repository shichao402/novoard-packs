/**
 * SVN 冲突规则（项目提供的 svn-rules.toml）：解析、校验与纯判定。
 * 规则文件由项目包（如 osg）维护，通用包只读取它，不导入项目代码。执行见 svn-resolve.ts。
 *
 * 格式：
 *   version = 1
 *   [categories]           类别名 = 相对工程根的路径数组，"/" 结尾表示目录
 *   [discard]              always = 总是丢弃本地改动的类别；optional = 使用方可开启的类别
 *   [[rule]]               id、when、可选 paths（glob）、keys（yaml-keys-only 用）
 *                          when = any 表示路径命中即存档本地后取远端，必须写 paths
 */
import { readFileSync } from "node:fs";
import { parse, TomlError } from "smol-toml";

export const RULE_KINDS = ["local-equals-incoming", "yaml-keys-only", "local-only-missing", "any"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export type SvnRule = {
  id: string;
  when: RuleKind;
  /** 路径 glob；空表示任何路径。不含 "/" 的模式只匹配文件名。 */
  paths: string[];
  keys: string[];
  matchers: RegExp[];
};

export type SvnRules = {
  file: string;
  /** 类别 → 规范化前缀（正斜杠、无首尾斜杠）。 */
  categories: Record<string, string[]>;
  always: string[];
  optional: string[];
  rules: SvnRule[];
};

export class SvnRulesError extends Error {}

const TOP_KEYS = new Set(["version", "categories", "discard", "rule"]);
const DISCARD_KEYS = new Set(["always", "optional"]);
const RULE_KEYS = new Set(["id", "when", "paths", "keys"]);

export function loadSvnRules(file: string): SvnRules {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new SvnRulesError(`读不到 SVN 规则文件 ${file}：${(error as Error).message}`);
  }
  return parseSvnRules(text, file);
}

export function parseSvnRules(text: string, file = "svn-rules.toml"): SvnRules {
  let raw: Record<string, unknown>;
  try {
    raw = parse(text) as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof TomlError ? error.message.split("\n")[0] : String(error);
    throw new SvnRulesError(`${file}：TOML 语法错误：${detail}`);
  }
  const fail = (message: string): never => {
    throw new SvnRulesError(`${file}：${message}`);
  };
  for (const key of Object.keys(raw)) if (!TOP_KEYS.has(key)) fail(`未知字段 ${key}`);
  if (raw.version !== 1) fail("version 必须为 1");

  const strList = (where: string, value: unknown): string[] => {
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) fail(`${where} 必须是字符串数组`);
    return value as string[];
  };
  const table = (where: string, value: unknown): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${where} 必须是表`);
    return value as Record<string, unknown>;
  };

  const categories: Record<string, string[]> = {};
  const owner = new Map<string, string>();
  const cats = table("[categories]", raw.categories ?? {});
  for (const [name, value] of Object.entries(cats)) {
    if (!/^[A-Za-z][\w-]*$/.test(name)) fail(`类别名 ${name} 只能用字母、数字、- 和 _，且以字母开头`);
    const prefixes: string[] = [];
    for (const item of strList(`categories.${name}`, value)) {
      const rel = normalizeRulePath(item);
      if (!rel) fail(`categories.${name} 含非法路径 ${JSON.stringify(item)}`);
      const key = foldCase(rel!);
      const prev = owner.get(key);
      if (prev) fail(`路径 ${rel} 同时出现在类别 ${prev} 和 ${name}`);
      owner.set(key, name);
      prefixes.push(rel!);
    }
    categories[name] = prefixes;
  }

  const discard = table("[discard]", raw.discard ?? {});
  for (const key of Object.keys(discard)) if (!DISCARD_KEYS.has(key)) fail(`[discard] 未知字段 ${key}`);
  const always = strList("discard.always", discard.always ?? []);
  const optional = strList("discard.optional", discard.optional ?? []);
  for (const name of [...always, ...optional]) if (!(name in categories)) fail(`[discard] 引用了未定义的类别 ${name}`);
  for (const name of always) if (optional.includes(name)) fail(`类别 ${name} 不能同时在 always 和 optional`);

  const rules: SvnRule[] = [];
  const ruleList = raw.rule ?? [];
  if (!Array.isArray(ruleList)) fail("rule 必须写成 [[rule]] 数组");
  (ruleList as unknown[]).forEach((value, index) => {
    const r = table(`rule[${index}]`, value);
    for (const key of Object.keys(r)) if (!RULE_KEYS.has(key)) fail(`rule[${index}] 未知字段 ${key}`);
    if (typeof r.id !== "string" || !/^[A-Za-z][\w-]*$/.test(r.id)) fail(`rule[${index}].id 必须是字母开头的标识`);
    const id = r.id as string;
    if (rules.some((x) => x.id === id)) fail(`rule id ${id} 重复`);
    if (!RULE_KINDS.includes(r.when as RuleKind)) fail(`rule ${id} 的 when 只能是 ${RULE_KINDS.join("、")}`);
    const when = r.when as RuleKind;
    const paths = strList(`rule ${id} 的 paths`, r.paths ?? []);
    const keys = strList(`rule ${id} 的 keys`, r.keys ?? []);
    if (when === "yaml-keys-only" && keys.length === 0) fail(`rule ${id} 是 yaml-keys-only，必须给 keys`);
    if (when !== "yaml-keys-only" && keys.length > 0) fail(`rule ${id} 只有 yaml-keys-only 才能写 keys`);
    if (when === "any" && paths.length === 0) fail(`rule ${id} 是 any（无条件取远端），必须给 paths 限定范围`);
    for (const k of keys) if (!/^[A-Za-z_][\w-]*$/.test(k)) fail(`rule ${id} 的 key ${k} 不是合法的 YAML 键`);
    const matchers = paths.map((p) => {
      const norm = p.replace(/\\/g, "/");
      if (!norm || norm.startsWith("/") || norm.split("/").includes("..")) fail(`rule ${id} 的 paths 含非法模式 ${p}`);
      return globToRegExp(norm);
    });
    rules.push({ id, when, paths, keys, matchers });
  });

  return { file, categories, always, optional, rules };
}

/** 规则中的路径：反斜杠转正斜杠、去首尾斜杠；越界、盘符、空段返回 undefined。 */
export function normalizeRulePath(item: string): string | undefined {
  const rel = item.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!rel || rel.includes(":")) return undefined;
  if (rel.split("/").some((part) => part === "" || part === "." || part === "..")) return undefined;
  return rel;
}

/** 使用方开启的可选类别与 always 的并集；enable 里出现非 optional 类别直接报错。 */
export function discardSet(rules: SvnRules, enable: readonly string[]): Set<string> {
  for (const name of enable) {
    if (!rules.optional.includes(name)) {
      const hint = rules.always.includes(name) ? "（它已总是丢弃，不用开启）" : `；可选：${rules.optional.join("、") || "无"}`;
      throw new SvnRulesError(`${rules.file}：类别 ${name} 不能开启${hint}`);
    }
  }
  return new Set([...rules.always, ...enable]);
}

/** 路径所属类别（最长前缀）。rel 为相对工作副本根、正斜杠。 */
export function categoryOf(rules: SvnRules, rel: string): { name: string; prefix: string } | undefined {
  const target = foldCase(rel);
  let best: { name: string; prefix: string } | undefined;
  for (const [name, prefixes] of Object.entries(rules.categories)) {
    for (const prefix of prefixes) {
      const p = foldCase(prefix);
      if ((target === p || target.startsWith(`${p}/`)) && (!best || prefix.length > best.prefix.length)) best = { name, prefix };
    }
  }
  return best;
}

export function ruleMatchesPath(rule: SvnRule, rel: string): boolean {
  if (rule.matchers.length === 0) return true;
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  return rule.paths.some((p, i) => rule.matchers[i].test(p.replace(/\\/g, "/").includes("/") ? rel : base));
}

/** glob → 正则：`**` 跨目录，`*` 不跨 "/"，`?` 单字符；Windows 下不区分大小写。 */
export function globToRegExp(glob: string): RegExp {
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

/**
 * 两份 YAML 文本去掉指定顶层键（行首无缩进的 `key:`）后逐行相同；统一换行，含 \0 视为二进制返回 false。
 * Unity .meta 的 guid / timeCreated 就是这种顶层键。
 */
export function sameExceptTopLevelKeys(a: Buffer | string, b: Buffer | string, keys: readonly string[]): boolean {
  const text = (v: Buffer | string): string | undefined => {
    const s = typeof v === "string" ? v : v.toString("utf8");
    return s.includes("\u0000") ? undefined : s;
  };
  const ta = text(a);
  const tb = text(b);
  if (ta === undefined || tb === undefined) return false;
  const drop = new RegExp(`^(?:${keys.map((k) => k.replace(/[-]/g, "\\-")).join("|")}):`);
  const lines = (s: string): string[] =>
    s
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n")
      .replace(/\n+$/, "")
      .split("\n")
      .filter((line) => !drop.test(line));
  const la = lines(ta);
  const lb = lines(tb);
  return la.length === lb.length && la.every((line, i) => line === lb[i]);
}

function foldCase(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}
