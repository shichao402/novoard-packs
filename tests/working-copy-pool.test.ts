/**
 * workingCopyPool 单元测试（P6、P9）：配置校验（行号与字段）、锁接管、空闲推导、
 * 分支名转目录名、中断判定、candidates 合并去重与缓存、入口同步、svn 输出解析。不需要真实仓库。
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageError } from "../shared/cli";
import type { ToolRunContext } from "../shared/types";
import { branchFromUrl, branchUrl, ConfigError, isBranchName, leaseUntil, loadConfig, parseConfig, type PoolConfig } from "../packs/workingCopyPool/src/config";
import { run } from "../packs/workingCopyPool/src/index";
import { claimSlot, openPool, reconcile, slotState, syncLinks } from "../packs/workingCopyPool/src/pool";
import { listCacheKey, listRemoteBranches, mergeCandidates, missHint, occupiedChoices, parseListXml, peekPool } from "../packs/workingCopyPool/src/queries";
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
/** 纯函数测试用的存储根：不创建，只参与路径计算。 */
const STORE = path.join(os.tmpdir(), "wcp-unit-store");
const q = (p: string): string => JSON.stringify(p);
const storageToml = (root: string): string => `\n[storage]\nroots = [${q(root)}]\n`;
const config = (extra = ""): PoolConfig => parseConfig(`${BASE}${extra}${storageToml(STORE)}`);
const alloc = (id: string): string => path.join(STORE, id);
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid!;
const slot = (over: Partial<Slot>): Slot => ({ id: "s01", path: alloc(over.id ?? "s01"), branch: "b1", url: "", phase: "ready", lease: null, ...over });
const linked = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

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
      projects: [],
      branches: { pattern: "branches/{name}", listFrom: [], recentDays: 30 },
      aliases: {},
      sparse: FULL_SPARSE,
      patchRetentionDays: 30,
      storage: { roots: [{ path: STORE, minFreeGiB: 0 }], minFreeGiB: 0 },
    });
  });

  it("规范化 exclude、去重 projects", () => {
    const c = config(`projects = ["s2pub", "s2pub"]\n[sparse]\nexclude = ["./Assets\\\\Art/", "Assets/Art"]\n`);
    expect(c.projects).toEqual(["s2pub"]);
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
    [`${BASE}projects = ["/abs"]\n`, /第 3 行 projects：分支名不合法/],
      [`${BASE}resident = ["trunk"]\n`, /第 3 行 resident：已移除：池里不再有常驻分支，需要的分支（包括 trunk）都写进 projects/],
    [`svnRoot = "file:///r"\n`, /缺少 maxSlots/],
    [`maxSlots = 2\nsvnRoot = "file:///r"\nprojects = [\n`, /pool\.toml 第 \d+ 行/],
  ])("报错带行号与字段 %#", (text, pattern) => {
    expect(() => parseConfig(text)).toThrow(pattern);
    try {
      parseConfig(text);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(error).toBeInstanceOf(UsageError);
    }
  });

  const DRIVE_ROOT = process.platform === "win32" ? "C:/" : "/";
  it.each([
    [BASE, /storage：缺少 \[storage\]\.roots/],
    [`${BASE}[storage]\nroots = []\n`, /第 4 行 storage\.roots：应为非空数组/],
    [`${BASE}[storage]\nroot = [${q(STORE)}]\n`, /第 4 行 storage\.root：未知字段/],
    [`${BASE}[storage]\nroots = ["rel/slots"]\n`, /应为本机绝对目录：rel\/slots/],
    [`${BASE}[storage]\nroots = [${q(DRIVE_ROOT)}]\n`, /不能使用盘根/],
    [`${BASE}[storage]\nroots = [{ path = ${q(STORE)}, size = 1 }]\n`, /未知字段 size（每项只能写 path 与 minFreeGiB）/],
    [`${BASE}[storage]\nroots = [{ path = ${q(STORE)}, minFreeGiB = -1 }]\n`, /minFreeGiB 应为不小于 0 的整数/],
    [`${BASE}[storage]\nroots = [${q(STORE)}, { path = ${q(STORE)}, minFreeGiB = 5 }]\n`, /重复且下限不同（0 \/ 5）/],
    [`${BASE}[storage]\nminFreeGiB = -1\nroots = [${q(STORE)}]\n`, /第 4 行 storage\.minFreeGiB：应为不小于 0 的整数/],
  ])("[storage] 校验 %#", (text, pattern) => {
    expect(() => parseConfig(text)).toThrow(pattern);
  });

  it("[storage]：每个目录可单独设下限，没写的用默认值；同一目录同下限只留一项", () => {
    const a = path.join(STORE, "a");
    const b = path.join(STORE, "b");
    const c = parseConfig(`${BASE}[storage]\nminFreeGiB = 20\nroots = [${q(a)}, { path = ${q(b)}, minFreeGiB = 150 }, { path = ${q(a)} }]\n`);
    expect(c.storage).toEqual({ minFreeGiB: 20, roots: [{ path: a, minFreeGiB: 20 }, { path: b, minFreeGiB: 150 }] });
  });

  it("loadConfig：存储目录不能在池定义目录里", () => {
    const root = tmp();
    writeFileSync(path.join(root, "pool.toml"), `${BASE}${storageToml(path.join(root, "slots"))}`);
    expect(() => loadConfig(root)).toThrow(/在池定义目录 .* 里面；槽位应放在池定义目录之外/);
    writeFileSync(path.join(root, "pool.toml"), `${BASE}${storageToml(root)}`);
    expect(() => loadConfig(root)).toThrow(ConfigError);
    writeFileSync(path.join(root, "pool.toml"), `${BASE}${storageToml(`${root}-slots`)}`);
    expect(loadConfig(root).storage.roots).toEqual([{ path: `${root}-slots`, minFreeGiB: 0 }]);
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
  const c = config(`projects = ["s2pub"]\n`);
  const later = new Date(NOW.getTime() + 3600_000).toISOString();
  const earlier = new Date(NOW.getTime() - 3600_000).toISOString();

  it("过期租约算空闲，blocked、有效租约不算；工程清单里的分支也可以被换出", () => {
    expect(isIdle(slot({ lease: { until: earlier } }), NOW)).toBe(true);
    expect(isIdle(slot({ lease: { until: later } }), NOW)).toBe(false);
    expect(isIdle(slot({ lease: { until: "forever" } }), NOW)).toBe(false);
    expect(isIdle(slot({ branch: "s2pub" }), NOW)).toBe(true);
    expect(isIdle(slot({ phase: "blocked" }), NOW)).toBe(false);
  });

  it("中断判定：op 的进程不在了", () => {
    expect(isInterrupted(slot({}))).toBe(false);
    expect(isInterrupted(slot({ op: { kind: "switch", pid: process.pid, at: "" } }))).toBe(false);
    const dead = slot({ phase: "switching", op: { kind: "switch", pid: deadPid(), at: "" } });
    expect(isInterrupted(dead)).toBe(true);
    expect(slotState(dead, NOW)).toBe("interrupted");
  });

  it("续租取较晚者，forever 最大", () => {
    expect(laterLease({ until: later }, { until: earlier, tag: "x" })).toEqual({ until: later, tag: "x" });
    expect(laterLease({ until: "forever" }, { until: later })).toEqual({ until: "forever" });
  });

  it("选槽位：命中续租 → 空闲中先换不在工程清单里的 → 新建（由 allocate 定目录）→ 再换工程 → 池满", () => {
    const state: PoolState = {
      version: 1,
      slots: [
        slot({ id: "s01", branch: "a", lastUsed: "2026-11-10T00:00:00Z" }),
        slot({ id: "s02", branch: "b", lastUsed: "2026-11-01T00:00:00Z" }),
        slot({ id: "s03", branch: "s2pub", lastUsed: "2026-10-01T00:00:00Z" }),
      ],
    };
    const lease = { until: later };
    expect(claimSlot(state, c, "a", lease, NOW, alloc)).toMatchObject({ kind: "hit", slot: { id: "s01", lease } });
    // s03 的 lastUsed 最早，但它在工程清单里，先换 s02
    const sw = claimSlot(state, c, "x", lease, NOW, alloc);
    expect(sw).toMatchObject({ kind: "switch", slot: { id: "s02", phase: "switching", op: { kind: "switch", target: "x", from: "b" } } });
    expect(claimSlot(state, c, "x", lease, NOW, alloc)).toMatchObject({ kind: "busy", slot: { id: "s02" } });
    expect(claimSlot(state, c, "y", lease, NOW, alloc)).toMatchObject({ kind: "switch", slot: { id: "s03", op: { from: "s2pub" } } });
    expect(claimSlot(state, c, "z", lease, NOW, alloc).kind).toBe("full");
    const roomy = { ...c, maxSlots: 4 };
    expect(claimSlot(state, roomy, "z", lease, NOW, alloc)).toMatchObject({ kind: "create", slot: { id: "s04", path: alloc("s04"), branch: "" } });
    expect(state.slots.find((s) => s.id === "s04")?.path).toBe(alloc("s04"));
  });

  it("选槽位：excluded 里的槽位跳过（换出时被阻塞的那个不再选）", () => {
    const state: PoolState = { version: 1, slots: [slot({ id: "s01", branch: "a" }), slot({ id: "s02", branch: "b" })] };
    expect(claimSlot(state, { ...c, maxSlots: 2 }, "x", null, NOW, alloc, new Set(["s01"]))).toMatchObject({ kind: "switch", slot: { id: "s02" } });
  });

  it("选槽位：有余量时新建，不换出空闲的工程槽位；满了才换", () => {
    const state: PoolState = { version: 1, slots: [slot({ id: "s01", branch: "s2pub" })] };
    expect(claimSlot(state, { ...c, maxSlots: 2 }, "x", null, NOW, alloc)).toMatchObject({ kind: "create", slot: { id: "s02", path: alloc("s02") } });
    expect(claimSlot(state, { ...c, maxSlots: 2 }, "y", null, NOW, alloc)).toMatchObject({ kind: "switch", slot: { id: "s01", op: { from: "s2pub" } } });
  });
});

