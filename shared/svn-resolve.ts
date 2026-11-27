/**
 * 按项目 SVN 规则（svn-rules.ts）自动处理冲突与可丢弃类别的本地改动。
 * workingCopyPool（更新/切换/回收/复查）与 versionControl/svn-update（onConflict=rules）共用。
 *
 * 每轮：status → 判定 → 先存档再动手 → 记 rules.json；有动作就再来一轮，最多 3 轮。
 * - 冲突（文本/属性/树）：可丢弃类别或命中规则 → 取远端；否则保持阻塞并写明原因。
 * - 可丢弃类别里的普通受控改动 → revert；switched 子路径 → 切回工作副本根对应 URL。
 * - obstructed、工作副本锁（未允许 cleanup）→ 阻塞。
 * 总是丢弃的类别（generated）只记清单不拷内容；其余被处理的本地内容都进存档，可恢复。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createArchiveDir, toRelativePatch } from "./svn-archive";
import { categoryOf, discardSet, ruleMatchesPath, sameExceptTopLevelKeys, type SvnRule, type SvnRules } from "./svn-rules";
import { decodeXml, parseStatusItems, relativeTo, type StatusItem } from "./svn-status";

export type SvnRun = (
  args: string[],
  options?: { allowFail?: boolean; timeoutMs?: number },
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export type RuleAction = "theirs" | "revert" | "switch-back" | "blocked";

export type RuleEntry = {
  /** 相对工作副本根，正斜杠。 */
  path: string;
  /** 现场描述：文本冲突、树冲突（…）、本地修改等。 */
  what: string;
  category?: string;
  /** 命中的规则 id；按类别丢弃时为 `discard:<类别>`。 */
  rule?: string;
  action: RuleAction;
  reason?: string;
};

export type RulesOutcome = {
  entries: RuleEntry[];
  /** 处理后仍需人工处理的条目。 */
  blocked: RuleEntry[];
  archiveDir?: string;
  notes: string[];
};

export class RulesBlockedError extends Error {
  constructor(readonly outcome: RulesOutcome) {
    super(describeBlocked(outcome));
  }
}

export function describeBlocked(outcome: RulesOutcome): string {
  const n = outcome.blocked.length;
  const list = outcome.blocked
    .slice(0, 8)
    .map((e) => `${e.path}（${e.reason ?? e.what}）`)
    .join("；");
  const more = n > 8 ? ` 等 ${n} 项` : "";
  return `规则处理后仍有 ${n} 项需要人工处理：${list}${more}${outcome.archiveDir ? `；已处理部分存档 ${outcome.archiveDir}` : ""}`;
}

/** 一句话概括：取远端 N、还原 N、切回 N；存档目录。 */
export function summarizeRules(outcome: RulesOutcome): string {
  const count = (action: RuleAction): number => outcome.entries.filter((e) => e.action === action).length;
  const parts = [
    count("theirs") ? `取远端 ${count("theirs")}` : "",
    count("revert") ? `还原 ${count("revert")}` : "",
    count("switch-back") ? `切回 ${count("switch-back")}` : "",
  ].filter(Boolean);
  if (parts.length === 0) return "";
  return `规则处理：${parts.join("、")}${outcome.archiveDir ? `（存档 ${outcome.archiveDir}）` : ""}`;
}

/** 需要人知道、但不阻塞的提示（如大小写撞名）都以这个前缀开头，调用方据此从 detail 里挑出来。 */
export const RULE_HINT = "规则提示：";

/** 结果 detail 用：处理摘要加上规则提示，用“；”连接。 */
export function reportRules(outcome: RulesOutcome): string {
  return [summarizeRules(outcome), ...outcome.notes.filter((n) => n.startsWith(RULE_HINT))].filter(Boolean).join("；");
}

export type ApplyRulesOptions = {
  /** 工作副本根（绝对路径）。 */
  wc: string;
  /** svn 运行时的 cwd，用来把输出里的相对路径换算回来。 */
  cwd: string;
  run: SvnRun;
  rules: SvnRules;
  /** 开启的可选类别。 */
  enable: readonly string[];
  /** 存档根；需要存档时在下面建 `<时间戳>` 目录。 */
  archiveRoot: string;
  /** 沿用已有存档目录（同一次操作的前后两个阶段）。 */
  archiveDir?: string;
  now: Date;
  /** 阶段名，写进存档：更新前、更新后、切换前… */
  phase: string;
  /** 即使没有动作也要存档本地版本的路径（update 将合并的本地修改）。 */
  forceArchive?: string[];
  /** 工作副本锁（中断残留）是否允许 svn cleanup。 */
  cleanupLocks?: boolean;
  onStage?: (message: string) => void;
};

