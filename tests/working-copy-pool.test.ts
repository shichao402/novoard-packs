/**
 * workingCopyPool 单元测试（P6、P9）：配置校验（行号与字段）、锁接管、空闲推导、
 * 分支名转目录名、中断判定、candidates 合并去重与缓存、svn 输出解析。不需要 svn。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageError } from "../shared/cli";
import type { ToolRunContext } from "../shared/types";
import { branchFromUrl, branchUrl, ConfigError, isBranchName, leaseUntil, parseConfig, type PoolConfig } from "../packs/workingCopyPool/src/config";
import { run } from "../packs/workingCopyPool/src/index";
import { claimSlot, slotState } from "../packs/workingCopyPool/src/pool";
import { listRemoteBranches, mergeCandidates, missHint, occupiedChoices, parseListXml, peekPool } from "../packs/workingCopyPool/src/queries";
import {
  acquireLock,
  branchDirName,
  isIdle,
  isInterrupted,
  isStaleLock,
  laterLease,
  nextSlotId,
  poolPaths,
  recentBranches,
  appendHistory,
  ensureLayout,
  type PoolState,
  type Slot,
} from "../packs/workingCopyPool/src/state";
import { parseInfoXml, parseStatusXml, relTo, summarizeStatus } from "../packs/workingCopyPool/src/svn";
import { captureSpec, describeSparse, formatSpecToml, FULL_SPARSE, SparsePlan, type SparseSpec } from "../packs/workingCopyPool/src/sparse";

const NOW = new Date("2026-11-16T08:00:00.000Z");
const BASE = `maxSlots = 3\nsvnRoot = "https://svn.example.com/osg"\n`;
const config = (extra = ""): PoolConfig => parseConfig(`${BASE}${extra}`);
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid!;
const slot = (over: Partial<Slot>): Slot => ({ id: "s01", branch: "b1", url: "", phase: "ready", lease: null, ...over });

const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wcp-unit-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("pool.toml 校验", () => {
  it("缺省值", () => {
    expect(config()).toEqual({
      maxSlots: 3,
      defaultTtl: "1d",
      svnRoot: "https://svn.example.com/osg",
      resident: [],
      branches: { pattern: "branches/{name}", listFrom: [], recentDays: 30 },
      aliases: {},
      sparse: FULL_SPARSE,
      patchRetentionDays: 30,
      storage: { roots: [], minFreeGiB: 0 },
    });
  });

  it("规范化 exclude、去重 resident", () => {
    const c = config(`resident = ["s2pub", "s2pub"]\n[sparse]\nexclude = ["./Assets\\\\Art/", "Assets/Art"]\n`);
    expect(c.resident).toEqual(["s2pub"]);
    expect(c.sparse).toEqual({ root: "infinity", paths: { "Assets/Art": "exclude" } });
  });

  it("depth 映射表", () => {
    const c = config(`[sparse]\nroot = "empty"\n\n[sparse.depth]\n"Code/" = "infinity"\n"Assets\\\\Art" = "files"\n`);
    expect(c.sparse).toEqual({ root: "empty", paths: { Code: "infinity", "Assets/Art": "files" } });
    expect(config(`[sparse.depth]\n"Res" = "exclude"\n`).sparse).toEqual({ root: "infinity", paths: { Res: "exclude" } });
  });

  it.each([
    [`${BASE}maxSlot = 2\n`, /第 3 行 maxSlot：未知字段/],
    [`maxSlots = 0\nsvnRoot = "file:///r"\n`, /第 1 行 maxSlots：应为不小于 1 的整数/],
    [`maxSlots = 2\nsvnRoot = "svn.example.com"\n`, /第 2 行 svnRoot：应为仓库 URL/],
    [`${BASE}defaultTtl = "2 days"\n`, /第 3 行 defaultTtl/],
    [`${BASE}[branches]\npattern = "branches"\n`, /第 4 行 branches\.pattern：必须包含 \{name\}/],
    [`${BASE}[branches]\nlistfrom = []\n`, /第 4 行 branches\.listfrom：未知字段/],
    [`${BASE}\n[sparse]\nexclude = ["Assets/../x"]\n`, /第 5 行 sparse\.exclude：路径不合法/],
    [`${BASE}[sparse]\nexclude = ["A"]\nroot = "empty"\n`, /sparse\.exclude：不能和 root/],
    [`${BASE}[sparse]\nroot = "exclude"\n`, /第 4 行 sparse\.root：应为 empty/],
    [`${BASE}[sparse.depth]\n"A" = "deep"\n`, /sparse\.depth\.A|sparse\.depth.*应为 exclude/],
    [`${BASE}[sparse.depth]\n"A/../B" = "empty"\n`, /路径不合法：A\/\.\.\/B/],
    [`${BASE}[sparse.depth]\n"A" = "empty"\n"A/" = "files"\n`, /冲突/],
    [`${BASE}[sparse.depth]\n"A" = "exclude"\n"A/B" = "infinity"\n`, /A\/B 在已排除的 A 之下/],
    [`${BASE}resident = ["/abs"]\n`, /第 3 行 resident：分支名不合法/],
    [`svnRoot = "file:///r"\n`, /缺少 maxSlots/],
    [`maxSlots = 2\nsvnRoot = "file:///r"\nresident = [\n`, /pool\.toml 第 \d+ 行/],
  ])("报错带行号与字段 %#", (text, pattern) => {
    expect(() => parseConfig(text)).toThrow(pattern);
    try {
      parseConfig(text);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(error).toBeInstanceOf(UsageError);
    }
  });

  it("分支 URL：aliases 优先，pattern 反推", () => {
    const c = config(`[aliases]\ns2pub = "trunk"\n`);
    expect(branchUrl(c, "s2pub")).toBe("https://svn.example.com/osg/trunk");
    expect(branchUrl(c, "release_1.12")).toBe("https://svn.example.com/osg/branches/release_1.12");
    expect(branchFromUrl(c, "https://svn.example.com/osg/trunk/")).toBe("s2pub");
    expect(branchFromUrl(c, "https://svn.example.com/osg/branches/release%201")).toBe("release 1");
    expect(branchFromUrl(c, "https://svn.example.com/osg/tags/x")).toBeUndefined();
  });

  it("分支名与 ttl", () => {
    expect(isBranchName("feature/a")).toBe(true);
    for (const bad of ["", " a", "/a", "a//b", "../a", "a/./b", "http://x"]) expect(isBranchName(bad), bad).toBe(false);
    expect(leaseUntil("forever", NOW)).toBe("forever");
    expect(leaseUntil("12h", NOW)).toBe("2026-11-16T20:00:00.000Z");
    expect(() => leaseUntil("0d", NOW)).toThrow(UsageError);
  });

  it("缺 pool.toml 时 status 报 64 类错误（UsageError），dry-run 只回显参数", async () => {
    const root = tmp();
    const ctx: ToolRunContext = { cwd: root, workspacePath: root, timeoutMs: 5000, logFile: path.join(root, "l"), abortSignal: new AbortController().signal };
    await expect(run("status", {}, ctx)).rejects.toBeInstanceOf(UsageError);
    const dry = await run("acquire", { branch: "b1" }, { ...ctx, dryRun: true });
    expect(dry.detail).toBe('dry-run: 占用分支 {"branch":"b1"}');
    await expect(run("acquire", { branch: "b1", ttl: "1 day" }, { ...ctx, dryRun: true })).rejects.toThrow(/ttl 不合法/);
    expect(existsSync(path.join(root, ".pool"))).toBe(false);
  });
});

describe("状态文件与锁", () => {
  it("分支名转目录名", () => {
    expect(branchDirName("feature/a:b c")).toBe("feature_a_b_c");
    expect(branchDirName("release_1.12")).toBe("release_1.12");
  });

  it("槽位号取最小空号", () => {
    expect(nextSlotId({ version: 1, slots: [slot({ id: "s01" }), slot({ id: "s03" })] })).toBe("s02");
  });

  it("残留锁：持有进程已退出就接管；活着的进程持有则等待超时", async () => {
    const paths = poolPaths(tmp());
    ensureLayout(paths);
    writeFileSync(paths.lock, JSON.stringify({ pid: deadPid(), at: NOW.toISOString() }));
    expect(isStaleLock(paths.lock)).toBe(true);
    const release = await acquireLock(paths.lock, 1000);
    expect(JSON.parse(readFileSync(paths.lock, "utf8")).pid).toBe(process.pid);
    expect(isStaleLock(paths.lock)).toBe(false);
    await expect(acquireLock(paths.lock, 300)).rejects.toThrow(/池状态锁被占用/);
    release();
    expect(existsSync(paths.lock)).toBe(false);
  });

  it("持有过久的锁视为残留", () => {
    const paths = poolPaths(tmp());
    ensureLayout(paths);
    writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, at: new Date(Date.now() - 6 * 60_000).toISOString() }));
    expect(isStaleLock(paths.lock)).toBe(true);
  });

  it("最近使用：只看 acquire，新的在前去重，坏行跳过", () => {
    const paths = poolPaths(tmp());
    ensureLayout(paths);
    appendHistory(paths, { at: "1", action: "acquire", branch: "a" });
    appendHistory(paths, { at: "2", action: "acquire", branch: "b" });
    appendHistory(paths, { at: "3", action: "release", branch: "c" });
    writeFileSync(paths.history, `${readFileSync(paths.history, "utf8")}{bad\n`);
    appendHistory(paths, { at: "4", action: "acquire", branch: "a" });
    expect(recentBranches(paths)).toEqual(["a", "b"]);
  });
});

describe("空闲推导与选槽位", () => {
  const c = config(`resident = ["s2pub"]\n`);
  const later = new Date(NOW.getTime() + 3600_000).toISOString();
  const earlier = new Date(NOW.getTime() - 3600_000).toISOString();

  it("过期租约算空闲，常驻、blocked、有效租约不算", () => {
    expect(isIdle(slot({ lease: { until: earlier } }), c, NOW)).toBe(true);
    expect(isIdle(slot({ lease: { until: later } }), c, NOW)).toBe(false);
    expect(isIdle(slot({ lease: { until: "forever" } }), c, NOW)).toBe(false);
    expect(isIdle(slot({ branch: "s2pub" }), c, NOW)).toBe(false);
    expect(isIdle(slot({ phase: "blocked" }), c, NOW)).toBe(false);
  });

  it("中断判定：op 的进程不在了", () => {
    expect(isInterrupted(slot({}))).toBe(false);
    expect(isInterrupted(slot({ op: { kind: "switch", pid: process.pid, at: "" } }))).toBe(false);
    const dead = slot({ phase: "switching", op: { kind: "switch", pid: deadPid(), at: "" } });
    expect(isInterrupted(dead)).toBe(true);
    expect(slotState(dead, c, NOW)).toBe("interrupted");
  });

  it("续租取较晚者，forever 最大", () => {
    expect(laterLease({ until: later }, { until: earlier, tag: "x" })).toEqual({ until: later, tag: "x" });
    expect(laterLease({ until: "forever" }, { until: later })).toEqual({ until: "forever" });
  });

  it("选槽位：命中续租 → 空闲中 lastUsed 最早 → 新建 → 池满", () => {
    const state: PoolState = {
      version: 1,
      slots: [
        slot({ id: "s01", branch: "a", lastUsed: "2026-11-10T00:00:00Z" }),
        slot({ id: "s02", branch: "b", lastUsed: "2026-11-01T00:00:00Z" }),
        slot({ id: "s03", branch: "s2pub", lastUsed: "2026-10-01T00:00:00Z" }),
      ],
    };
    const lease = { until: later };
    expect(claimSlot(state, c, "a", lease, NOW)).toMatchObject({ kind: "hit", slot: { id: "s01", lease } });
    const sw = claimSlot(state, c, "x", lease, NOW);
    expect(sw).toMatchObject({ kind: "switch", slot: { id: "s02", phase: "switching", op: { kind: "switch", target: "x", from: "b" } } });
    expect(claimSlot(state, c, "x", lease, NOW)).toMatchObject({ kind: "busy", slot: { id: "s02" } });
    expect(claimSlot(state, c, "y", lease, NOW).kind).toBe("full");
    const roomy = { ...c, maxSlots: 4 };
    expect(claimSlot(state, roomy, "y", lease, NOW)).toMatchObject({ kind: "create", slot: { id: "s04" } });
  });
});

describe("candidates 与 occupied", () => {
  const c = config(`resident = ["s2pub", "exp"]\n[branches]\nlistFrom = ["branches"]\nrecentDays = 10\n`);
  const view = (over: object) => ({
    id: "s01",
    branch: "b1",
    state: "idle" as const,
    phase: "ready" as const,
    lease: null,
    lastUsed: null,
    behind: null,
    blockedReason: null,
    path: "",
    link: null,
    target: null,
    ...over,
  });

  it("按池中 → 常驻 → 最近 → listFrom 排序，按 value 去重，listFrom 只取 recentDays 内", () => {
    const state: PoolState = { version: 1, slots: [slot({ id: "s01", branch: "b1" }), slot({ id: "s02", branch: "s2pub" })] };
    const choices = mergeCandidates({
      views: [view({ behind: 2 }), view({ id: "s02", branch: "s2pub", state: "resident" })],
      state,
      config: c,
      recent: ["r1", "b1", "gone"],
      remote: [
        { branch: "r1", date: "2026-11-15T00:00:00Z" },
        { branch: "new", date: "2026-11-14T00:00:00Z" },
        { branch: "old", date: "2026-10-01T00:00:00Z" },
      ],
      now: NOW,
    });
    expect(choices.map((x) => x.value)).toEqual(["b1", "s2pub", "exp", "r1", "gone", "new"]);
    expect(choices[0].hint).toBe("就绪，落后 2");
    expect(choices[2].hint).toBe("常驻，需切换");
    expect(choices.find((x) => x.value === "gone")?.hint).toContain("可能已删除");
  });

  it("远端不可达：只返回本地部分并在 hint 里说明", () => {
    const choices = mergeCandidates({ views: [], state: { version: 1, slots: [] }, config: c, recent: ["r1"], remote: [], remoteError: "远端列不出：E170013", now: NOW });
    expect(choices.map((x) => x.value)).toEqual(["s2pub", "exp", "r1"]);
    expect(choices[2].hint).toContain("远端不可达");
  });

  it("missHint：有空闲 → 切换；没满 → 新建；否则池满", () => {
    const one = { ...c, maxSlots: 1 };
    expect(missHint({ version: 1, slots: [slot({})] }, one, NOW)).toBe("需切换");
    expect(missHint({ version: 1, slots: [slot({ lease: { until: "forever" } })] }, one, NOW)).toBe("池满，需先释放");
    expect(missHint({ version: 1, slots: [] }, one, NOW)).toBe("需新建槽位");
  });

  it("occupied 只列有效租约，hint 带标签", () => {
    const state: PoolState = {
      version: 1,
      slots: [slot({ lease: { until: "forever", tag: "bug-1" } }), slot({ id: "s02", branch: "b2", lease: { until: "2020-01-01T00:00:00Z" } })],
    };
    expect(occupiedChoices(state, NOW)).toEqual([{ value: "b1", hint: "s01，永久（bug-1）" }]);
  });

  it("listFrom 缓存：10 分钟内不访问远端；过期且远端失败时退回旧缓存", async () => {
    const root = tmp();
    writeFileSync(path.join(root, "pool.toml"), `maxSlots = 2\nsvnRoot = "file:///nonexistent-wcp-repo"\n[branches]\nlistFrom = ["branches"]\n`);
    const ctx: ToolRunContext = { cwd: root, workspacePath: root, timeoutMs: 5000, logFile: path.join(root, "l"), abortSignal: new AbortController().signal };
    let now = NOW;
    const pool = peekPool(ctx, () => now);
    const cacheFile = path.join(root, ".pool", "cache", "list-from.json");
    const miss = await listRemoteBranches(pool);
    expect(miss.entries).toEqual([]);
    expect(miss.error).toMatch(/远端列不出/);
    expect(existsSync(cacheFile)).toBe(false);

    const key = JSON.stringify([pool.config.svnRoot, pool.config.branches.listFrom, pool.config.branches.pattern, pool.config.aliases]);
    const entries = [{ branch: "x", date: "2026-11-15T00:00:00Z" }];
    ensureLayout(pool.paths);
    writeFileSync(cacheFile, JSON.stringify({ at: new Date(NOW.getTime() - 5 * 60_000).toISOString(), key, entries }));
    expect(await listRemoteBranches(pool)).toEqual({ entries, cached: true });

    now = new Date(NOW.getTime() + 20 * 60_000);
    const stale = await listRemoteBranches(pool);
    expect(stale.entries).toEqual(entries);
    expect(stale.error).toMatch(/用 .* 的缓存/);
  });
});

describe("svn 输出解析", () => {
  it("ls --xml 只取目录", () => {
    const xml = `<lists><list path="x"><entry kind="dir"><name>b&amp;1</name><commit revision="3"><date>2026-11-15T01:02:03.000000Z</date></commit></entry><entry kind="file"><name>f</name></entry></list></lists>`;
    expect(parseListXml(xml)).toEqual([{ name: "b&1", date: "2026-11-15T01:02:03.000000Z" }]);
  });

  it("info --xml：path、kind、url、depth", () => {
    const xml = `<info><entry kind="dir" path="slots/s01" revision="7"><url>file:///r/b%201</url><wc-info><depth>immediates</depth></wc-info><commit revision="5"></commit></entry></info>`;
    expect(parseInfoXml(xml)).toEqual([{ path: "slots/s01", kind: "dir", revision: 7, url: "file:///r/b%201", depth: "immediates", lastChangedRev: 5 }]);
  });

  it("relTo：相对 cwd 的路径也能还原", () => {
    expect(relTo("/p/slots/s01", "slots/s01/Assets", "/p")).toBe("Assets");
    expect(relTo("/p/slots/s01", "/p/slots/s01")).toBe(".");
  });

  it("status 汇总：改动、未纳管与需要人处理的问题", () => {
    const xml = `<status><target path="w">
      <entry path="w/a"><wc-status item="modified" props="none"></wc-status></entry>
      <entry path="w/n"><wc-status item="unversioned" props="none"></wc-status></entry>
      <entry path="w/c"><wc-status item="conflicted" props="none"></wc-status></entry>
      <entry path="w/t"><wc-status item="missing" props="none" tree-conflicted="true"></wc-status></entry>
    </target></status>`;
    const st = summarizeStatus(parseStatusXml(xml).map((it) => ({ ...it, path: relTo("w", it.path) })));
    expect(st.versioned.map((x) => x.path)).toEqual(["a", "t"]);
    expect(st.unversioned.map((x) => x.path)).toEqual(["n"]);
    expect(st.problems).toEqual(["冲突：c", "树冲突：t"]);
  });
});

describe("稀疏规格", () => {
  const whitelist: SparseSpec = { root: "empty", paths: { Code: "infinity", "Assets/Art/UI": "infinity", "Assets/Art/UI/Big": "exclude", Docs: "files" } };

  it("继承：父目录 infinity 时子目录 infinity，否则 empty", () => {
    const plan = new SparsePlan(whitelist);
    expect(plan.depthOf("")).toBe("empty");
    expect(plan.depthOf("Assets")).toBe("empty");
    expect(plan.depthOf("Assets/Art/UI/Icons")).toBe("infinity");
    expect(plan.depthOf("Assets/Art/UI/Big")).toBe("exclude");
    expect(plan.depthOf("Docs/Sub")).toBe("empty");
  });

  it("展开节点与需要带下来的子目录", () => {
    const plan = new SparsePlan(whitelist);
    expect(plan.wcDepth("Assets/Art/UI", "infinity")).toBe("immediates");
    expect(plan.wcDepth("Code", "infinity")).toBe("infinity");
    expect(plan.satisfied("Assets/Art/UI", "infinity", "immediates")).toBe(true);
    expect(plan.satisfied("Code", "infinity", "immediates")).toBe(false);
    expect(plan.neededChildren("")).toEqual(["Assets", "Code", "Docs"]);
    expect(plan.neededChildren("Assets/Art/UI")).toEqual([]);
    expect(new SparsePlan({ root: "infinity", paths: { "A/B": "exclude" } }).neededChildren("")).toEqual(["A"]);
  });

  it("dry-run 文本", () => {
    expect(describeSparse(FULL_SPARSE)).toEqual(["稀疏：不排除，完整检出"]);
    expect(describeSparse(whitelist)).toEqual([
      "稀疏：根目录 empty，未列出的目录从父目录继承",
      "  exclude：Assets/Art/UI/Big",
      "  files：Docs",
      "  infinity：Assets/Art/UI、Code",
      "  自动空壳（empty）：Assets、Assets/Art",
    ]);
  });

  it("从工作副本导出最小规格", () => {
    const spec = captureSpec([
      { rel: "", depth: "empty" },
      { rel: "Assets", depth: "empty" },
      { rel: "Assets/Art", depth: "empty" },
      { rel: "Assets/Art/UI", depth: "immediates" },
      { rel: "Assets/Art/UI/Big", depth: "exclude" },
      { rel: "Assets/Art/UI/Icons", depth: "infinity" },
      { rel: "Assets/Art/UI/Icons/S", depth: "infinity" },
      { rel: "Code", depth: "infinity" },
      { rel: "Docs", depth: "files" },
    ]);
    expect(spec).toEqual(whitelist);
    expect(captureSpec([{ rel: "", depth: "infinity" }, { rel: "A", depth: "infinity" }])).toEqual(FULL_SPARSE);
    // 真 immediates：子目录以 empty 出现，不列出
    expect(captureSpec([{ rel: "", depth: "immediates" }, { rel: "A", depth: "empty" }, { rel: "B", depth: "infinity" }])).toEqual({ root: "immediates", paths: { B: "infinity" } });
  });

  it("导出的 TOML 能被 pool.toml 解析回同一规格", () => {
    const toml = formatSpecToml(whitelist);
    expect(toml).toContain('"Assets/Art/UI/Big" = "exclude"');
    expect(config(`\n${toml}`).sparse).toEqual(whitelist);
  });
});