describe("持有保护（hold / unhold）", () => {
  const c = config();
  const holds = { "osglauncher:p1": { at: NOW.toISOString(), label: "OSGLauncher 开工", path: "/x/s01" } };
  const ctxOf = (root: string): ToolRunContext => ({ cwd: root, workspacePath: root, timeoutMs: 5000, logFile: path.join(root, "l"), abortSignal: new AbortController().signal });
  /** 池定义目录在 root，槽位放在池外的 `${root}-slots/<id>`；建 .svn 让校正把它当工作副本。 */
  const makePool = (slots: Slot[], extra = ""): string => {
    const root = tmp();
    const store = `${root}-slots`;
    dirs.push(store);
    writeFileSync(path.join(root, "pool.toml"), `${BASE}${extra}${storageToml(store)}`);
    const paths = poolPaths(root);
    ensureLayout(paths);
    const placed = slots.map((s) => ({ ...s, path: path.join(store, s.id) }));
    for (const s of placed) mkdirSync(path.join(s.path, ".svn"), { recursive: true });
    writeFileSync(paths.state, JSON.stringify({ version: 1, slots: placed }));
    return root;
  };
  const stateOf = (root: string): PoolState => JSON.parse(readFileSync(poolPaths(root).state, "utf8")) as PoolState;
  const wcOf = (root: string, id = "s01"): string => path.join(`${root}-slots`, id);
  const linkOf = (root: string, branch: string): string => path.join(root, "branch", branchDirName(branch));

  it("受保护的槽位不算空闲，状态为 held，选槽位时跳过", () => {
    expect(isIdle(slot({ holds }), NOW)).toBe(false);
    expect(slotState(slot({ holds }), NOW)).toBe("held");
    expect(slotState(slot({ holds, lease: { until: "forever" } }), NOW)).toBe("held");
    expect(slotState(slot({ holds: {} }), NOW)).toBe("idle");
    const state: PoolState = {
      version: 1,
      slots: [slot({ id: "s01", branch: "a", lastUsed: "2026-10-01T00:00:00Z", holds }), slot({ id: "s02", branch: "b", lastUsed: "2026-11-01T00:00:00Z" })],
    };
    expect(claimSlot(state, { ...c, maxSlots: 2 }, "x", null, NOW, alloc)).toMatchObject({ kind: "switch", slot: { id: "s02" } });
    expect(claimSlot(state, { ...c, maxSlots: 2 }, "y", null, NOW, alloc).kind).toBe("full");
  });

  it("hold：确认实际目录后建立；同一 holdId 重复调用只刷新", async () => {
    const root = makePool([slot({ id: "s01", branch: "b1" })]);
    const ctx = ctxOf(root);
    const params = { branch: "b1", holdId: "osglauncher:p1", expectedPath: wcOf(root), label: "  OSGLauncher 开工  " };
    const first = await run("hold", params, ctx);
    expect(first.code).toBe(0);
    expect(first.detail).toMatch(/已建立 b1（s01）的保护 osglauncher:p1/);
    expect(stateOf(root).slots[0].holds).toEqual({ "osglauncher:p1": { at: expect.any(String), label: "OSGLauncher 开工", path: realpathSync.native(wcOf(root)) } });
    const again = await run("hold", { ...params, label: "OSGLauncher 工程操作" }, ctx);
    expect(again.detail).toMatch(/已刷新/);
    expect(Object.keys(stateOf(root).slots[0].holds ?? {})).toEqual(["osglauncher:p1"]);
    expect(stateOf(root).slots[0].holds?.["osglauncher:p1"].label).toBe("OSGLauncher 工程操作");
    const status = await run("status", {}, ctx);
    expect(status.summary).toContain("保护 1");
    expect(status.detail).toContain("保护中，持有者 OSGLauncher 工程操作（osglauncher:p1）");
    const brief = (await run("status", { brief: true }, ctx)) as { summary?: string; pool?: { slots: Array<Record<string, unknown>> } };
    expect(brief.summary).toBe(status.summary);
    expect(brief.pool?.slots[0]).toMatchObject({ id: "s01", branch: "b1", url: "", state: "held", link: linkOf(root, "b1"), path: wcOf(root), changes: null });
  });

  it("hold 拒绝：目录不符、不在池里、未就绪、参数不合法；都不写入", async () => {
    const root = makePool([slot({ id: "s01", branch: "b1" }), slot({ id: "s02", branch: "b2", phase: "blocked", blockedReason: "冲突：a" })]);
    const ctx = ctxOf(root);
    const base = { branch: "b1", holdId: "h1", expectedPath: wcOf(root) };
    await expect(run("hold", { ...base, expectedPath: wcOf(root, "s02") }, ctx)).rejects.toThrow(/不一致，未加保护/);
    await expect(run("hold", { ...base, branch: "zz" }, ctx)).rejects.toThrow(/不在池里/);
    await expect(run("hold", { ...base, branch: "b2", expectedPath: wcOf(root, "s02") }, ctx)).rejects.toThrow(/未就绪：冲突：a/);
    await expect(run("hold", { ...base, expectedPath: "slots/s01" }, ctx)).rejects.toBeInstanceOf(UsageError);
    await expect(run("hold", { ...base, holdId: " h1" }, ctx)).rejects.toBeInstanceOf(UsageError);
    await expect(run("hold", { ...base, holdId: "" }, ctx)).rejects.toBeInstanceOf(UsageError);
    expect(stateOf(root).slots.every((s) => !s.holds)).toBe(true);
  });

  it("hold 先校正：槽位目录已不在就移除记录并拒绝，不按旧记录加保护", async () => {
    const root = makePool([slot({ id: "s01", branch: "b1" })]);
    rmSync(wcOf(root), { recursive: true, force: true });
    await expect(run("hold", { branch: "b1", holdId: "h1", expectedPath: wcOf(root) }, ctxOf(root))).rejects.toThrow(/不在池里/);
    expect(stateOf(root).slots).toEqual([]);
  });

  it("unhold：必须确认已关闭；多个持有者互不清除；可重复调用", async () => {
    const root = makePool([slot({ id: "s01", branch: "b1" })]);
    const ctx = ctxOf(root);
    for (const holdId of ["osglauncher:p1", "osgtoolset:operation:42"]) await run("hold", { branch: "b1", holdId, expectedPath: wcOf(root) }, ctx);
    await expect(run("unhold", { branch: "b1", holdId: "osglauncher:p1" }, ctx)).rejects.toBeInstanceOf(UsageError);
    await expect(run("unhold", { branch: "b1", holdId: "osglauncher:p1", confirmClosed: false }, { ...ctx, dryRun: true })).rejects.toBeInstanceOf(UsageError);
    expect(Object.keys(stateOf(root).slots[0].holds ?? {})).toHaveLength(2);

    const one = await run("unhold", { branch: "b1", holdId: "osglauncher:p1", confirmClosed: true }, ctx);
    expect(one.detail).toMatch(/已解除.*仍有 1 个持有者（osgtoolset:operation:42）/);
    expect(Object.keys(stateOf(root).slots[0].holds ?? {})).toEqual(["osgtoolset:operation:42"]);
    const repeat = await run("unhold", { branch: "b1", holdId: "osglauncher:p1", confirmClosed: true }, ctx);
    expect(repeat.skipped).toBe(true);
    const last = await run("unhold", { branch: "b1", holdId: "osgtoolset:operation:42", confirmClosed: true }, ctx);
    expect(last.detail).toContain("槽位已不受保护");
    expect(stateOf(root).slots[0].holds).toBeUndefined();
    expect((await run("unhold", { branch: "zz", holdId: "x", confirmClosed: true }, ctx)).skipped).toBe(true);
  });

  it("unhold：分支被池外切走后，按 holdId 仍能找到槽位解除", async () => {
    const root = makePool([slot({ id: "s01", branch: "other", holds: { h1: { at: NOW.toISOString(), path: "/x" } } })]);
    const out = await run("unhold", { branch: "b1", holdId: "h1", confirmClosed: true }, ctxOf(root));
    expect(out.detail).toMatch(/已解除 b1（现为 other）（s01）的保护 h1/);
    expect(stateOf(root).slots[0].holds).toBeUndefined();
  });

  it("租约与保护互相独立：release 不清保护，unhold 只有 releaseLease 才清租约", async () => {
    const lease = { until: "forever" };
    const root = makePool([slot({ id: "s01", branch: "b1", lease }), slot({ id: "s02", branch: "b2", lease })]);
    const ctx = ctxOf(root);
    await run("hold", { branch: "b1", holdId: "h1", expectedPath: wcOf(root) }, ctx);
    await run("hold", { branch: "b2", holdId: "h2", expectedPath: wcOf(root, "s02") }, ctx);

    const released = await run("release", { branch: "b1" }, ctx);
    expect(released.detail).toMatch(/已释放 b1.*仍有持有保护（h1）/);
    expect(stateOf(root).slots[0]).toMatchObject({ lease: null, holds: { h1: expect.any(Object) } });

    await run("unhold", { branch: "b2", holdId: "h2", confirmClosed: true }, ctx);
    expect(stateOf(root).slots[1].lease).toEqual(lease);
    await run("hold", { branch: "b2", holdId: "h2", expectedPath: wcOf(root, "s02") }, ctx);
    const both = await run("unhold", { branch: "b2", holdId: "h2", confirmClosed: true, releaseLease: true }, ctx);
    expect(both.detail).toMatch(/已解除.*已释放租约.*槽位已不受保护/);
    expect(stateOf(root).slots[1]).toMatchObject({ lease: null });
    expect(stateOf(root).slots[1].holds).toBeUndefined();
  });

  it("refresh 只更新已挂槽的工程：受保护的跳过，未挂槽的不抢槽位；缩容不回收受保护槽位", async () => {
    const projects = makePool([slot({ id: "s01", branch: "b1", holds })], `projects = ["b1", "b9"]\n`);
    const refreshed = await run("refresh", {}, ctxOf(projects));
    expect(refreshed.code).toBe(0);
    expect(refreshed.summary).toBe("工程 2 个：更新 0，跳过 2，失败 0");
    expect(refreshed.detail).toMatch(/- b1：跳过：s01 受保护（OSGLauncher 开工（osglauncher:p1））/);
    expect(refreshed.detail).toContain("- b9：跳过：未挂槽（按需占用时分配）");
    expect(stateOf(projects).slots.map((s) => s.id)).toEqual(["s01"]);

    const none = await run("refresh", {}, ctxOf(makePool([])));
    expect(none).toMatchObject({ code: 0, skipped: true });
    expect(none.detail).toContain("projects 为空，没有要更新的工程");

    const single = await run("refresh", { branch: "b1" }, ctxOf(projects));
    expect(single).toMatchObject({ code: 0, skipped: true, summary: "b1：跳过" });
    expect(single.detail).toMatch(/- b1：跳过：s01 受保护/);
    expect(single.detail).not.toContain("b9");
    expect((single as { pool?: { slots: unknown[] } }).pool?.slots).toHaveLength(1);
    const outside = await run("refresh", { branch: "b7" }, ctxOf(makePool([])));
    expect(outside).toMatchObject({ code: 0, skipped: true, summary: "b7：跳过" });
    expect(outside.detail).toContain("- b7：跳过：未挂槽（按需占用时分配）");
    await expect(run("refresh", { branch: "../x" }, ctxOf(projects))).rejects.toBeInstanceOf(UsageError);

    const ids = ["s01", "s02", "s03", "s04"];
    const crowded = makePool(ids.map((id, i) => slot({ id, branch: `b${i + 1}`, holds })));
    const report = await run("gc", {}, ctxOf(crowded));
    expect(report.detail).toMatch(/还需缩减 1 个槽位，等租约结束、保护解除或阻塞处理后再回收/);
    expect(stateOf(crowded).slots.map((s) => s.id)).toEqual(ids);
    for (const id of ids) expect(existsSync(wcOf(crowded, id))).toBe(true);
  });

  it("dry-run 描述 hold / unhold，不写状态", async () => {
    const root = makePool([slot({ id: "s01", branch: "b1" })]);
    const ctx = { ...ctxOf(root), dryRun: true };
    const dry = await run("hold", { branch: "b1", holdId: "h1", expectedPath: wcOf(root) }, ctx);
    expect(dry.detail).toContain(`确认 b1 的实际目录是 ${wcOf(root)} 后，以 h1 加保护`);
    const undry = await run("unhold", { branch: "b1", holdId: "h1", confirmClosed: true, releaseLease: true }, ctx);
    expect(undry.detail).toContain("解除 b1 上 h1 的保护，并释放租约");
    expect(stateOf(root).slots[0].holds).toBeUndefined();
  });

  it("候选提示：受保护槽位写出持有者与租约", () => {
    const choices = mergeCandidates({
      views: [{ id: "s01", branch: "b1", url: "", state: "held", phase: "ready", lease: { until: "forever", tag: "bug-1" }, lastUsed: null, behind: null, blockedReason: null, path: "", link: null, target: null, holds: [{ id: "osglauncher:p1", ...holds["osglauncher:p1"] }] }],
      state: { version: 1, slots: [] },
      config: c,
      recent: [],
      remote: [],
      now: NOW,
    });
    expect(choices[0].hint).toBe("受保护（OSGLauncher 开工），已占用永久（bug-1）");
  });

  describe("入口同步与校正（不需要 svn）", () => {
    it("入口只在分支挂在槽位上且目录还在时存在；失效入口删除，不碰真实目录", () => {
      const root = makePool([slot({ id: "s01", branch: "b1" }), slot({ id: "s02", branch: "b2" }), slot({ id: "s03", branch: "" })]);
      rmSync(wcOf(root, "s02"), { recursive: true, force: true });
      symlinkSync(wcOf(root, "s03"), linkOf(root, "gone"), "junction");
      symlinkSync(wcOf(root, "s01"), linkOf(root, "b2"), "junction");
      const notes = syncLinks(openPool(ctxOf(root)));
      expect(notes).toEqual(expect.arrayContaining(["删除失效入口 branch/gone", "删除失效入口 branch/b2", "补建入口 branch/b1"]));
      expect(realpathSync.native(linkOf(root, "b1"))).toBe(realpathSync.native(wcOf(root, "s01")));
      expect(linked(linkOf(root, "b2"))).toBe(false);
      expect(linked(linkOf(root, "gone"))).toBe(false);
      expect(existsSync(path.join(wcOf(root, "s03"), ".svn"))).toBe(true);
      expect(syncLinks(openPool(ctxOf(root)))).toEqual([]);
    });

    it("目录被删：没有保护就移除记录；有保护标为阻塞，入口一并失效", async () => {
      const root = makePool([slot({ id: "s01", branch: "b1" }), slot({ id: "s02", branch: "b2", holds })]);
      const pool = openPool(ctxOf(root));
      syncLinks(pool);
      expect(linked(linkOf(root, "b1")) && linked(linkOf(root, "b2"))).toBe(true);
      for (const id of ["s01", "s02"]) rmSync(wcOf(root, id), { recursive: true, force: true });

      const notes = await reconcile(pool);
      expect(notes).toEqual(expect.arrayContaining([
        "s01 b1：目录已不存在，已移除槽位记录",
        "s02 b2：目录不存在，仍受保护，已标为阻塞",
        "删除失效入口 branch/b1",
        "删除失效入口 branch/b2",
      ]));
      expect(stateOf(root).slots).toEqual([expect.objectContaining({ id: "s02", phase: "blocked", blockedReason: expect.stringMatching(/工作副本目录不存在.*仍有持有保护/) })]);
      expect(linked(linkOf(root, "b1")) || linked(linkOf(root, "b2"))).toBe(false);

      // 解除保护后下次校正移除记录
      await run("unhold", { branch: "b2", holdId: "osglauncher:p1", confirmClosed: true }, ctxOf(root));
      expect(await reconcile(pool)).toContain("s02 b2：目录已不存在，已移除槽位记录");
      expect(stateOf(root).slots).toEqual([]);
    });

    it("目录还在但不是工作副本：标为阻塞并保留内容；只看给定的槽位", async () => {
      const root = makePool([slot({ id: "s01", branch: "b1" }), slot({ id: "s02", branch: "b2" })]);
      for (const id of ["s01", "s02"]) rmSync(path.join(wcOf(root, id), ".svn"), { recursive: true, force: true });
      writeFileSync(path.join(wcOf(root), "keep.txt"), "x");
      const notes = await reconcile(openPool(ctxOf(root)), new Set(["s01"]));
      expect(notes).toContain("s01 b1：目录不是工作副本，已标为阻塞");
      expect(stateOf(root).slots.map((s) => s.phase)).toEqual(["blocked", "ready"]);
      expect(existsSync(path.join(wcOf(root), "keep.txt"))).toBe(true);
    });

    it("存储目录整个不可访问：保留记录，不当作目录被删", async () => {
      const root = makePool([slot({ id: "s01", branch: "b1" })]);
      rmSync(`${root}-slots`, { recursive: true, force: true });
      const notes = await reconcile(openPool(ctxOf(root)));
      expect(notes.some((n) => /s01 b1：槽位存储目录不可访问/.test(n))).toBe(true);
      expect(stateOf(root).slots.map((s) => s.id)).toEqual(["s01"]);
    });
  });
});

