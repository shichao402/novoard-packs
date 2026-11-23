import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../packs/workingCopyPool/src/config";
import { claimSlot } from "../packs/workingCopyPool/src/pool";
import { ensureLayout, poolPaths, readState, slotDir, type PoolState, type Slot } from "../packs/workingCopyPool/src/state";
import { inspectStorage, selectSlotPath, type InspectStorage } from "../packs/workingCopyPool/src/storage";

const dirs: string[] = [];
function temp(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wcp-storage-unit-")));
  dirs.push(root);
  return root;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const base = 'maxSlots = 4\nsvnRoot = "file:///example"\n';
const slot = (id = "s01", over: Partial<Slot> = {}): Slot => ({ id, branch: "a", url: "", phase: "ready", ...over });
const empty = (): PoolState => ({ version: 1, slots: [] });

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
  it("缺省仍使用原 slots，支持绝对专用目录和新建准入阈值", () => {
    const { a, b } = fixture();
    expect(parseConfig(base).storage).toEqual({ roots: [], minFreeGiB: 0 });
    const cfg = parseConfig(`${base}[storage]\nroots = ${JSON.stringify([a, b, a])}\nminFreeGiB = 750\n`);
    expect(cfg.storage).toEqual({ roots: [a, b], minFreeGiB: 750 });
  });
  it.each([
    ['roots = []', /至少指定一个/],
    ['roots = ["relative/slots"]', /绝对目录/],
    ['roots = "x"', /字符串数组/],
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
});

describe("槽位路径兼容与安全", () => {
  it("旧记录不迁移；新路径从记录读取，不依赖后续配置", () => {
    const { paths, a } = fixture();
    const state: PoolState = { version: 1, slots: [slot(), slot("s02", { path: path.join(a, "s02") })] };
    writeFileSync(paths.state, JSON.stringify(state));
    expect(slotDir(paths, "s01")).toBe(path.join(paths.slots, "s01"));
    expect(slotDir(paths, "s02")).toBe(path.join(a, "s02"));
    expect(slotDir(paths, state.slots[1])).toBe(path.join(a, "s02"));
    expect(readState(paths)).toEqual(state);
    expect(JSON.parse(readFileSync(paths.state, "utf8")).slots[0].path).toBeUndefined();
  });
  it("拒绝危险编号、非绝对路径、根目录和错误槽位名", () => {
    const { paths, a } = fixture();
    expect(() => slotDir(paths, "../other")).toThrow(/编号/);
    for (const p of ["relative/s01", path.parse(a).root, path.join(a, "s02")]) {
      expect(() => slotDir(paths, slot("s01", { path: p }))).toThrow(/path/);
    }
    writeFileSync(paths.state, JSON.stringify({ version: 1, slots: [slot(), slot()] }));
    expect(() => readState(paths)).toThrow(/重复槽位/);
  });
  it("只有真正新建才分配路径；失败不残留预占记录", () => {
    const { a } = fixture();
    const cfg = parseConfig(`${base}resident = ["a"]\n`);
    const state: PoolState = { version: 1, slots: [slot()] };
    const allocate = () => { throw new Error("空间不足"); };
    expect(claimSlot(state, cfg, "a", null, new Date(), new Set(), allocate).kind).toBe("hit");
    expect(() => claimSlot(state, cfg, "b", null, new Date(), new Set(), allocate)).toThrow("空间不足");
    expect(state.slots).toHaveLength(1);
    const created = claimSlot(state, cfg, "b", null, new Date(), new Set(), (id) => path.join(a, id));
    expect(created).toMatchObject({ kind: "create", slot: { id: "s02", path: path.join(a, "s02") } });
  });
});

describe("存储目录选择", () => {
  it("选择空间最多的合格目录；空间相同按配置顺序", () => {
    const { paths, a, b } = fixture();
    const storage = { roots: [a, b], minFreeGiB: 700 };
    expect(selectSlotPath(paths, empty(), "s01", storage, probe({
      [a]: { volume: "a", freeGiB: 650 }, [b]: { volume: "b", freeGiB: 900 },
    }))).toBe(path.join(b, "s01"));
    expect(selectSlotPath(paths, empty(), "s01", storage, probe({
      [a]: { volume: "a", freeGiB: 900 }, [b]: { volume: "b", freeGiB: 900 },
    }))).toBe(path.join(a, "s01"));
  });
  it("空间不足或盘不可用时拒绝，不回退到池根", () => {
    const { paths, a, b } = fixture();
    const storage = { roots: [a, b], minFreeGiB: 700 };
    expect(() => selectSlotPath(paths, empty(), "s01", storage, probe({
      [a]: { volume: "a", freeGiB: 500 },
    }))).toThrow(/剩余 500.0 GiB[\s\S]*磁盘不可用[\s\S]*不会自动回退/);
    expect(existsSync(path.join(paths.slots, "s01"))).toBe(false);
  });
  it("同一个盘多个目录也扣除并发新建预留", () => {
    const { paths, a, b, root } = fixture();
    const c = path.join(root, "disk-c");
    mkdirSync(c);
    const state: PoolState = { version: 1, slots: [slot("s01", {
      path: path.join(a, "s01"), phase: "switching", op: { kind: "create", pid: process.pid, at: "" },
    })] };
    const result = selectSlotPath(paths, state, "s02", { roots: [b, c], minFreeGiB: 600 }, probe({
      [a]: { volume: "same-disk", freeGiB: 1000 },
      [b]: { volume: "same-disk", freeGiB: 1000 },
      [c]: { volume: "other-disk", freeGiB: 800 },
    }));
    expect(result).toBe(path.join(c, "s02"));
  });
  it("不覆盖已有同名内容，选择另一个合格目录", () => {
    const { paths, a, b } = fixture();
    const existing = path.join(a, "s01");
    mkdirSync(existing);
    writeFileSync(path.join(existing, "keep.txt"), "keep");
    expect(selectSlotPath(paths, empty(), "s01", { roots: [a, b], minFreeGiB: 0 }, probe({
      [a]: { volume: "a", freeGiB: 1000 }, [b]: { volume: "b", freeGiB: 900 },
    }))).toBe(path.join(b, "s01"));
    expect(readFileSync(path.join(existing, "keep.txt"), "utf8")).toBe("keep");
  });
  it("不覆盖断链", () => {
    const { paths, a, root } = fixture();
    const target = path.join(root, "missing");
    symlinkSync(target, path.join(a, "s01"), process.platform === "win32" ? "junction" : "dir");
    expect(() => selectSlotPath(paths, empty(), "s01", { roots: [a], minFreeGiB: 0 }, probe({
      [a]: { volume: "a", freeGiB: 1000 },
    }))).toThrow(/已有 s01 目录或链接/);
  });
  it("不分配进元数据、入口、存档或其他槽位里面", () => {
    const { paths, a } = fixture();
    for (const root of [paths.root, paths.meta, paths.branch, paths.patches]) {
      expect(() => selectSlotPath(paths, empty(), "s01", { roots: [root], minFreeGiB: 0 }, probe({
        [root]: { volume: "a", freeGiB: 1000 },
      }))).toThrow(/池配置、入口或存档/);
    }
    const wc = path.join(a, "s01");
    mkdirSync(wc);
    const state: PoolState = { version: 1, slots: [slot("s01", { path: wc })] };
    expect(() => selectSlotPath(paths, state, "s02", { roots: [wc], minFreeGiB: 0 }, probe({
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
