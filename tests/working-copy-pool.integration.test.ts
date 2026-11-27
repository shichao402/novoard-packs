/**
 * workingCopyPool 集成测试（P7、P8）：svnadmin create 建临时仓，用 file:// 跑真实 svn。
 * 覆盖：新建稀疏检出（槽位落在池外的存储目录）、切换、带改动切换后 patch 能恢复、池满、release 不动文件、
 * refresh 只更新已挂槽的工程、缩容、中断恢复（含取消后下一次运行接手）、池外 svn switch 的校正。
 * 机器上没有 svn / svnadmin 时整组跳过。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolRunContext, ToolRunResult } from "../shared/types";
import { run } from "../packs/workingCopyPool/src/index";
import { readState, poolPaths, type PoolState } from "../packs/workingCopyPool/src/state";
import { isLink, linkTarget } from "../packs/workingCopyPool/src/archive";

const hasSvn = ["svn", "svnadmin"].every((cmd) => spawnSync(cmd, ["--version", "--quiet"]).status === 0);

function sh(cmd: string, args: string[], cwd?: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}\n${r.stderr}`);
  return r.stdout;
}

/** 一个死掉的 pid：起一个立即退出的子进程拿它的 pid。 */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

describe.skipIf(!hasSvn)("workingCopyPool 集成（svnadmin + file://）", () => {
  let base: string;
  let url: string;
  let poolRoot: string;
  /** 槽位存储目录：在池定义目录之外。 */
  let store: string;
  let scratch: string;
  const logs: string[] = [];

  const ctx = (signal?: AbortSignal, onProgress?: (m: string) => void): ToolRunContext => ({
    cwd: poolRoot,
    workspacePath: poolRoot,
    timeoutMs: 120_000,
    logFile: path.join(base, "pool.log"),
    abortSignal: signal ?? new AbortController().signal,
    onProgress: (m) => {
      logs.push(m);
      onProgress?.(m);
    },
  });
  const call = (tool: string, params: Record<string, unknown> = {}, signal?: AbortSignal, onProgress?: (m: string) => void): Promise<ToolRunResult> =>
    run(tool, params, ctx(signal, onProgress));
  const state = (): PoolState => readState(poolPaths(poolRoot));
  const slotOf = (id: string): PoolState["slots"][number] | undefined => state().slots.find((s) => s.id === id);
  const slot = (id: string): string => path.join(store, id);
  const link = (branch: string): string => path.join(poolRoot, "branch", branch);
  const writeConfig = (extra: { maxSlots: number; projects?: string[]; sparse?: string[]; root?: string; store?: string }): void => {
    writeFileSync(
      path.join(extra.root ?? poolRoot, "pool.toml"),
      [
        `maxSlots = ${extra.maxSlots}`,
        `svnRoot = "${url}"`,
        `projects = ${JSON.stringify(extra.projects ?? [])}`,
        "",
        "[branches]",
        `listFrom = ["branches"]`,
        "",
        ...(extra.sparse ?? ["[sparse]", `exclude = ["Assets/Art"]`]),
        "",
        "[storage]",
        `roots = [${JSON.stringify(extra.store ?? store)}]`,
        "",
      ].join("\n"),
    );
  };
  /** 往远端某分支的文件提交一行内容。 */
  const commit = (branch: string, rel: string, text: string): void => {
    const wc = path.join(scratch, branch);
    if (!existsSync(wc)) sh("svn", ["checkout", "--depth", "infinity", `${url}/branches/${branch}`, wc]);
    else sh("svn", ["update", wc]);
    const file = path.join(wc, ...rel.split("/"));
    const isNew = !existsSync(file);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    if (isNew) sh("svn", ["add", "--parents", file]);
    sh("svn", ["commit", "-m", `edit ${rel}`, wc]);
  };

  beforeAll(() => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wcp-it-")));
    const repo = path.join(base, "repo");
    sh("svnadmin", ["create", repo]);
    url = pathToFileURL(repo).href;
    const seed = path.join(base, "seed");
    for (const [rel, text] of [
      ["Assets/a.txt", "a\n"],
      ["Assets/Art/big.bin", "BIG\n"],
      ["Assets/Art/Sub/x.txt", "x\n"],
      ["Code/main.cs", "class Main {}\n"],
      ["README.md", "readme\n"],
    ]) {
      const file = path.join(seed, "trunk", ...rel.split("/"));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    mkdirSync(path.join(seed, "branches"));
    sh("svn", ["import", "-m", "seed", seed, url]);
    for (const b of ["b1", "b2", "b3"]) sh("svn", ["copy", "-m", `branch ${b}`, `${url}/trunk`, `${url}/branches/${b}`]);
    poolRoot = path.join(base, "pool");
    store = path.join(base, "pool-slots");
    scratch = path.join(base, "scratch");
    mkdirSync(poolRoot);
    mkdirSync(store);
    mkdirSync(scratch);
    commit("b3", "Code/b3.cs", "b3\n");
    writeConfig({ maxSlots: 2 });
  }, 60_000);

  afterAll(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it("dry-run 打印稀疏计划与存储目录且不建池目录", async () => {
    const result = await run("acquire", { branch: "b1" }, { ...ctx(), dryRun: true });
    expect(result.detail).toMatch(/^dry-run: /);
    expect(result.detail).toContain("稀疏：根目录 infinity");
    expect(result.detail).toContain("exclude：Assets/Art");
    expect(result.detail).toContain(store);
    expect(existsSync(path.join(poolRoot, ".pool"))).toBe(false);
  });

  it("新建：槽位落在存储目录，稀疏检出，被排除目录不下载，建入口链接", async () => {
    const result = await call("acquire", { branch: "b1", ttl: "1d", tag: "bug-1" });
    expect(result.code).toBe(0);
    expect(result.summary).toBe("b1 就绪（s01，新建，落后 0）");
    expect(slotOf("s01")?.path).toBe(slot("s01"));
    expect(existsSync(path.join(poolRoot, "slots"))).toBe(false);
    expect(readFileSync(path.join(slot("s01"), "Assets", "a.txt"), "utf8")).toBe("a\n");
    expect(existsSync(path.join(slot("s01"), "Code", "main.cs"))).toBe(true);
    expect(existsSync(path.join(slot("s01"), "README.md"))).toBe(true);
    expect(existsSync(path.join(slot("s01"), "Assets", "Art"))).toBe(false);
    expect(isLink(link("b1"))).toBe(true);
    expect(realpathSync(linkTarget(link("b1"))!)).toBe(slot("s01"));
    const pool = result.pool as { slots: { id: string; branch: string; state: string; path: string; lease: { tag?: string } | null }[] };
    expect(pool.slots).toEqual([
      expect.objectContaining({ id: "s01", branch: "b1", state: "occupied", path: slot("s01"), lease: expect.objectContaining({ tag: "bug-1" }) }),
    ]);
  }, 60_000);

  it("已在池中：续租不切换", async () => {
    const result = await call("acquire", { branch: "b1" });
    expect(result.summary).toBe("b1 就绪（s01，已在池中，落后 0）");
  }, 30_000);

  it("池满：失败并列出现状", async () => {
    await call("acquire", { branch: "b2", ttl: "1d" });
    await expect(call("acquire", { branch: "b3" })).rejects.toThrow(/池满（2\/2）[\s\S]*s01 b1[\s\S]*s02 b2/);
  }, 60_000);

  it("查询：occupied、candidates、status", async () => {
    const occ = await call("occupied");
    expect(occ.choices?.map((c) => c.value)).toEqual(["b1", "b2"]);
    expect(occ.choices?.[0].hint).toContain("bug-1");
    const cand = await call("candidates");
    const values = cand.choices?.map((c) => c.value) ?? [];
    expect(values.slice(0, 2)).toEqual(["b1", "b2"]);
    expect(values).toContain("b3");
    expect(cand.choices?.find((c) => c.value === "b3")?.hint).toContain("池满");
    expect(existsSync(path.join(poolRoot, ".pool", "cache", "list-from.json"))).toBe(true);
    writeFileSync(path.join(slot("s01"), "Assets", "a.txt"), "a\nlocal edit\n");
    const st = await call("status");
    expect(st.summary).toBe("2/2 个槽位：占用 2，空闲 0");
    expect(st.detail).toContain("改动 1 / 未纳管 0");
    expect(st.detail).toContain(`实际目录：${slot("s01")}`);
    sh("svn", ["revert", path.join(slot("s01"), "Assets", "a.txt")]);
  }, 60_000);

  it("pattern 带后缀：listFrom 列出的分支根也能进候选", async () => {
    const root = path.join(base, "pool-suffix");
    mkdirSync(root);
    writeFileSync(
      path.join(root, "pool.toml"),
      [
        `maxSlots = 1`,
        `svnRoot = "${url}"`,
        "",
        "[branches]",
        `pattern = "branches/{name}/Assets"`,
        `listFrom = ["branches"]`,
        "",
        "[storage]",
        `roots = [${JSON.stringify(store)}]`,
        "",
      ].join("\n"),
    );
    const cand = await run("candidates", {}, { ...ctx(), cwd: root, workspacePath: root });
    expect(cand.choices?.map((c) => c.value).sort()).toEqual(["b1", "b2", "b3"]);
  }, 30_000);

  it("release 只清租约不动文件；带改动切换后 patch 能恢复", async () => {
    const edited = path.join(slot("s01"), "Assets", "a.txt");
    writeFileSync(edited, "a\nmy change\n");
    writeFileSync(path.join(slot("s01"), "Code", "scratch.txt"), "untracked\n");
    const rel = await call("release", { branch: "b1" });
    expect(rel.skipped).toBeFalsy();
    expect(readFileSync(edited, "utf8")).toBe("a\nmy change\n");
    expect(isLink(link("b1"))).toBe(true);
    expect((await call("release", { branch: "b1" })).skipped).toBe(true);

    const result = await call("acquire", { branch: "b3" });
    expect(result.summary).toBe("b3 就绪（s01，切换，落后 0）");
    expect(isLink(link("b1"))).toBe(false);
    expect(existsSync(path.join(slot("s01"), "Code", "b3.cs"))).toBe(true);
    expect(existsSync(path.join(slot("s01"), "Assets", "Art"))).toBe(false);
    expect(readFileSync(path.join(slot("s01"), "Assets", "a.txt"), "utf8")).toBe("a\n");

    const archives = readdirSync(path.join(poolRoot, "patches", "b1"));
    expect(archives).toHaveLength(1);
    const dir = path.join(poolRoot, "patches", "b1", archives[0]);
    expect(readFileSync(path.join(dir, "unversioned.txt"), "utf8")).toContain("Code/scratch.txt");
    expect(readFileSync(path.join(dir, "files", "Assets", "a.txt"), "utf8")).toBe("a\nmy change\n");

    // 切回 b1 后用 svn patch 恢复改动
    await call("release", { branch: "b3" });
    await call("acquire", { branch: "b1" });
    expect(realpathSync(linkTarget(link("b1"))!)).toBe(slot("s01"));
    sh("svn", ["patch", path.join(dir, "changes.patch"), slot("s01")]);
    expect(readFileSync(edited, "utf8")).toBe("a\nmy change\n");
    sh("svn", ["revert", "-R", slot("s01")]);
  }, 120_000);

  it("refresh：只更新已挂槽的工程；未挂槽、被占用的跳过", async () => {
    await call("release", { branch: "b1" });
    commit("b1", "Code/b1.cs", "b1 v2\n");
    writeConfig({ maxSlots: 3, projects: ["b3", "b2", "b1"] });
    const first = await call("refresh");
    expect(first.code).toBe(0);
    expect(first.summary).toBe("工程 3 个：更新 1，跳过 2，失败 0");
    expect(first.detail).toMatch(/b3：跳过：未挂槽（按需占用时分配）/);
    expect(first.detail).toMatch(/b2：跳过：s02 被占用/);
    expect(first.detail).toMatch(/b1：已更新（s01，落后 0）/);
    expect(readFileSync(path.join(slot("s01"), "Code", "b1.cs"), "utf8")).toBe("b1 v2\n");
    expect(existsSync(path.join(slot("s01"), "Assets", "Art"))).toBe(false);
    expect(state().slots.map((s) => s.id)).toEqual(["s01", "s02"]);
    const st = await call("status");
    expect(st.summary).toBe("2/3 个槽位：占用 1，空闲 1");
    expect(st.detail).toContain("工程未挂槽：b3（打开时按需分配）");
    expect((st.pool as { projects: string[] }).projects).toEqual(["b3", "b2", "b1"]);

    // 按需占用才挂槽：b1、b2 都被占用时 b3 新建 s03
    await call("acquire", { branch: "b1", ttl: "1d" });
    const b3 = await call("acquire", { branch: "b3" });
    expect(b3.summary).toBe("b3 就绪（s03，新建，落后 0）");
    expect(slotOf("s03")?.path).toBe(slot("s03"));
    await call("release", { branch: "b3" });

    commit("b3", "Code/b3.cs", "b3 v2\n");
    const second = await call("refresh");
    expect(second.detail).toMatch(/b3：已更新（s03，落后 0）/);
    expect(second.detail).toMatch(/b1：跳过：s01 被占用/);
    expect(readFileSync(path.join(slot("s03"), "Code", "b3.cs"), "utf8")).toBe("b3 v2\n");
    expect(existsSync(path.join(slot("s03"), "Assets", "Art"))).toBe(false);
  }, 180_000);

  it("gc 缩容：只回收空闲槽位，不在工程清单里的先回收，占用中的等租约结束", async () => {
    writeConfig({ maxSlots: 1, projects: ["b3"] });
    await call("acquire", { branch: "b3", ttl: "1d" });
    const pending = await call("gc");
    expect(pending.detail).toContain("还需缩减 2 个槽位");
    expect(state().slots.map((s) => s.id)).toEqual(["s01", "s02", "s03"]);

    await call("release", { branch: "b1" });
    await call("release", { branch: "b3" });
    writeConfig({ maxSlots: 2, projects: ["b3"] });
    const shrink = await call("gc");
    expect(shrink.detail).toContain("已删除 s01（b1）");
    expect(existsSync(slot("s01"))).toBe(false);
    expect(isLink(link("b1"))).toBe(false);
    expect(isLink(link("b3"))).toBe(true);
    expect(state().slots.map((s) => s.id)).toEqual(["s02", "s03"]);
  }, 120_000);

  it("中断恢复：新建中断删目录，切换已完成补链接", async () => {
    writeConfig({ maxSlots: 3, projects: ["b3"] });
    const paths = poolPaths(poolRoot);
    const s = state();
    const s02 = s.slots.find((x) => x.id === "s02")!;
    s02.phase = "switching";
    s02.op = { kind: "switch", target: "b2", pid: deadPid(), at: new Date().toISOString(), from: "b2" };
    s.slots.push({
      id: "s09",
      path: slot("s09"),
      branch: "",
      url: "",
      phase: "switching",
      lease: null,
      op: { kind: "create", target: "b1", pid: deadPid(), at: new Date().toISOString(), created: true },
    });
    mkdirSync(slot("s09"), { recursive: true });
    writeFileSync(paths.state, JSON.stringify(s));
    rmSync(link("b2"));

    const st = await call("status");
    expect(st.detail).toContain("中断待恢复");
    const result = await call("gc");
    expect(result.code).toBe(0);
    expect(existsSync(slot("s09"))).toBe(false);
    const after = state();
    expect(after.slots.map((x) => x.id)).toEqual(["s02", "s03"]);
    expect(after.slots[0]).toMatchObject({ phase: "ready", branch: "b2" });
    expect(after.slots[0].op).toBeUndefined();
    expect(isLink(link("b2"))).toBe(true);
  }, 60_000);

  it("取消：中途中止后，下一次运行接手恢复", async () => {
    await call("release", { branch: "b2" });
    const controller = new AbortController();
    await expect(
      call("acquire", { branch: "b1" }, controller.signal, (m) => {
        if (m.includes("svn switch")) controller.abort();
      }),
    ).rejects.toThrow();
    // 真实场景里被取消的进程会退出；这里把 op.pid 换成已退出的 pid
    const paths = poolPaths(poolRoot);
    const s = state();
    const stuck = s.slots.find((x) => x.op);
    expect(stuck).toBeDefined();
    stuck!.op!.pid = deadPid();
    writeFileSync(paths.state, JSON.stringify(s));

    const result = await call("acquire", { branch: "b1" });
    expect(result.detail).toMatch(/恢复与校正：.*s02 中断/);
    expect(result.summary).toMatch(/^b1 就绪（s02，/);
    expect(state().slots.every((x) => !x.op)).toBe(true);
    expect(realpathSync(linkTarget(link("b1"))!)).toBe(slot("s02"));
  }, 120_000);

  it("池外 svn switch：按实际分支校正记录与入口；与别的槽位重复时保持阻塞，切回后解除", async () => {
    // s03（b3）被人在池外切到 b2，b2 不在池里
    sh("svn", ["switch", `${url}/branches/b2`, slot("s03")]);
    const fixed = await call("gc");
    expect(fixed.detail).toContain("s03 b3：被池外切换到 b2，已按实际分支 b2 记录");
    expect(slotOf("s03")).toMatchObject({ branch: "b2", phase: "ready" });
    expect(isLink(link("b3"))).toBe(false);
    expect(realpathSync(linkTarget(link("b2"))!)).toBe(slot("s03"));

    // 再切到 b1：b1 已在 s02 上，标为阻塞，入口仍指向 s02
    sh("svn", ["switch", `${url}/branches/b1`, slot("s03")]);
    const dup = await call("refresh");
    expect(dup.detail).toContain("被池外切换到 b1，与 s02 重复，已标为阻塞");
    expect(slotOf("s03")).toMatchObject({ branch: "", phase: "blocked" });
    expect(isLink(link("b2"))).toBe(false);
    expect(realpathSync(linkTarget(link("b1"))!)).toBe(slot("s02"));

    // gc 复查：仍重复就保持阻塞，不当成空闲槽位换出
    const still = await call("gc");
    expect(still.detail).toMatch(/仍阻塞：[\s\S]*s03 \(未定\)：工作副本在 b1 上，但 b1 已在 s02 上/);
    expect(slotOf("s03")).toMatchObject({ branch: "", phase: "blocked" });

    // 切回 b3 后 gc 解除阻塞并恢复入口
    sh("svn", ["switch", `${url}/branches/b3`, slot("s03")]);
    const back = await call("gc");
    expect(back.detail).toMatch(/解除阻塞：[\s\S]*s03 b3/);
    expect(slotOf("s03")).toMatchObject({ branch: "b3", phase: "ready" });
    expect(realpathSync(linkTarget(link("b3"))!)).toBe(slot("s03"));
  }, 120_000);

  it("白名单：空壳 + 列出目录，切换不带下新顶层目录，导出与配置一致，改配置后重新应用", async () => {
    const root = path.join(base, "pool-white");
    const whiteStore = path.join(base, "pool-white-slots");
    mkdirSync(root);
    mkdirSync(whiteStore);
    const wctx = (): ToolRunContext => ({ ...ctx(), cwd: root, workspacePath: root });
    const wcall = (tool: string, params: Record<string, unknown> = {}): Promise<ToolRunResult> => run(tool, params, wctx());
    const wc = path.join(whiteStore, "s01");
    const has = (rel: string): boolean => existsSync(path.join(wc, ...rel.split("/")));
    const whitelist = ["[sparse]", `root = "empty"`, "", "[sparse.depth]", `"Code" = "infinity"`, `"Assets/Art/Sub" = "infinity"`, `"Missing/Dir" = "files"`];
    writeConfig({ root, store: whiteStore, maxSlots: 1, sparse: whitelist });

    const dry = await run("acquire", { branch: "b1" }, { ...wctx(), dryRun: true });
    expect(dry.detail).toContain("自动空壳（empty）：Assets、Assets/Art、Missing");

    const first = await wcall("acquire", { branch: "b1" });
    expect(first.code).toBe(0);
    expect(has("Code/main.cs")).toBe(true);
    expect(has("Assets/Art/Sub/x.txt")).toBe(true);
    expect(has("README.md")).toBe(false);
    expect(has("Assets/a.txt")).toBe(false);
    expect(has("Assets/Art/big.bin")).toBe(false);
    expect(has("Missing")).toBe(false);

    // b2 新增顶层目录和 Code 下的文件：切换后前者不下载，后者跟着 infinity 下来
    commit("b2", "NewTop/n.txt", "n\n");
    commit("b2", "Code/new.cs", "new\n");
    await wcall("release", { branch: "b1" });
    const switched = await wcall("acquire", { branch: "b2" });
    expect(switched.summary).toMatch(/^b2 就绪（s01，切换/);
    expect(has("Code/new.cs")).toBe(true);
    expect(has("NewTop")).toBe(false);
    expect(has("Assets/Art/Sub/x.txt")).toBe(true);
    expect(has("Assets/a.txt")).toBe(false);

    const captured = await run("capture-sparse", { path: wc }, { ...ctx(), cwd: base, workspacePath: base });
    expect(captured.code).toBe(0);
    const toml = captured.detail.slice(captured.detail.indexOf("[sparse]"));
    expect(toml).toContain('root = "empty"');
    expect(toml).toContain('"Assets/Art/Sub" = "infinity"');
    expect(toml).toMatch(/"Code"\s+= "infinity"/);
    expect(toml).not.toMatch(/"Assets" =/);
    const capturedRun = await run("capture-sparse", { path: wc }, { ...ctx(), cwd: base, workspacePath: base, dryRun: true });
    expect(capturedRun.detail).toContain("只读");

    // 改成黑名单：根目录展开为完整检出，只排除 Assets/Art/Sub
    await wcall("release", { branch: "b2" });
    writeConfig({ root, store: whiteStore, maxSlots: 1, projects: ["b2"], sparse: ["[sparse]", `exclude = ["Assets/Art/Sub"]`] });
    const black = await wcall("refresh");
    expect(black.code).toBe(0);
    expect(has("README.md")).toBe(true);
    expect(has("NewTop/n.txt")).toBe(true);
    expect(has("Assets/a.txt")).toBe(true);
    expect(has("Assets/Art/big.bin")).toBe(true);
    expect(has("Assets/Art/Sub")).toBe(false);

    // 去掉 [sparse]：恢复完整检出
    writeConfig({ root, store: whiteStore, maxSlots: 1, projects: ["b2"], sparse: [] });
    const full = await wcall("refresh");
    expect(full.code).toBe(0);
    expect(has("Assets/Art/Sub/x.txt")).toBe(true);
  }, 180_000);
});