describe("candidates 与 occupied", () => {
  const c = config(`projects = ["s2pub", "exp"]\n[branches]\nlistFrom = ["branches"]\nrecentDays = 10\n`);
  const view = (over: object) => ({
    id: "s01",
    branch: "b1",
    url: "",
    state: "idle" as const,
    phase: "ready" as const,
    lease: null,
    lastUsed: null,
    behind: null,
    blockedReason: null,
    path: "",
    link: null,
    target: null,
    holds: [],
    ...over,
  });

  it("按池中 → 工程清单 → 最近 → listFrom 排序，按 value 去重，listFrom 只取 recentDays 内", () => {
    const state: PoolState = { version: 1, slots: [slot({ id: "s01", branch: "b1" }), slot({ id: "s02", branch: "s2pub" })] };
    const choices = mergeCandidates({
      views: [view({ behind: 2 }), view({ id: "s02", branch: "s2pub" })],
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
    expect(choices[1].hint).toBe("就绪");
    expect(choices[2].hint).toBe("工程清单，需切换");
    expect(choices.find((x) => x.value === "gone")?.hint).toContain("可能已删除");
  });

  it("远端不可达：只返回本地部分并在 hint 里说明", () => {
    const choices = mergeCandidates({ views: [], state: { version: 1, slots: [] }, config: c, recent: ["r1"], remote: [], remoteError: "远端列不出：E170013", now: NOW });
    expect(choices.map((x) => x.value)).toEqual(["s2pub", "exp", "r1"]);
    expect(choices[0].hint).toBe("工程清单，需新建槽位");
    expect(choices[2].hint).toContain("远端不可达");
  });

  it("missHint：有非工程空闲 → 切换；没满 → 新建；只剩工程空闲 → 换出工程；否则池满", () => {
    const one = { ...c, maxSlots: 1 };
    expect(missHint({ version: 1, slots: [slot({})] }, one, NOW)).toBe("需切换");
    expect(missHint({ version: 1, slots: [slot({ lease: { until: "forever" } })] }, one, NOW)).toBe("池满，需先释放");
    expect(missHint({ version: 1, slots: [] }, one, NOW)).toBe("需新建槽位");
    expect(missHint({ version: 1, slots: [slot({ branch: "s2pub" })] }, { ...c, maxSlots: 2 }, NOW)).toBe("需新建槽位");
    expect(missHint({ version: 1, slots: [slot({ branch: "s2pub" })] }, one, NOW)).toBe("需切换（会换出工程槽位）");
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
    writeFileSync(path.join(root, "pool.toml"), `maxSlots = 2\nsvnRoot = "file:///nonexistent-wcp-repo"\n[branches]\nlistFrom = ["branches"]\n${storageToml(STORE)}`);
    const ctx: ToolRunContext = { cwd: root, workspacePath: root, timeoutMs: 5000, logFile: path.join(root, "l"), abortSignal: new AbortController().signal };
    let now = NOW;
    const pool = peekPool(ctx, () => now);
    const cacheFile = path.join(root, ".pool", "cache", "list-from.json");
    const miss = await listRemoteBranches(pool);
    expect(miss.entries).toEqual([]);
    expect(miss.error).toMatch(/远端列不出/);
    expect(existsSync(cacheFile)).toBe(false);

    const entries = [{ branch: "x", date: "2026-11-15T00:00:00Z" }];
    ensureLayout(pool.paths);
    // 旧版本（未带版本号）的缓存可能是截断输出写下的，不再采用
    const legacyKey = JSON.stringify([pool.config.svnRoot, pool.config.branches.listFrom, pool.config.branches.pattern, pool.config.aliases]);
    writeFileSync(cacheFile, JSON.stringify({ at: new Date(NOW.getTime() - 5 * 60_000).toISOString(), key: legacyKey, entries }));
    const legacy = await listRemoteBranches(pool);
    expect(legacy.entries).toEqual([]);
    expect(legacy.error).toMatch(/远端列不出：/);

    const key = listCacheKey(pool.config);
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
