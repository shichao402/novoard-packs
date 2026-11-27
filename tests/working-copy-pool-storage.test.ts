import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig, type PoolConfig } from "../packs/workingCopyPool/src/config";
import { claimSlot } from "../packs/workingCopyPool/src/pool";
import { ensureLayout, poolPaths, readState, slotDir, type PoolState, type Slot } from "../packs/workingCopyPool/src/state";
import { inspectStorage, minFreeFor, rootOf, selectSlotPath, type InspectStorage } from "../packs/workingCopyPool/src/storage";

const dirs: string[] = [];
function temp(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wcp-storage-unit-")));
  dirs.push(root);
  return root;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const base = 'maxSlots = 4\nsvnRoot = "file:///example"\n';
const slot = (id: string, wc: string, over: Partial<Slot> = {}): Slot => ({ id, path: wc, branch: "a", url: "", phase: "ready", ...over });
const empty = (): PoolState => ({ version: 1, slots: [] });
/** 每个目录同一个下限的简写。 */
const uniform = (roots: string[], minFreeGiB: number): PoolConfig["storage"] => ({ roots: roots.map((p) => ({ path: p, minFreeGiB })), minFreeGiB });

function fixture() {
  const root = temp();
  const paths = poolPaths(path.join(root, "pool"));
  ensureLayout(paths);
  const a = path.join(root, "disk-a");
  const b = path.join(root, "disk-b");
  mkdirSync(a);
  mkdirSync(b);
  return { root, paths, a, b };
}
function probe(entries: Record<string, { volume: string; freeGiB: number }>): InspectStorage {
  return (root) => {
    const entry = entries[root];
    if (!entry) throw new Error("磁盘不可用");
    return { root, ...entry };
  };
}

describe("多盘 pool.toml", () => {
  it("roots 必填；字符串与 { path, minFreeGiB } 可混写，没写下限的用默认值", () => {
    const { a, b } = fixture();
    expect(() => parseConfig(base)).toThrow(/缺少 \[storage\]\.roots/);
    const cfg = parseConfig(`${base}[storage]\nroots = [${JSON.stringify(a)}, { path = ${JSON.stringify(b)}, minFreeGiB = 100 }, ${JSON.stringify(a)}]\nminFreeGiB = 750\n`);
    expect(cfg.storage).toEqual({ roots: [{ path: a, minFreeGiB: 750 }, { path: b, minFreeGiB: 100 }], minFreeGiB: 750 });
  });
  it.each([
    ['roots = []', /应为非空数组/],
    ['roots = ["relative/slots"]', /绝对目录/],
    ['roots = "x"', /应为非空数组/],
    ['roots = [1]', /每项应为目录字符串或 \{ path, minFreeGiB \}/],
    ['minFreeGiB = -1', /storage.minFreeGiB/],
    ['minFreeGiB = 0.5', /storage.minFreeGiB/],
    ['minFreeGB = 10', /未知字段/],
  ])("拒绝错误配置：%s", (field, expected) => {
    expect(() => parseConfig(`${base}[storage]\n${field}\n`)).toThrow(expected);
  });
  it("不接受盘根目录", () => {
    const root = path.parse(temp()).root;
    expect(() => parseConfig(`${base}[storage]\nroots = ${JSON.stringify([root])}\n`)).toThrow(/盘根/);
  });
  it("按槽位父目录找到所属存储目录与下限；配置里已删掉的目录用默认下限", () => {
    const { root, a, b } = fixture();
    const storage: PoolConfig["storage"] = { roots: [{ path: a, minFreeGiB: 300 }, { path: b, minFreeGiB: 50 }], minFreeGiB: 10 };
    expect(rootOf(storage, path.join(a, "s01"))).toEqual({ path: a, minFreeGiB: 300 });
    expect(minFreeFor(storage, path.join(b, "s02"))).toBe(50);
    expect(rootOf(storage, path.join(root, "old", "s03"))).toBeUndefined();
    expect(minFreeFor(storage, path.join(root, "old", "s03"))).toBe(10);
  });
});

describe("槽位路径与迁移", () => {
  it("路径从记录读取，不依赖后续配置", () => {
    const { paths, a } = fixture();
    const state: PoolState = { version: 1, slots: [slot("s02", path.join(a, "s02"))] };
    writeFileSync(paths.state, JSON.stringify(state));
    expect(slotDir(paths, "s02")).toBe(path.join(a, "s02"));
    expect(slotDir(paths, state.slots[0])).toBe(path.join(a, "s02"));
    expect(readState(paths)).toEqual(state);
  });
  it("没有记录 path 的旧槽位报迁移错误，不再回退到池定义目录里的 slots/", () => {
    const { paths, a } = fixture();
    const legacy = { id: "s01", branch: "a", url: "", phase: "ready" };
    writeFileSync(paths.state, JSON.stringify({ version: 1, slots: [legacy, slot("s02", path.join(a, "s02"))] }));
    expect(() => readState(paths)).toThrow(/s01 没有记录 path：池定义目录里的 slots\/ 布局已不再支持/);
    expect(JSON.parse(readFileSync(paths.state, "utf8")).slots[0].path).toBeUndefined();
  });
  it("拒绝危险编号、非绝对路径、根目录和错误槽位名", () => {
    const { paths, a } = fixture();
    expect(() => slotDir(paths, slot("../other", path.join(a, "../other")))).toThrow(/编号/);
    expect(() => slotDir(paths, "s09")).toThrow(/不在状态文件里/);
    for (const p of ["relative/s01", path.parse(a).root, path.join(a, "s02")]) {
      expect(() => slotDir(paths, slot("s01", p))).toThrow(/path/);
    }
    writeFileSync(paths.state, JSON.stringify({ version: 1, slots: [slot("s01", path.join(a, "s01")), slot("s01", path.join(a, "s01"))] }));
    expect(() => readState(paths)).toThrow(/重复槽位/);
  });
  it("只有真正新建才分配路径；失败不残留预占记录", () => {
    const { a } = fixture();
    const cfg = parseConfig(`${base}projects = ["a"]\n[storage]\nroots = [${JSON.stringify(a)}]\n`);
    const state: PoolState = { version: 1, slots: [slot("s01", path.join(a, "s01"))] };
    const allocate = (): string => { throw new Error("空间不足"); };
    expect(claimSlot(state, cfg, "a", null, new Date(), allocate).kind).toBe("hit");
    expect(() => claimSlot(state, cfg, "b", null, new Date(), allocate, new Set(["s01"]))).toThrow("空间不足");
    expect(state.slots).toHaveLength(1);
    const created = claimSlot(state, cfg, "b", null, new Date(), (id) => path.join(a, id), new Set(["s01"]));
    expect(created).toMatchObject({ kind: "create", slot: { id: "s02", path: path.join(a, "s02") } });
  });
});

describe("存储目录选择", () => {
  it("选择空间最多的合格目录；空间相同按配置顺序", () => {
    const { paths, a, b } = fixture();
    const storage = uniform([a, b], 700);
    expect(selectSlotPath(paths, empty(), "s01", storage, probe({
      [a]: { volume: "a", freeGiB: 650 }, [b]: { volume: "b", freeGiB: 900 },
    }))).toBe(path.join(b, "s01"));
    expect(selectSlotPath(paths, empty(), "s01", storage, probe({
      [a]: { volume: "a", freeGiB: 900 }, [b]: { volume: "b", freeGiB: 900 },
    }))).toBe(path.join(a, "s01"));
  });
  it("每个目录按自己的下限准入", () => {
    const { paths, a, b } = fixture();
    const storage: PoolConfig["storage"] = { roots: [{ path: a, minFreeGiB: 900 }, { path: b, minFreeGiB: 100 }], minFreeGiB: 0 };
    expect(selectSlotPath(paths, empty(), "s01", storage, probe({
      [a]: { volume: "a", freeGiB: 800 }, [b]: { volume: "b", freeGiB: 300 },
    }))).toBe(path.join(b, "s01"));
    expect(() => selectSlotPath(paths, empty(), "s01", storage, probe({
      [a]: { volume: "a", freeGiB: 800 }, [b]: { volume: "b", freeGiB: 50 },
    }))).toThrow(new RegExp(`${a.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}：剩余 800\\.0 GiB.*要求至少 900 GiB`));
  });
  it("空间不足或盘不可用时拒绝，不回退到池定义目录", () => {
    const { paths, a, b } = fixture();
    const storage = uniform([a, b], 700);
    expect(() => selectSlotPath(paths, empty(), "s01", storage, probe({
      [a]: { volume: "a", freeGiB: 500 },
    }))).toThrow(/剩余 500.0 GiB[\s\S]*磁盘不可用[\s\S]*不会自动回退/);
    expect(existsSync(path.join(paths.root, "s01"))).toBe(false);
    expect(existsSync(path.join(a, "s01"))).toBe(false);
    expect(() => selectSlotPath(paths, empty(), "s01", { roots: [], minFreeGiB: 0 })).toThrow(/没有配置槽位存储目录/);
  });
  it("同一个盘多个目录也扣除并发新建预留，预留按新建所在目录的下限", () => {
    const { paths, a, b, root } = fixture();
    const c = path.join(root, "disk-c");
    mkdirSync(c);
    const state: PoolState = { version: 1, slots: [slot("s01", path.join(a, "s01"), {
      phase: "switching", op: { kind: "create", pid: process.pid, at: "" },
    })] };
    const inspect = probe({
      [a]: { volume: "same-disk", freeGiB: 1000 },
      [b]: { volume: "same-disk", freeGiB: 1000 },
      [c]: { volume: "other-disk", freeGiB: 800 },
    });
    // a 不在 roots 里：预留用默认 600，b 剩 400 不够
    expect(selectSlotPath(paths, state, "s02", uniform([b, c], 600), inspect)).toBe(path.join(c, "s02"));
    // a 自己的下限是 100：b 扣除后剩 900，空间最多
    const own: PoolConfig["storage"] = { roots: [{ path: b, minFreeGiB: 600 }, { path: c, minFreeGiB: 600 }, { path: a, minFreeGiB: 100 }], minFreeGiB: 600 };
    expect(selectSlotPath(paths, state, "s02", own, inspect)).toBe(path.join(b, "s02"));
  });
  it("不覆盖已有同名内容，选择另一个合格目录", () => {
    const { paths, a, b } = fixture();
    const existing = path.join(a, "s01");
    mkdirSync(existing);
    writeFileSync(path.join(existing, "keep.txt"), "keep");
    expect(selectSlotPath(paths, empty(), "s01", uniform([a, b], 0), probe({
      [a]: { volume: "a", freeGiB: 1000 }, [b]: { volume: "b", freeGiB: 900 },
    }))).toBe(path.join(b, "s01"));
    expect(readFileSync(path.join(existing, "keep.txt"), "utf8")).toBe("keep");
  });
  it("不覆盖断链", () => {
    const { paths, a, root } = fixture();
    const target = path.join(root, "missing");
    symlinkSync(target, path.join(a, "s01"), process.platform === "win32" ? "junction" : "dir");
    expect(() => selectSlotPath(paths, empty(), "s01", uniform([a], 0), probe({
      [a]: { volume: "a", freeGiB: 1000 },
    }))).toThrow(/已有 s01 目录或链接/);
  });
  it("不分配进池定义目录（配置、入口、存档）或其他槽位里面", () => {
    const { paths, a } = fixture();
    for (const root of [paths.root, paths.meta, paths.branch, paths.patches]) {
      expect(() => selectSlotPath(paths, empty(), "s01", uniform([root], 0), probe({
        [root]: { volume: "a", freeGiB: 1000 },
      }))).toThrow(/不能把槽位放进池定义目录/);
    }
    const wc = path.join(a, "s01");
    mkdirSync(wc);
    const state: PoolState = { version: 1, slots: [slot("s01", wc)] };
    expect(() => selectSlotPath(paths, state, "s02", uniform([wc], 0), probe({
      [wc]: { volume: "a", freeGiB: 1000 },
    }))).toThrow(/已有槽位路径重叠/);
  });
  it("真实容量读取只读且缺失目录不会自动创建", () => {
    const root = temp();
    expect(inspectStorage(root)).toMatchObject({ root, freeGiB: expect.any(Number) });
    const missing = path.join(root, "missing");
    expect(() => inspectStorage(missing)).toThrow();
    expect(existsSync(missing)).toBe(false);
  });
});