type Version = { side: string; kind: string; pathInRepos: string; reposUrl: string; revision: number };

type ConflictInfo = {
  text?: { mine?: string; theirs?: string; older?: string };
  propFile?: string;
  tree?: { action: string; reason: string; operation: string; kind: string };
  right?: Version;
};

type Victim = {
  rel: string;
  item: StatusItem;
  text: boolean;
  props: boolean;
  tree: boolean;
  info: ConflictInfo;
  what: string;
};

type Plan = {
  victims: { victim: Victim; entry: RuleEntry; archive: boolean }[];
  reverts: { target: string; entries: RuleEntry[]; archive: boolean }[];
  switches: { rel: string; entry: RuleEntry }[];
  blocked: RuleEntry[];
  notes: string[];
};

const DIRTY = new Set(["modified", "added", "deleted", "replaced", "missing"]);
const ACTION_LABEL: Record<string, string> = { add: "新增", delete: "删除", edit: "修改", replace: "替换" };
const REASON_LABEL: Record<string, string> = {
  unversioned: "有未纳管文件",
  edit: "已修改",
  delete: "已删除",
  missing: "缺失",
  obstructed: "被阻碍",
  added: "已新增",
  replaced: "已替换",
  "moved-away": "已移走",
  "moved-here": "已移入",
};
const MAX_ROUNDS = 3;

