import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../packs/workingCopyPool/src/index";
import { poolPaths, readState, type PoolState } from "../packs/workingCopyPool/src/state";
import type { ToolRunContext, ToolRunResult } from "../shared/types";

const hasSvn = ["svn", "svnadmin"].every((cmd) => spawnSync(cmd, ["--version", "--quiet"]).status === 0);
function sh(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid!;

describe.skipIf(!hasSvn)("多盘存储生命周期（真实 file:// SVN）", () => {
  let base: string;
  let url: string;
  let index = 0;
  beforeAll(() => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wcp-storage-it-")));
    const repo = path.join(base, "repo");
    sh("svnadmin", ["create", repo]);
    url = pathToFileURL(repo).href;
    const seed = path.join(base, "seed");
    mkdirSync(path.join(seed, "trunk", "Code"), { recursive: true });
    mkdirSync(path.join(seed, "branches"));
    writeFileSync(path.join(seed, "trunk", "Code", "main.txt"), "main\n");
    sh("svn", ["import", "-m", "seed", seed, url]);
    for (const b of ["b1", "b2", "b3"]) sh("svn", ["copy", "-m", b, `${url}/trunk`, `${url}/branches/${b}`]);
  }, 60_000);
  afterAll(() => { if (base) rmSync(base, { recursive: true, force: true }); });

  function fixture() {
    const root = path.join(base, `pool-${index++}`);
    const a = `${root}-disk-a`;
    const b = `${root}-disk-b`;
    for (const p of [root, a, b]) mkdirSync(p);
    const config = (maxSlots = 2, resident: string[] = [], roots?: string[], minFreeGiB = 0): void => {
      writeFileSync(path.join(root, "pool.toml"), [
        `maxSlots = ${maxSlots}`, `svnRoot = ${JSON.stringify(url)}`, `resident = ${JSON.stringify(resident)}`,
        ...(roots ? ["[storage]", `roots = ${JSON.stringify(roots)}`, `minFreeGiB = ${minFreeGiB}`] : []), "",
      ].join("\n"));
    };
    config();
    const ctx = (signal?: AbortSignal, progress?: (message: string) => void): ToolRunContext => ({
      cwd: root, workspacePath: root, timeoutMs: 120_000, logFile: path.join(root, "test.log"),
      abortSignal: signal ?? new AbortController().signal, onProgress: progress,
    });
    const call = (tool: string, params: Record<string, unknown> = {}): Promise<ToolRunResult> => run(tool, params, ctx());
    const state = (): PoolState => readState(poolPaths(root));
    const save = (s: PoolState): void => writeFileSync(poolPaths(root).state, JSON.stringify(s));
    return { root, a, b, config, ctx, call, state, save };
  }

  it("旧槽位原地保留，新增外置槽位，改 roots 后命中与更新仍用记录中的目录", async () => {
    const f = fixture();
    await f.call("acquire", { branch: "b1" });
    const legacy = path.join(f.root, "slots", "s01");
    const old = f.state();
    delete old.slots[0].path;
    f.save(old);
    f.config(2, ["b1"], [f.a]);
    const created = await f.call("acquire", { branch: "b2" });
    const external = path.join(f.a, "s02");
    expect(created.detail).toContain(`实际目录：${external}`);
    expect(f.state().slots[0].path).toBeUndefined();
    expect(f.state().slots[1].path).toBe(external);
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(path.join(f.root, "slots", "s02"))).toBe(false);
    expect(realpathSync(path.join(f.root, "branch", "b2"))).toBe(external);

    f.config(2, ["b2"], [f.b]);
    const hit = await f.call("acquire", { branch: "b2" });
    expect(hit.summary).toContain("已在池中");
    expect(hit.detail).toContain(external);
    await f.call("release", { branch: "b2" });
    const refresh = await f.call("refresh");
    expect(refresh.code).toBe(0);
    expect(refresh.detail).toContain("b2：已更新（s02");
    const status = await f.call("status");
    expect(status.detail).toContain(`实际目录：${external}`);
    expect((status.pool as { slots: { path: string }[] }).slots.map((s) => s.path)).toEqual([legacy, external]);
    expect(existsSync(path.join(f.b, "s02"))).toBe(false);
  }, 120_000);

  it("外置槽位切换、存档和缩容都操作实际目录，只删自己的槽位", async () => {
    const f = fixture();
    f.config(1, [], [f.a]);
    await f.call("acquire", { branch: "b1" });
    const external = path.join(f.a, "s01");
    writeFileSync(path.join(external, "Code", "main.txt"), "local\n");
    await f.call("release", { branch: "b1" });
    const switched = await f.call("acquire", { branch: "b2" });
    expect(switched.summary).toContain("切换");
    expect(switched.detail).toContain("改动已存档");
    expect(readFileSync(path.join(external, "Code", "main.txt"), "utf8")).toBe("main\n");
    expect(f.state().slots[0].path).toBe(external);
    await f.call("release", { branch: "b2" });
    f.config(1, ["b2"], [f.a]);
    expect((await f.call("gc")).code).toBe(0);

    f.config(2, ["b2"], [f.b]);
    await f.call("acquire", { branch: "b3" });
    const removed = path.join(f.b, "s02");
    const sibling = path.join(f.b, "not-a-slot.txt");
    writeFileSync(sibling, "keep");
    await f.call("release", { branch: "b3" });
    f.config(1, ["b2"], [f.a]);
    const gc = await f.call("gc");
    expect(gc.detail).toContain("已删除 s02（b3）");
    expect(existsSync(removed)).toBe(false);
    expect(existsSync(external)).toBe(true);
    expect(readFileSync(sibling, "utf8")).toBe("keep");
    expect(f.state().slots).toHaveLength(1);
  }, 180_000);

  it("容量不足和目录碰撞不启动检出，也不残留槽位记录", async () => {
    const f = fixture();
    f.config(1, [], [f.a], 1_000_000);
    await expect(f.call("acquire", { branch: "b1" })).rejects.toThrow(/没有可用的槽位存储目录/);
    expect(f.state().slots).toEqual([]);
    expect(existsSync(path.join(f.a, "s01"))).toBe(false);
    f.config(1, [], [f.a]);
    const wc = path.join(f.a, "s01");
    mkdirSync(wc);
    writeFileSync(path.join(wc, "keep.txt"), "keep");
    await expect(f.call("acquire", { branch: "b1" })).rejects.toThrow(/不覆盖/);
    expect(f.state().slots).toEqual([]);
    expect(readFileSync(path.join(wc, "keep.txt"), "utf8")).toBe("keep");
  }, 60_000);

  it("分配后其他程序抢建同名目录时不覆盖、不删除", async () => {
    const f = fixture();
    f.config(1, [], [f.a]);
    const wc = path.join(f.a, "s01");
    const context = f.ctx(undefined, (message) => {
      if (message.includes("实际目录") && message.includes("新建")) {
        mkdirSync(wc);
        writeFileSync(path.join(wc, "keep.txt"), "keep");
      }
    });
    await expect(run("acquire", { branch: "b1" }, context)).rejects.toThrow(/EEXIST/);
    expect(readFileSync(path.join(wc, "keep.txt"), "utf8")).toBe("keep");
    expect(f.state().slots).toEqual([]);
  }, 60_000);

  it("取消后的中断恢复按记录的外置路径清理，不受新配置影响", async () => {
    const f = fixture();
    f.config(1, [], [f.a]);
    const controller = new AbortController();
    await expect(run("acquire", { branch: "b1" }, f.ctx(controller.signal, (message) => {
      if (message.includes("实际目录") && message.includes("新建")) controller.abort();
    }))).rejects.toThrow();
    const state = f.state();
    expect(state.slots[0].op?.created).toBe(true);
    expect(state.slots[0].path).toBe(path.join(f.a, "s01"));
    state.slots[0].op!.pid = deadPid();
    f.save(state);
    f.config(1, [], [f.b]);
    const recovered = await f.call("gc");
    expect(recovered.detail).toContain("新建中断");
    expect(f.state().slots).toEqual([]);
    expect(existsSync(path.join(f.a, "s01"))).toBe(false);
    expect(existsSync(path.join(f.b, "s01"))).toBe(false);
  }, 60_000);

  it("无法确认目录所有权时保留目录与记录，不自动删除", async () => {
    const f = fixture();
    await f.call("gc");
    const wc = path.join(f.a, "s01");
    mkdirSync(wc);
    writeFileSync(path.join(wc, "keep.txt"), "keep");
    f.save({ version: 1, slots: [{ id: "s01", path: wc, branch: "", url: "", phase: "switching",
      op: { kind: "create", target: "b1", pid: deadPid(), at: "" } }] });
    const recovered = await f.call("gc");
    expect(recovered.detail).toContain("所有权未确认");
    expect(f.state().slots[0]).toMatchObject({ path: wc, phase: "blocked" });
    expect(readFileSync(path.join(wc, "keep.txt"), "utf8")).toBe("keep");
  }, 60_000);

  it("正常缩容时外置盘不可访问也保留槽位，不误删记录", async () => {
    const f = fixture();
    f.config(2, ["b1"], [f.a]);
    await f.call("acquire", { branch: "b1" });
    f.config(2, ["b1"], [f.b]);
    await f.call("acquire", { branch: "b2" });
    await f.call("release", { branch: "b2" });
    f.config(1, ["b1"], [f.a]);
    const offline = `${f.b}-offline`;
    renameSync(f.b, offline);
    try {
      await expect(f.call("acquire", { branch: "b2" })).rejects.toThrow(/存储目录不可访问/);
      await f.call("release", { branch: "b2" });
      const gc = await f.call("gc");
      expect(gc.detail).toContain("存储目录不可访问");
      expect(f.state().slots).toHaveLength(2);
      expect(f.state().slots.find((s) => s.id === "s02")).toMatchObject({ path: path.join(f.b, "s02"), phase: "blocked" });
      expect(existsSync(path.join(offline, "s02", ".svn"))).toBe(true);
    } finally {
      renameSync(offline, f.b);
    }
  }, 90_000);

  it("模拟磁盘不可访问时保留槽位，不换盘重建或误删记录", async () => {
    const f = fixture();
    f.config(1, [], [f.a]);
    await f.call("acquire", { branch: "b1" });
    const state = f.state();
    state.slots[0].op = { kind: "update", target: "b1", pid: deadPid(), at: "" };
    f.save(state);
    const offline = `${f.a}-offline`;
    renameSync(f.a, offline);
    f.config(1, [], [f.b]);
    try {
      const recovered = await f.call("gc");
      expect(recovered.detail).toContain("存储目录不可访问");
      expect(f.state().slots).toHaveLength(1);
      expect(f.state().slots[0]).toMatchObject({ path: path.join(f.a, "s01"), phase: "blocked" });
      expect(existsSync(path.join(offline, "s01", ".svn"))).toBe(true);
      expect(existsSync(path.join(f.b, "s01"))).toBe(false);
    } finally {
      renameSync(offline, f.a);
    }
  }, 90_000);
});
