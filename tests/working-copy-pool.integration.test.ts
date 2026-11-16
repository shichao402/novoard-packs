/**
 * workingCopyPool 集成测试（P7、P8）：svnadmin create 建临时仓，用 file:// 跑真实 svn。
 * 覆盖：新建稀疏检出、切换、带改动切换后 patch 能恢复、池满、release 不动文件、
 * refresh 准备与更新常驻分支、缩容、中断恢复（含取消后下一次运行接手）。
 * 机器上没有 svn / svnadmin 时整组跳过。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
  const slot = (id: string): string => path.join(poolRoot, "slots", id);
  const link = (branch: string): string => path.join(poolRoot, "branch", branch);
  const writeConfig = (extra: { maxSlots: number; resident?: string[] }): void => {
    writeFileSync(
      path.join(poolRoot, "pool.toml"),
      [
        `maxSlots = ${extra.maxSlots}`,
        `svnRoot = "${url}"`,
        `resident = ${JSON.stringify(extra.resident ?? [])}`,
        "",
        "[branches]",
        `listFrom = ["branches"]`,
        "",
        "[sparse]",
        `exclude = ["Assets/Art"]`,
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
    url = `file://${repo}`;
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
    scratch = path.join(base, "scratch");
    mkdirSync(poolRoot);
    mkdirSync(scratch);
    commit("b3", "Code/b3.cs", "b3\n");
    writeConfig({ maxSlots: 2 });
  }, 60_000);

  afterAll(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it("dry-run 打印稀疏计划且不建池目录", async () => {
    const result = await run("acquire", { branch: "b1" }, { ...ctx(), dryRun: true });
    expect(result.detail).toMatch(/^dry-run: /);
    expect(result.detail).toContain("排除 Assets/Art");
    expect(result.detail).toContain("immediates）：(根)、Assets");
    expect(existsSync(path.join(poolRoot, ".pool"))).toBe(false);
  });

  it("新建：稀疏检出，被排除目录不下载，建入口链接", async () => {
    const result = await call("acquire", { branch: "b1", ttl: "1d", tag: "bug-1" });
    expect(result.code).toBe(0);
    expect(result.summary).toBe("b1 就绪（s01，新建，落后 0）");
    expect(readFileSync(path.join(slot("s01"), "Assets", "a.txt"), "utf8")).toBe("a\n");
    expect(existsSync(path.join(slot("s01"), "Code", "main.cs"))).toBe(true);
    expect(existsSync(path.join(slot("s01"), "README.md"))).toBe(true);
    expect(existsSync(path.join(slot("s01"), "Assets", "Art"))).toBe(false);
    expect(isLink(link("b1"))).toBe(true);
    expect(realpathSync(linkTarget(link("b1"))!)).toBe(slot("s01"));
    const pool = result.pool as { slots: { id: string; branch: string; state: string; lease: { tag?: string } | null }[] };
    expect(pool.slots).toEqual([expect.objectContaining({ id: "s01", branch: "b1", state: "occupied", lease: expect.objectContaining({ tag: "bug-1" }) })]);
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
    expect(st.summary).toBe("2/2 个槽位：占用 2，常驻 0，空闲 0");
    expect(st.detail).toContain("改动 1 / 未纳管 0");
    sh("svn", ["revert", path.join(slot("s01"), "Assets", "a.txt")]);
  }, 60_000);

  it("pattern 带后缀：listFrom 列出的分支根也能进候选", async () => {
    const root = path.join(base, "pool-suffix");
    mkdirSync(root);
    writeFileSync(
      path.join(root, "pool.toml"),
      [`maxSlots = 1`, `svnRoot = "${url}"`, "", "[branches]", `pattern = "branches/{name}/Assets"`, `listFrom = ["branches"]`, ""].join("\n"),
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

  it("refresh：常驻不在池里就准备，在池里就更新；被占用的跳过", async () => {
    writeConfig({ maxSlots: 3, resident: ["b3", "b2"] });
    const first = await call("refresh");
    expect(first.code).toBe(0);
    expect(first.detail).toMatch(/b3：已准备（s03，新建）/);
    expect(first.detail).toMatch(/b2：跳过：s02 被占用/);
    expect(state().slots.find((s) => s.id === "s03")).toMatchObject({ branch: "b3", lease: null });

    commit("b3", "Code/b3.cs", "b3 v2\n");
    const st = await call("status");
    expect(st.detail).toContain("s03 b3，常驻");
    const second = await call("refresh");
    expect(second.detail).toMatch(/b3：已更新（s03，落后 0）/);
    expect(readFileSync(path.join(slot("s03"), "Code", "b3.cs"), "utf8")).toBe("b3 v2\n");
    expect(existsSync(path.join(slot("s03"), "Assets", "Art"))).toBe(false);
  }, 120_000);

  it("gc 缩容：只回收空闲槽位，占用中的等租约结束", async () => {
    writeConfig({ maxSlots: 1, resident: ["b3"] });
    const pending = await call("gc");
    expect(pending.detail).toContain("还需缩减 2 个槽位");
    await call("release", { branch: "b1" });
    const shrink = await call("gc");
    expect(shrink.detail).toContain("已删除 s01（b1）");
    expect(existsSync(slot("s01"))).toBe(false);
    expect(isLink(link("b1"))).toBe(false);
    expect(state().slots.map((s) => s.id)).toEqual(["s02", "s03"]);
  }, 120_000);

  it("中断恢复：新建中断删目录，切换已完成补链接", async () => {
    writeConfig({ maxSlots: 3, resident: ["b3"] });
    const paths = poolPaths(poolRoot);
    const s = state();
    const s02 = s.slots.find((x) => x.id === "s02")!;
    s02.phase = "switching";
    s02.op = { kind: "switch", target: "b2", pid: deadPid(), at: new Date().toISOString(), from: "b2" };
    s.slots.push({ id: "s09", branch: "", url: "", phase: "switching", lease: null, op: { kind: "create", target: "b1", pid: deadPid(), at: new Date().toISOString() } });
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
    expect(result.detail).toContain("中断恢复");
    expect(result.summary).toMatch(/^b1 就绪（s02，/);
    expect(state().slots.every((x) => !x.op)).toBe(true);
    expect(realpathSync(linkTarget(link("b1"))!)).toBe(slot("s02"));
  }, 120_000);
});