export async function applySvnRules(o: ApplyRulesOptions): Promise<RulesOutcome> {
  const discard = discardSet(o.rules, o.enable);
  const outcome: RulesOutcome = { entries: [], blocked: [], archiveDir: o.archiveDir, notes: [] };
  const tmp = mkdtempSync(path.join(os.tmpdir(), "novoard-svn-rules-"));
  let force = [...new Set(o.forceArchive ?? [])];
  let rootUrl: string | undefined;
  const ctx: EngineCtx = {
    o,
    discard,
    tmp,
    abs: (rel) => (rel === "." || rel === "" ? o.wc : path.join(o.wc, ...rel.split("/"))),
    rel: (p) => relativeTo(o.wc, p, o.cwd),
    rootUrl: async () => {
      if (rootUrl) return rootUrl;
      const info = await o.run(["info", "--xml", peg(o.wc)]);
      rootUrl = decodeXml(/<url>([\s\S]*?)<\/url>/.exec(info.stdout)?.[1] ?? "").replace(/\/+$/, "");
      if (!rootUrl) throw new Error(`读不到 ${o.wc} 的 URL`);
      return rootUrl;
    },
    archiveDir: () => {
      outcome.archiveDir ??= createArchiveDir(o.archiveRoot, o.now);
      return outcome.archiveDir;
    },
    currentArchiveDir: () => outcome.archiveDir,
  };
  try {
    for (let round = 1; ; round++) {
      o.onStage?.(`${o.phase}：按规则检查工作副本`);
      let items = await statusItems(ctx, o.wc);
      if (items.some((it) => it.item.wcLocked)) {
        if (!o.cleanupLocks) {
          outcome.blocked = [{ path: ".", what: "工作副本锁", action: "blocked", reason: "工作副本被锁定（中断残留），未允许 cleanup" }];
          break;
        }
        await o.run(["cleanup", peg(o.wc)]);
        outcome.notes.push("已 svn cleanup 解除工作副本锁");
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
    rmSync(tmp, { recursive: true, force: true });
  }
  if (outcome.blocked.length > 0 && outcome.archiveDir) recordRound(ctx, 0, outcome.blocked, []);
  return outcome;
}

type EngineCtx = {
  o: ApplyRulesOptions;
  discard: Set<string>;
  tmp: string;
  abs: (rel: string) => string;
  rel: (svnPath: string) => string;
  rootUrl: () => Promise<string>;
  /** 取存档目录，没有就新建。 */
  archiveDir: () => string;
  /** 已有的存档目录（沿用的或本次建的），没有返回 undefined。 */
  currentArchiveDir: () => string | undefined;
};

type Item = { rel: string; item: StatusItem };

function emptyPlan(): Plan {
  return { victims: [], reverts: [], switches: [], blocked: [], notes: [] };
}

function unconverged(plan: Plan): RuleEntry[] {
  const reason = `${MAX_ROUNDS} 轮处理后仍未收敛`;
  return [
    ...plan.victims.map(({ entry }) => ({ ...entry, action: "blocked" as const, reason })),
    ...plan.reverts.flatMap((r) => r.entries.map((entry) => ({ ...entry, action: "blocked" as const, reason }))),
    ...plan.switches.map(({ entry }) => ({ ...entry, action: "blocked" as const, reason })),
  ];
}

/** 本地路径里有 @ 时 svn 会当成 peg revision，末尾补一个 @。 */
export function peg(p: string): string {
  return p.includes("@") ? `${p}@` : p;
}

async function statusItems(ctx: EngineCtx, target: string): Promise<Item[]> {
  const result = await ctx.o.run(["status", "--xml", peg(target)], { allowFail: target !== ctx.o.wc });
  return parseStatusItems(result.stdout).map((item) => ({ rel: ctx.rel(item.path), item }));
}

function fold(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function isUnder(rel: string, parent: string): boolean {
  if (parent === ".") return true;
  const a = fold(rel);
  const b = fold(parent);
  return a === b || a.startsWith(`${b}/`);
}

function isDirty(it: StatusItem): boolean {
  return DIRTY.has(it.item) || it.props === "modified";
}

function isVictim(it: StatusItem): boolean {
  return it.item === "conflicted" || it.props === "conflicted" || it.treeConflicted;
}

async function planRound(ctx: EngineCtx, items: Item[]): Promise<Plan> {
  const { o, discard } = ctx;
  const plan = emptyPlan();
  const victims = await readVictims(ctx, items.filter((x) => isVictim(x.item)));
  const pairs = new Map<string, Promise<{ local: Buffer; incoming: Buffer } | undefined>>();
  const pairOf = (v: Victim): Promise<{ local: Buffer; incoming: Buffer } | undefined> => {
    let p = pairs.get(v.rel);
    if (!p) {
      p = contentPair(ctx, v);
      pairs.set(v.rel, p);
    }
    return p;
  };

  for (const v of victims) {
    const cat = categoryOf(o.rules, v.rel);
    const base = { path: v.rel, what: v.what, ...(cat ? { category: cat.name } : {}) };
    if (v.item.item === "obstructed") {
      plan.blocked.push({ ...base, action: "blocked", reason: `${v.what}，且路径被阻碍（obstructed）` });
      continue;
    }
    if (cat && discard.has(cat.name)) {
      plan.victims.push({ victim: v, entry: { ...base, rule: `discard:${cat.name}`, action: "theirs" }, archive: !o.rules.always.includes(cat.name) });
      continue;
    }
    let hit: SvnRule | undefined;
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
    const why = !cat
      ? "不属于可丢弃类别"
      : o.rules.optional.includes(cat.name)
        ? `类别 ${cat.name} 未开启丢弃`
        : `类别 ${cat.name} 不可丢弃`;
    plan.blocked.push({ ...base, action: "blocked", reason: `${v.what}，未命中规则，${why}` });
  }

  for (const x of items) {
    if (x.item.item === "obstructed" && !isVictim(x.item)) {
      const cat = categoryOf(o.rules, x.rel);
      plan.blocked.push({ path: x.rel, what: "路径被阻碍", ...(cat ? { category: cat.name } : {}), action: "blocked", reason: "路径被阻碍（obstructed）" });
    }
  }

  // 可丢弃类别里的普通受控改动：按类别前缀整体 revert；前缀下有阻塞条目或大小写撞名时逐个 revert
  const victimRels = victims.map((v) => v.rel);
  const clashes = caseClashes(ctx, items);
  for (const [rel, other] of clashes) {
    plan.notes.push(`${RULE_HINT}${rel} 与 ${other} 在仓库里只差大小写，本机文件系统只能放一个，保留了磁盘上的 ${path.posix.basename(other)}，${path.posix.basename(rel)} 会一直显示缺失，需在仓库里删掉其中一个`);
  }
  const groups = new Map<string, { cat: string; entries: RuleEntry[] }>();
  for (const x of items) {
    if (!isDirty(x.item) || isVictim(x.item) || x.item.item === "obstructed") continue;
    if (clashes.has(x.rel)) continue;
    if (victimRels.some((v) => isUnder(x.rel, v))) continue;
    const cat = categoryOf(o.rules, x.rel);
    if (!cat || !discard.has(cat.name)) continue;
    const group = groups.get(cat.prefix) ?? { cat: cat.name, entries: [] };
    group.entries.push({ path: x.rel, what: localWhat(x.item), category: cat.name, rule: `discard:${cat.name}`, action: "revert" });
    groups.set(cat.prefix, group);
  }
  for (const [prefix, group] of groups) {
    const archive = !o.rules.always.includes(group.cat);
    const pinned = plan.blocked.some((b) => isUnder(b.path, prefix) || isUnder(prefix, b.path)) || [...clashes.keys()].some((rel) => isUnder(rel, prefix));
    if (pinned) {
      for (const entry of group.entries) plan.reverts.push({ target: entry.path, entries: [entry], archive });
    } else {
      plan.reverts.push({ target: prefix, entries: group.entries, archive });
    }
  }

  for (const x of items) {
    if (!x.item.switched || x.rel === ".") continue;
    const cat = categoryOf(o.rules, x.rel);
    if (cat && discard.has(cat.name)) {
      plan.switches.push({ rel: x.rel, entry: { path: x.rel, what: "switched 到其他 URL", category: cat.name, rule: `discard:${cat.name}`, action: "switch-back" } });
    } else {
      plan.notes.push(`${RULE_HINT}${x.rel} 被 switch 到其他 URL，不属于可丢弃类别，保持不动`);
    }
  }
  return plan;
}

function localWhat(it: StatusItem): string {
  const label: Record<string, string> = { modified: "本地修改", added: "本地新增", deleted: "本地删除", replaced: "本地替换", missing: "本地缺失" };
  return label[it.item] ?? (it.props === "modified" ? "本地属性修改" : it.item);
}

/**
 * 仓库里同一目录有只差大小写的两个文件（如 Show.anim 与 show.anim）时，大小写不敏感的文件系统只能放一个，
 * 另一个永远显示缺失；revert 它会覆盖掉留下的那个，永远收敛不了。
 * 判定：条目缺失，但按它的路径能打开文件，而目录里的实际文件名大小写不同，且那个名字不是未纳管文件。
 * 返回 缺失条目 → 磁盘上占位的受控条目。
 */
function caseClashes(ctx: EngineCtx, items: Item[]): Map<string, string> {
  const out = new Map<string, string>();
  const unversioned = new Set(items.filter((x) => x.item.item === "unversioned").map((x) => x.rel.toLowerCase()));
  const listings = new Map<string, string[]>();
  for (const x of items) {
    if (x.item.item !== "missing" || x.rel === ".") continue;
    const abs = ctx.abs(x.rel);
    if (!existsSync(abs)) continue;
    const parentRel = path.posix.dirname(x.rel);
    const parent = path.dirname(abs);
    let names = listings.get(parent);
    if (!names) {
      try {
        names = readdirSync(parent);
      } catch {
        names = [];
      }
      listings.set(parent, names);
    }
    const base = path.posix.basename(x.rel);
    const actual = names.find((n) => n !== base && n.toLowerCase() === base.toLowerCase());
    if (!actual) continue;
    const other = parentRel === "." ? actual : `${parentRel}/${actual}`;
    if (unversioned.has(other.toLowerCase())) continue;
    out.set(x.rel, other);
  }
  return out;
}

async function readVictims(ctx: EngineCtx, list: Item[]): Promise<Victim[]> {
  const infos = new Map<string, ConflictInfo>();
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

function describeConflict(v: { text: boolean; props: boolean; tree: boolean; info: ConflictInfo }): string {
  const parts: string[] = [];
  if (v.tree) {
    const t = v.info.tree;
    parts.push(
      t
        ? `树冲突（${t.operation === "switch" ? "切换" : t.operation === "update" ? "更新" : t.operation}时远端${ACTION_LABEL[t.action] ?? t.action}，本地${REASON_LABEL[t.reason] ?? t.reason}）`
        : "树冲突",
    );
  }
  if (v.text) parts.push("文本冲突");
  if (v.props) parts.push("属性冲突");
  return parts.join("+") || "冲突";
}

/** 解析 `svn info --xml` 里每个条目的冲突描述；键为条目 path 原样。 */
export function parseConflictInfo(xml: string): Map<string, ConflictInfo> {
  const out = new Map<string, ConflictInfo>();
  const entryRe = /<entry\b([^>]*)>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml))) {
    const p = attr(m[1], "path");
    if (p === undefined) continue;
    const body = m[2];
    const info: ConflictInfo = {};
    const conflictRe = /<conflict\b([^>]*)>([\s\S]*?)<\/conflict>/g;
    let c: RegExpExecArray | null;
    while ((c = conflictRe.exec(body))) {
      const type = attr(c[1], "type");
      const inner = c[2];
      const file = (tag: string): string | undefined => {
        const v = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(inner)?.[1];
        return v === undefined ? undefined : decodeXml(v);
      };
      if (type === "text") info.text = { mine: file("prev-wc-file"), theirs: file("cur-base-file"), older: file("prev-base-file") };
      if (type === "property") info.propFile = file("prop-file");
      info.right ??= rightVersion(inner);
    }
    const tree = /<tree-conflict\b([^>]*)>([\s\S]*?)<\/tree-conflict>/.exec(body);
    if (tree) {
      info.tree = {
        action: attr(tree[1], "action") ?? "",
        reason: attr(tree[1], "reason") ?? "",
        operation: attr(tree[1], "operation") ?? "",
        kind: attr(tree[1], "kind") ?? "",
      };
      info.right = rightVersion(tree[2]) ?? info.right;
    }
    out.set(decodeXml(p), info);
  }
  return out;
}

function rightVersion(body: string): Version | undefined {
  const re = /<version\b([^>]*?)\/?>/g;
  let v: RegExpExecArray | null;
  while ((v = re.exec(body))) {
    if (attr(v[1], "side") !== "source-right") continue;
    return {
      side: "source-right",
      kind: attr(v[1], "kind") ?? "",
      pathInRepos: decodeXml(attr(v[1], "path-in-repos") ?? ""),
      reposUrl: decodeXml(attr(v[1], "repos-url") ?? ""),
      revision: Number(attr(v[1], "revision") ?? -1),
    };
  }
  return undefined;
}

function attr(source: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(source)?.[1];
}

/** 本地一侧与远端一侧的文件内容；拿不到（目录、远端已删、有属性冲突）返回 undefined。 */
async function contentPair(ctx: EngineCtx, v: Victim): Promise<{ local: Buffer; incoming: Buffer } | undefined> {
  if (v.props) return undefined;
  const readFile = (file: string | undefined): Buffer | undefined => {
    if (!file) return undefined;
    try {
      return statSync(file).isFile() ? readFileSync(file) : undefined;
    } catch {
      return undefined;
    }
  };
  if (v.text && !v.tree) {
    const local = readFile(v.info.text?.mine ?? ctx.abs(v.rel));
    const incoming = readFile(v.info.text?.theirs);
    return local && incoming ? { local, incoming } : undefined;
  }
  if (v.tree && !v.text) {
    const right = v.info.right;
    const local = readFile(ctx.abs(v.rel));
    if (!local || !right || right.kind !== "file" || right.revision < 0 || !right.reposUrl) return undefined;
    const url = `${right.reposUrl.replace(/\/+$/, "")}/${right.pathInRepos.split("/").map(encodeURIComponent).join("/")}@${right.revision}`;
    const out = path.join(ctx.tmp, `incoming-${Math.random().toString(36).slice(2)}`);
    const result = await ctx.o.run(["export", "--force", url, out], { allowFail: true });
    const incoming = result.code === 0 ? readFile(out) : undefined;
    rmSync(out, { force: true });
    return incoming ? { local, incoming } : undefined;
  }
  return undefined;
}

async function rulePasses(
  ctx: EngineCtx,
  rule: SvnRule,
  v: Victim,
  items: Item[],
  pairOf: (v: Victim) => Promise<{ local: Buffer; incoming: Buffer } | undefined>,
): Promise<boolean> {
  if (rule.when === "any") return true;
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

/** 树冲突里本地一侧没有任何内容：节点缺失/已删且不在磁盘上，下面也只有缺失/删除条目、没有属性改动和未纳管文件。 */
function localOnlyMissing(ctx: EngineCtx, v: Victim, items: Item[]): boolean {
  if (!v.tree || v.text || v.props || v.item.props === "modified") return false;
  const abs = ctx.abs(v.rel);
  const onDisk = existsSync(abs);
  const isFile = onDisk && statSync(abs).isFile();
  const it = v.item.item;
  const selfOk = it === "missing" || (it === "deleted" && !onDisk) || (it === "added" && v.item.copied && !isFile);
  if (!selfOk) return false;
  return items.every((x) => {
    if (x.rel === v.rel || !isUnder(x.rel, v.rel)) return true;
    return (x.item.item === "missing" || x.item.item === "deleted") && x.item.props !== "modified" && x.item.props !== "conflicted";
  });
}

async function archiveRound(ctx: EngineCtx, items: Item[], plan: Plan, force: string[]): Promise<void> {
  const { o } = ctx;
  const diffTargets: string[] = [];
  const copies: { from: string; to: string }[] = [];
  const byRel = new Map(items.map((x) => [fold(x.rel), x.item]));
  const alwaysCat = (rel: string): boolean => {
    const cat = categoryOf(o.rules, rel);
    return Boolean(cat && o.rules.always.includes(cat.name));
  };

  for (const { victim: v, archive } of plan.victims) {
    if (!archive) continue;
    const abs = ctx.abs(v.rel);
    diffTargets.push(v.rel);
    if (v.text) copies.push({ from: v.info.text?.mine ?? abs, to: v.rel });
    else if (existsSync(abs)) copies.push({ from: abs, to: v.rel });
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
    if (text.trim()) appendFileSync(path.join(dir, "changes.patch"), text.endsWith("\n") ? text : `${text}\n`, "utf8");
  }
  for (const { from, to } of copies) copyIntoArchive(from, path.join(dir, "files", ...to.split("/")));
  if (forced.length > 0) {
    appendFileSync(path.join(dir, "versioned.txt"), forced.map((rel) => `${o.phase}\tarchive\t将与远端合并的本地修改\t${rel}\t\n`).join(""), "utf8");
  }
}

/** 拷贝本地版本到存档；目标已存在时不覆盖（同一次操作里第一次存的才是最原始的本地版本）。跳过 .svn。 */
function copyIntoArchive(from: string, to: string): void {
  if (!existsSync(from) || existsSync(to)) return;
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (src) => path.basename(src).toLowerCase() !== ".svn",
  });
}

function writeReadme(ctx: EngineCtx, dir: string): void {
  const file = path.join(dir, "README.txt");
  if (existsSync(file)) return;
  writeFileSync(
    file,
    [
      "SVN 规则处理存档",
      `工作副本：${ctx.o.wc}`,
      `规则文件：${ctx.o.rules.file}`,
      `时间：${ctx.o.now.toISOString()}`,
      "",
      "changes.patch  受控改动的 svn diff（路径相对工作副本根）；在同一分支的工作副本根执行 svn patch changes.patch 恢复。",
      "files/         被处理路径的本地版本原样拷贝：文本冲突是 .mine（二进制为本地文件），树冲突是磁盘上的内容，属性冲突另存 .prej。",
      "versioned.txt  处理清单（阶段、动作、现场、路径、规则）。",
      "unversioned.txt 被删除的冲突遗留文件（已拷进 files/）。",
      "rules.json     每轮处理明细。",
      `总是丢弃的类别（${ctx.o.rules.always.join("、") || "无"}）是可再生内容，只记清单，不拷内容。`,
      "",
    ].join("\n"),
    "utf8",
  );
}

/** 执行：冲突（深的先）→ revert → 切回。返回删除的遗留文件。 */
async function executePlan(ctx: EngineCtx, plan: Plan, items: Item[]): Promise<string[]> {
  const { o } = ctx;
  const removed: string[] = [];
  const unversioned = new Set(items.filter((x) => x.item.item === "unversioned").map((x) => fold(x.rel)));
  const victims = [...plan.victims].sort((a, b) => b.victim.rel.split("/").length - a.victim.rel.split("/").length);
  if (victims.length) o.onStage?.(`${o.phase}：按规则处理 ${victims.length} 个冲突`);
  for (const { victim: v, archive } of victims) {
    const abs = ctx.abs(v.rel);
    const artifacts = [v.info.text?.mine, v.info.text?.theirs, v.info.text?.older, v.info.propFile].filter((f): f is string => Boolean(f));
    if (v.tree) {
      await o.run(["resolve", "--accept", "working", peg(abs)]);
      await o.run(["revert", "-R", peg(abs)]);
      await settleTree(ctx, v.rel, archive, removed);
    } else {
      await o.run(["resolve", "--accept", "theirs-full", peg(abs)]);
      await o.run(["revert", "--depth", "empty", peg(abs)]);
    }
    // Unity 会给 .mine/.rN 这些遗留文件生成 .meta，冲突解决后它们就成了孤儿
    for (const file of artifacts) {
      const meta = `${file}.meta`;
      const rel = ctx.rel(meta);
      if (!unversioned.has(fold(rel)) || !existsSync(meta)) continue;
      if (archive) copyIntoArchive(meta, path.join(ctx.archiveDir(), "files", ...rel.split("/")));
      rmSync(meta, { force: true });
      removed.push(rel);
    }
  }
  if (plan.reverts.length) {
    const count = plan.reverts.reduce((n, r) => n + r.entries.length, 0);
    o.onStage?.(`${o.phase}：还原可丢弃类别的 ${count} 处本地改动`);
    const targets = plan.reverts.map((r) => r.target);
    for (let i = 0; i < targets.length; i += 50) {
      await o.run(["revert", "-R", ...targets.slice(i, i + 50).map((rel) => peg(ctx.abs(rel)))]);
    }
  }
  if (plan.switches.length) {
    o.onStage?.(`${o.phase}：切回 ${plan.switches.length} 个 switched 路径`);
    const root = await ctx.rootUrl();
    for (const { rel } of plan.switches) {
      const url = `${root}/${rel.split("/").map(encodeURIComponent).join("/")}`;
      await o.run(["switch", "--ignore-ancestry", "--accept", "postpone", url, peg(ctx.abs(rel))]);
    }
  }
  return removed;
}

/**
 * 树冲突 resolve working + revert 之后的收尾：
 * 节点已不受控而磁盘上还有东西（远端删除、本地改过）→ 删掉遗留；
 * 节点受控但内容仍是本地的（远端新增撞上未纳管文件）→ 再 revert 一次取远端。
 */
async function settleTree(ctx: EngineCtx, rel: string, archive: boolean, removed: string[]): Promise<void> {
  const abs = ctx.abs(rel);
  for (let i = 0; i < 2; i++) {
    if (!existsSync(abs)) return;
    const items = await statusItems(ctx, abs);
    const self = items.find((x) => fold(x.rel) === fold(rel));
    if (self?.item.item === "unversioned") {
      if (archive) copyIntoArchive(abs, path.join(ctx.archiveDir(), "files", ...rel.split("/")));
      rmSync(abs, { recursive: true, force: true });
      removed.push(rel);
      return;
    }
    if (!items.some((x) => isDirty(x.item) || isVictim(x.item))) return;
    await ctx.o.run(["revert", "-R", peg(abs)]);
  }
}

function recordRound(ctx: EngineCtx, round: number, entries: RuleEntry[], removed: string[]): void {
  const acted = removed.length > 0 || entries.some((e) => e.action !== "blocked");
  // 只有阻塞、没有任何动作时不为此新建存档目录
  const dir = acted ? ctx.archiveDir() : ctx.currentArchiveDir();
  if (!dir) return;
  const file = path.join(dir, "rules.json");
  let runs: unknown[] = [];
  try {
    runs = JSON.parse(readFileSync(file, "utf8")) as unknown[];
    if (!Array.isArray(runs)) runs = [];
  } catch {
    runs = [];
  }
  runs.push({ phase: ctx.o.phase, round: round || "final", time: new Date().toISOString(), entries, removed });
  writeFileSync(file, `${JSON.stringify(runs, null, 2)}\n`, "utf8");
  // 每轮只记动作；阻塞项在最后（round=0）统一记一次
  const lines = entries
    .filter((e) => (round > 0 ? e.action !== "blocked" : true))
    .map((e) => `${ctx.o.phase}\t${e.action}\t${e.what}\t${e.path}\t${e.rule ?? e.reason ?? ""}\n`)
    .join("");
  if (lines) appendFileSync(path.join(dir, "versioned.txt"), lines, "utf8");
  if (removed.length) appendFileSync(path.join(dir, "unversioned.txt"), removed.map((r) => `${r}\n`).join(""), "utf8");
}
