import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run as runVersionControl } from "../packs/versionControl/src/index";
import { parseConfig } from "../packs/workingCopyPool/src/config";
import { run } from "../packs/workingCopyPool/src/index";
import { mutate, poolPaths, readState } from "../packs/workingCopyPool/src/state";
import { parseConflictInfo, peg } from "../shared/svn-resolve";
import { categoryOf, discardSet, globToRegExp, parseSvnRules, ruleMatchesPath, sameExceptTopLevelKeys } from "../shared/svn-rules";
import { conflictedRelativesFromUpdateOutput } from "../shared/svn-status";
import type { ToolRunContext } from "../shared/types";

const RULES = `version = 1
[categories]
generated = ["gen/", "X86_64/GameCore.stable"]
art = ["art/"]
[discard]
always = ["generated"]
optional = ["art"]
[[rule]]
id = "identical"
when = "local-equals-incoming"
[[rule]]
id = "unity-meta-guid"
when = "yaml-keys-only"
paths = ["*.meta"]
keys = ["guid", "timeCreated"]
[[rule]]
id = "local-missing"
when = "local-only-missing"
[[rule]]
id = "blueprint"
when = "any"
paths = ["bp/**/*.gl"]
`;

describe("规则文件解析", () => {
  const rules = parseSvnRules(RULES, "t.toml");

  it("类别取最长前缀，按路径段边界匹配", () => {
    const nested = parseSvnRules('version = 1\n[categories]\nart = ["a/"]\nsrc = ["a/code"]\n');
    expect(categoryOf(nested, "a/code/x.cpp")?.name).toBe("src");
    expect(categoryOf(nested, "a/codex.cpp")?.name).toBe("art");
    expect(categoryOf(rules, "X86_64/GameCore.stable")?.name).toBe("generated");
    expect(categoryOf(rules, "X86_64/GameCore.stable.meta")).toBeUndefined();
    expect(categoryOf(rules, "gen")?.name).toBe("generated");
    expect(categoryOf(rules, "general/x")).toBeUndefined();
  });

  it("可选类别要显式开启，开启非可选类别报错", () => {
    expect([...discardSet(rules, [])]).toEqual(["generated"]);
    expect([...discardSet(rules, ["art"])].sort()).toEqual(["art", "generated"]);
    expect(() => discardSet(rules, ["generated"])).toThrow(/已总是丢弃/);
    expect(() => discardSet(rules, ["src"])).toThrow(/可选：art/);
  });

  it("glob：* 不跨目录，** 跨目录，不含 / 的模式只看文件名", () => {
    expect(globToRegExp("a/*.meta").test("a/x.meta")).toBe(true);
    expect(globToRegExp("a/*.meta").test("a/b/x.meta")).toBe(false);
    expect(globToRegExp("a/**/x.meta").test("a/b/c/x.meta")).toBe(true);
    expect(globToRegExp("a/**/x.meta").test("a/x.meta")).toBe(true);
    const meta = rules.rules.find((r) => r.id === "unity-meta-guid")!;
    expect(ruleMatchesPath(meta, "Assets/deep/a.png.meta")).toBe(true);
    expect(ruleMatchesPath(meta, "Assets/a.png")).toBe(false);
    expect(ruleMatchesPath(rules.rules[0], "any/path")).toBe(true);
  });

  it("YAML 只差指定顶层键：换行、BOM、末尾空行不算差异；缩进的同名键和二进制不算", () => {
    const keys = ["guid", "timeCreated"];
    expect(sameExceptTopLevelKeys("a: 1\nguid: x\ntimeCreated: 1\n", "\uFEFFa: 1\r\nguid: y\r\ntimeCreated: 2\r\n\r\n", keys)).toBe(true);
    expect(sameExceptTopLevelKeys("a: 1\nguid: x\n", "a: 2\nguid: y\n", keys)).toBe(false);
    expect(sameExceptTopLevelKeys("m:\n  guid: x\n", "m:\n  guid: y\n", keys)).toBe(false);
    expect(sameExceptTopLevelKeys("a\u0000", "a\u0000", keys)).toBe(false);
  });

  it.each([
    ["version = 2", /version 必须为 1/],
    ['version = 1\nhooks = 1', /未知字段 hooks/],
    ['version = 1\n[categories]\na = ["../x"]', /非法路径/],
    ['version = 1\n[categories]\na = ["C:/x"]', /非法路径/],
    ['version = 1\n[categories]\na = ["x"]\nb = ["x/"]', /同时出现在类别 a 和 b/],
    ['version = 1\n[discard]\nalways = ["nope"]', /未定义的类别 nope/],
    ['version = 1\n[categories]\na = ["x"]\n[discard]\nalways = ["a"]\noptional = ["a"]', /不能同时/],
    ['version = 1\n[[rule]]\nid = "r"\nwhen = "magic"', /when 只能是/],
    ['version = 1\n[[rule]]\nid = "r"\nwhen = "yaml-keys-only"', /必须给 keys/],
    ['version = 1\n[[rule]]\nid = "r"\nwhen = "any"', /必须给 paths/],
    ['version = 1\n[[rule]]\nid = "r"\nwhen = "local-equals-incoming"\nkeys = ["guid"]', /只有 yaml-keys-only/],
    ['version = 1\n[[rule]]\nid = "r"\nwhen = "local-only-missing"\n[[rule]]\nid = "r"\nwhen = "local-only-missing"', /重复/],
    ["version = 1\n[categories", /TOML 语法错误/],
  ])("拒绝错误规则 %s", (text, pattern) => expect(() => parseSvnRules(text, "t.toml")).toThrow(pattern));
});

describe("svn 输出解析", () => {
  it("update 输出四列状态里任一列是 C 都算冲突", () => {
    const out = [
      "Updating '.':",
      "C    gen/a.bin",
      " C   props.txt",
      "   C tree/dir",
      "U    clean.cpp",
      "G    merged.cpp",
      "A  C added-tree.txt",
      "Updated to revision 3.",
      "Summary of conflicts:",
      "  Text conflicts: 1",
    ].join("\n");
    expect(conflictedRelativesFromUpdateOutput(out)).toEqual(["gen/a.bin", "props.txt", "tree/dir", "added-tree.txt"]);
  });

  it("info --xml：文本、属性、树冲突与远端一侧版本", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<info>
<entry kind="file" path="D:/wc/gen/a&amp;b.bin" revision="3">
<wc-info>
<conflict type="text" operation="update">
<version side="source-left" kind="file" path-in-repos="branches/b1/gen/a&amp;b.bin" repos-url="file:///D:/repo" revision="1"/>
<version side="source-right" kind="file" path-in-repos="branches/b1/gen/a&amp;b.bin" repos-url="file:///D:/repo" revision="3"/>
<prev-base-file>D:/wc/gen/a&amp;b.bin.r1</prev-base-file>
<prev-wc-file>D:/wc/gen/a&amp;b.bin.mine</prev-wc-file>
<cur-base-file>D:/wc/gen/a&amp;b.bin.r3</cur-base-file>
</conflict>
<conflict type="property" operation="update">
<prop-file>D:/wc/gen/a&amp;b.bin.prej</prop-file>
</conflict>
</wc-info>
</entry>
<entry kind="file" path="D:/wc/new.txt" revision="3">
<wc-info>
<tree-conflict victim="new.txt" kind="file" operation="update" action="add" reason="unversioned">
<version side="source-left" kind="none" path-in-repos="branches/b1/new.txt" repos-url="file:///D:/repo" revision="2"/>
<version side="source-right" kind="file" path-in-repos="branches/b1/new.txt" repos-url="file:///D:/repo" revision="3"/>
</tree-conflict>
</wc-info>
</entry>
</info>`;
    const infos = parseConflictInfo(xml);
    expect(infos.get("D:/wc/gen/a&b.bin")).toMatchObject({
      text: { mine: "D:/wc/gen/a&b.bin.mine", theirs: "D:/wc/gen/a&b.bin.r3", older: "D:/wc/gen/a&b.bin.r1" },
      propFile: "D:/wc/gen/a&b.bin.prej",
      right: { kind: "file", pathInRepos: "branches/b1/gen/a&b.bin", revision: 3 },
    });
    expect(infos.get("D:/wc/new.txt")).toMatchObject({
      tree: { action: "add", reason: "unversioned", operation: "update", kind: "file" },
      right: { kind: "file", pathInRepos: "branches/b1/new.txt", reposUrl: "file:///D:/repo", revision: 3 },
    });
  });

  it("本地路径含 @ 时补 peg", () => {
    expect(peg("D:/wc/icon@2x.png")).toBe("D:/wc/icon@2x.png@");
    expect(peg("D:/wc/icon.png")).toBe("D:/wc/icon.png");
  });
});

const absRules = path.join(os.tmpdir(), "svn-rules.toml");
const baseConfig = `maxSlots = 1\nsvnRoot = "file:///test"\n[storage]\nroots = [${JSON.stringify(path.join(os.tmpdir(), "wcp-rules-store"))}]\n`;
describe("池配置 [svnRules]", () => {
  it("没有配置保持旧结构", () => expect(parseConfig(baseConfig).svnRules).toBeUndefined());
  it("解析 file 与 enable，enable 去重", () => {
    expect(parseConfig(`${baseConfig}[svnRules]\nfile = ${JSON.stringify(absRules)}\nenable = ["art", "art"]\n`).svnRules)
      .toEqual({ file: path.normalize(absRules), enable: ["art"] });
  });
  it.each([
    ['[hooks]\nbeforeUpdate = ["python"]', /已移除：改用 \[svnRules\]/],
    ['[svnRules]\nfile = "rules/svn-rules.toml"\nenable = []', /绝对路径/],
    [`[svnRules]\nfile = ${JSON.stringify(absRules)}\nenable = ["bad name"]`, /类别名不合法/],
    [`[svnRules]\nfile = ${JSON.stringify(absRules)}\nenable = []\nretry = true`, /未知字段|retry/],
  ])("拒绝错误配置 %s", (body, pattern) => expect(() => parseConfig(`${baseConfig}${body}\n`)).toThrow(pattern));
});

const hasSvn = ["svn", "svnadmin"].every((cmd) => spawnSync(cmd, ["--version", "--quiet"]).status === 0);
/** 文件系统是否不区分大小写（Windows、默认 macOS）：只有这样仓库里只差大小写的两个文件才会撞名。 */
const caseInsensitiveFs = ((): boolean => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wcp-case-"));
  try {
    writeFileSync(path.join(dir, "Probe"), "");
    return existsSync(path.join(dir, "probe"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
function sh(command: string, args: string[]): string {
  const r = spawnSync(command, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const META_BASE = "fileFormatVersion: 2\nguid: aaa\ntimeCreated: 1\nlicenseType: Free\n";

describe.skipIf(!hasSvn)("按规则处理冲突（真实 SVN）", () => {
  let base: string;
  let root: string;
  let store: string;
  let wc: string;
  let url: string;
  let rulesFile: string;
  let ctx: ToolRunContext;
  let writers = 0;

  const config = (enable: string[] | undefined): void => {
    writeFileSync(path.join(root, "pool.toml"), [
      "maxSlots = 1", `svnRoot = ${JSON.stringify(url)}`, 'projects = ["b1"]',
      ...(enable ? ["[svnRules]", `file = ${JSON.stringify(rulesFile)}`, `enable = ${JSON.stringify(enable)}`] : []),
      "[storage]", `roots = [${JSON.stringify(store)}]`,
    ].join("\n"));
  };
  const refresh = (): Promise<{ code: number; detail: string }> => run("refresh", {}, ctx) as Promise<{ code: number; detail: string }>;
  const gc = (): Promise<{ code: number; detail: string }> => run("gc", {}, ctx) as Promise<{ code: number; detail: string }>;
  const state = () => readState(poolPaths(root)).slots[0];
  const file = (rel: string): string => path.join(wc, ...rel.split("/"));
  const read = (rel: string): string => readFileSync(file(rel), "utf8");
  const status = (rel = "."): string => sh("svn", ["status", "--xml", peg(rel === "." ? wc : file(rel))]);
  /** svn status 的非空行（含未纳管文件，能看出 .mine/.rN 遗留）。 */
  const dirty = (): string[] => sh("svn", ["status", wc]).split(/\r?\n/).filter((l) => l.trim());
  const remote = (edit: (dir: string) => void): void => {
    const dir = path.join(base, `writer-${writers++}`);
    sh("svn", ["checkout", `${url}/branches/b1`, dir]);
    edit(dir);
    sh("svn", ["commit", dir, "-m", "remote"]);
  };
  const textConflict = (rel: string, local: string | Buffer, incoming: string | Buffer): void => {
    writeFileSync(file(rel), local);
    remote((dir) => writeFileSync(path.join(dir, ...rel.split("/")), incoming));
    sh("svn", ["update", wc, "--accept", "postpone"]);
    expect(status(rel)).toContain('item="conflicted"');
  };
  const archives = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (name === "rules.json") out.push(dir);
        else if (statSync(p).isDirectory()) walk(p);
      }
    };
    walk(path.join(root, "patches"));
    return out;
  };

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wcp-rules-")));
    const repo = path.join(base, "repo");
    sh("svnadmin", ["create", repo]);
    url = pathToFileURL(repo).href;
    const seed = path.join(base, "seed");
    const b1 = path.join(seed, "branches/b1");
    for (const dir of ["gen", "src", "art", "Assets", "bp/v2"]) mkdirSync(path.join(b1, dir), { recursive: true });
    mkdirSync(path.join(seed, "branches/b2/gen"), { recursive: true });
    for (const rel of ["gen/out.bin", "src/source.cpp", "src/gone.cpp", "art/tex.txt", "art/icon@2x.txt", "bp/v2/a.gl"]) writeFileSync(path.join(b1, rel), "base\n");
    writeFileSync(path.join(b1, "Assets/a.meta"), META_BASE);
    writeFileSync(path.join(seed, "branches/b2/gen/out.bin"), "b2\n");
    sh("svn", ["import", seed, url, "-m", "seed"]);
    root = path.join(base, "pool");
    store = path.join(base, "store");
    mkdirSync(root);
    mkdirSync(store);
    rulesFile = path.join(base, "svn-rules.toml");
    writeFileSync(rulesFile, RULES.replace('generated = ["gen/", "X86_64/GameCore.stable"]', 'generated = ["gen/"]'));
    ctx = { cwd: root, workspacePath: root, logFile: path.join(base, "pool.log"), timeoutMs: 60_000, abortSignal: new AbortController().signal };
    config(undefined);
    await run("acquire", { branch: "b1" }, ctx);
    await run("release", { branch: "b1" }, ctx);
    wc = path.join(store, "s01");
    config([]);
  }, 60_000);

  afterEach(() => { if (base) rmSync(base, { recursive: true, force: true }); });

  it("生成物冲突取远端，源码改动保留，处理明细写进存档", async () => {
    textConflict("gen/out.bin", "local\n", "remote\n");
    writeFileSync(file("src/source.cpp"), "user source\n");
    const result = await refresh();
    expect(result.code).toBe(0);
    expect(result.detail).toContain("规则处理");
    expect(read("gen/out.bin")).toBe("remote\n");
    expect(read("src/source.cpp")).toBe("user source\n");
    expect(dirty()).toEqual([expect.stringMatching(/^M\s+.*source\.cpp$/)]);
    expect(state()).toMatchObject({ phase: "ready" });
    expect(state().op).toBeUndefined();
    const [dir] = archives();
    const runs = JSON.parse(readFileSync(path.join(dir, "rules.json"), "utf8")) as { entries: { path: string; action: string; rule: string }[] }[];
    expect(runs.flatMap((r) => r.entries)).toContainEqual(expect.objectContaining({ path: "gen/out.bin", action: "theirs", rule: "discard:generated" }));
    // generated 是总是丢弃的可再生内容：只记清单，不拷内容
    expect(existsSync(path.join(dir, "files", "gen", "out.bin"))).toBe(false);
  }, 120_000);

  it("美术冲突未开启时阻塞；开启后取远端，本地版本进存档可恢复", async () => {
    remote((dir) => sh("svn", ["propset", "svn:mime-type", "application/octet-stream", path.join(dir, "art", "tex.txt")]));
    sh("svn", ["update", wc]);
    textConflict("art/tex.txt", "local art\n", "remote art\n");
    const blocked = await refresh();
    expect(blocked.code).not.toBe(0);
    expect(blocked.detail).toContain("类别 art 未开启丢弃");
    expect(state().phase).toBe("blocked");
    expect(state().blockedReason).toContain("art/tex.txt");
    expect(read("art/tex.txt")).toBe("local art\n");

    config(["art"]);
    const result = await refresh();
    expect(result.code).toBe(0);
    expect(read("art/tex.txt")).toBe("remote art\n");
    expect(dirty()).toEqual([]);
    expect(state().phase).toBe("ready");
    expect(state().blockedReason).toBeUndefined();
    const [dir] = archives();
    expect(readFileSync(path.join(dir, "files", "art", "tex.txt"), "utf8")).toBe("local art\n");
    expect(readFileSync(path.join(dir, "versioned.txt"), "utf8")).toContain("theirs");
  }, 120_000);

  it("文件名含 @ 也能取远端", async () => {
    config(["art"]);
    textConflict("art/icon@2x.txt", "local\n", "remote\n");
    expect((await refresh()).code).toBe(0);
    expect(read("art/icon@2x.txt")).toBe("remote\n");
    expect(dirty()).toEqual([]);
  }, 120_000);

  it("远端新增撞上内容相同的未纳管文件：按 identical 取远端", async () => {
    writeFileSync(file("src/new.txt"), "same\n");
    remote((dir) => {
      writeFileSync(path.join(dir, "src", "new.txt"), "same\n");
      sh("svn", ["add", path.join(dir, "src", "new.txt")]);
    });
    sh("svn", ["update", wc, "--accept", "postpone"]);
    expect(status("src/new.txt")).toContain('tree-conflicted="true"');
    expect((await refresh()).code).toBe(0);
    expect(read("src/new.txt")).toBe("same\n");
    expect(dirty()).toEqual([]);
  }, 120_000);

  it(".meta 只差 guid / timeCreated：按 unity-meta-guid 取远端；还差别的键就阻塞", async () => {
    const meta = (guid: string, t: number, license = "Free"): string => `fileFormatVersion: 2\nguid: ${guid}\ntimeCreated: ${t}\nlicenseType: ${license}\n`;
    textConflict("Assets/a.meta", meta("bbb", 2), meta("ccc", 3));
    expect((await refresh()).code).toBe(0);
    expect(read("Assets/a.meta")).toBe(meta("ccc", 3));
    expect(dirty()).toEqual([]);

    textConflict("Assets/a.meta", meta("ddd", 4, "Pro"), meta("eee", 5));
    const blocked = await refresh();
    expect(blocked.code).not.toBe(0);
    expect(blocked.detail).toContain("Assets/a.meta");
    expect(state().phase).toBe("blocked");
  }, 120_000);

  it("蓝图按 any 规则：冲突先存档本地版本再取远端", async () => {
    textConflict("bp/v2/a.gl", "local bp\n", "remote bp\n");
    const result = await refresh();
    expect(result.code).toBe(0);
    expect(read("bp/v2/a.gl")).toBe("remote bp\n");
    expect(dirty()).toEqual([]);
    const [dir] = archives();
    expect(readFileSync(path.join(dir, "files", "bp", "v2", "a.gl"), "utf8")).toBe("local bp\n");
    const runs = JSON.parse(readFileSync(path.join(dir, "rules.json"), "utf8")) as { entries: { path: string; action: string; rule: string }[] }[];
    expect(runs.flatMap((r) => r.entries)).toContainEqual(expect.objectContaining({ path: "bp/v2/a.gl", action: "theirs", rule: "blueprint" }));
  }, 120_000);

  it("本地已删、远端修改：本地没有内容可丢，按 local-missing 取远端", async () => {
    sh("svn", ["rm", file("src/gone.cpp")]);
    remote((dir) => writeFileSync(path.join(dir, "src", "gone.cpp"), "remote edit\n"));
    sh("svn", ["update", wc, "--accept", "postpone"]);
    expect(status("src/gone.cpp")).toContain('tree-conflicted="true"');
    expect((await refresh()).code).toBe(0);
    expect(read("src/gone.cpp")).toBe("remote edit\n");
    expect(dirty()).toEqual([]);
  }, 120_000);

  it("源码冲突保持阻塞，不动源码", async () => {
    textConflict("src/source.cpp", "local\n", "remote\n");
    const before = readFileSync(file("src/source.cpp"));
    const result = await refresh();
    expect(result.code).not.toBe(0);
    expect(result.detail).toContain("需要人工处理");
    expect(result.detail).toContain("不属于可丢弃类别");
    expect(readFileSync(file("src/source.cpp"))).toEqual(before);
    expect(status("src/source.cpp")).toContain('item="conflicted"');
    expect(state().phase).toBe("blocked");
    expect(state().op).toBeUndefined();
    // 只有阻塞、没有动作时不建存档目录
    expect(archives()).toEqual([]);
  }, 120_000);

  it("可丢弃类别被 switch 到别的 URL：切回工作副本根对应的 URL", async () => {
    sh("svn", ["switch", "--ignore-ancestry", `${url}/branches/b2/gen`, file("gen")]);
    expect(read("gen/out.bin")).toBe("b2\n");
    expect((await refresh()).code).toBe(0);
    expect(sh("svn", ["info", "--show-item", "url", file("gen")]).trim()).toBe(`${url}/branches/b1/gen`);
    expect(read("gen/out.bin")).toBe("base\n");
  }, 120_000);

  it("租约有效、受保护或所有权未确认的槽位不碰", async () => {
    textConflict("gen/out.bin", "local\n", "remote\n");
    const untouched = async (): Promise<void> => {
      const result = await refresh();
      expect(result.detail).toContain("跳过");
      expect(status("gen/out.bin")).toContain('item="conflicted"');
    };
    await mutate(poolPaths(root), (s) => { s.slots[0].lease = { until: "forever" }; });
    await untouched();
    await mutate(poolPaths(root), (s) => { s.slots[0].lease = null; s.slots[0].holds = { ide: { at: new Date().toISOString(), path: wc } }; });
    await untouched();
    await mutate(poolPaths(root), (s) => { s.slots[0].holds = undefined; s.slots[0].ownershipUnconfirmed = true; });
    await untouched();
    expect(state().op).toBeUndefined();
  }, 120_000);

  it("gc 复查按规则处理阻塞槽位并解除阻塞", async () => {
    textConflict("gen/out.bin", "local\n", "remote\n");
    await mutate(poolPaths(root), (s) => { s.slots[0].phase = "blocked"; s.slots[0].blockedReason = "generated conflict"; });
    const result = await gc();
    expect(result.code).toBe(0);
    expect(result.detail).toContain("解除阻塞");
    expect(read("gen/out.bin")).toBe("remote\n");
    expect(state().phase).toBe("ready");
    expect(state().blockedReason).toBeUndefined();
    expect(state().op).toBeUndefined();
  }, 120_000);

  it.skipIf(!caseInsensitiveFs)("仓库里只差大小写的两个文件：保留磁盘上的那个并提示，不来回覆盖", async () => {
    const content: Record<string, string> = { "Show.txt": "UPPER\n", "show.txt": "lower\n" };
    for (const [i, [name, text]] of Object.entries(content).entries()) {
      const src = path.join(base, `import-${i}`);
      writeFileSync(src, text);
      sh("svn", ["import", src, `${url}/branches/b1/art/${name}`, "-m", name]);
    }
    // 两个都拉下来后只能留一个，另一个显示缺失
    sh("svn", ["update", wc]);
    expect(dirty()).toEqual([expect.stringMatching(/^!\s+.*show\.txt$/i)]);
    config(["art"]);
    const onDisk = (): string => {
      const names = readdirSync(file("art")).filter((n) => n.toLowerCase() === "show.txt");
      expect(names).toHaveLength(1);
      return names[0];
    };

    const result = await refresh();
    expect(result.code).toBe(0);
    expect(result.detail).toContain("只差大小写");
    expect(state().phase).toBe("ready");
    const kept = onDisk();
    expect(read(`art/${kept}`)).toBe(content[kept]);

    // 之前来回覆盖留下的现场：留下的文件被写成了另一个的内容，再按整个 art/ revert 就会再覆盖一次
    const other = kept === "Show.txt" ? "show.txt" : "Show.txt";
    writeFileSync(file(`art/${kept}`), content[other]);
    await mutate(poolPaths(root), (s) => { s.slots[0].phase = "blocked"; s.slots[0].blockedReason = "case clash"; });
    const reviewed = await gc();
    expect(reviewed.code).toBe(0);
    expect(reviewed.detail).toContain("解除阻塞");
    expect(reviewed.detail).toContain("只差大小写");
    expect(onDisk()).toBe(kept);
    expect(read(`art/${kept}`)).toBe(content[kept]);
    expect(state().phase).toBe("ready");
    expect(state().op).toBeUndefined();
  }, 120_000);

  it("gc 复查处理不了的保持阻塞并更新原因", async () => {
    textConflict("src/source.cpp", "local\n", "remote\n");
    await mutate(poolPaths(root), (s) => { s.slots[0].phase = "blocked"; s.slots[0].blockedReason = "old"; });
    const result = await gc();
    expect(result.detail).toContain("仍阻塞");
    expect(state().phase).toBe("blocked");
    expect(state().blockedReason).toContain("src/source.cpp");
    expect(state().op).toBeUndefined();
  }, 120_000);

  it("规则文件写错：refresh 报错，不动工作副本", async () => {
    textConflict("gen/out.bin", "local\n", "remote\n");
    writeFileSync(rulesFile, "version = 2\n");
    const result = await refresh();
    expect(result.code).not.toBe(0);
    expect(result.detail).toContain("version 必须为 1");
    expect(status("gen/out.bin")).toContain('item="conflicted"');
    expect(state().op).toBeUndefined();
  }, 120_000);

  it("versionControl svn-update 的 onConflict=rules", async () => {
    textConflict("gen/out.bin", "local\n", "remote\n");
    const vctx: ToolRunContext = { ...ctx, cwd: wc, workspacePath: wc };
    await expect(runVersionControl("svn-update", { onConflict: "rules" }, vctx)).rejects.toThrow(/rulesFile/);
    await expect(runVersionControl("svn-update", { onConflict: "rules", rulesFile, rulesEnable: ["generated"] }, vctx)).rejects.toThrow(/已总是丢弃/);
    const backupDir = path.join(base, "vc-backup");
    const result = await runVersionControl("svn-update", { onConflict: "rules", rulesFile, rulesEnable: ["art"], backupDir }, vctx);
    expect(result.code).toBe(0);
    expect(result.detail).toContain("规则存档");
    expect(read("gen/out.bin")).toBe("remote\n");
    expect(existsSync(backupDir)).toBe(true);

    textConflict("src/source.cpp", "local\n", "remote\n");
    await expect(runVersionControl("svn-update", { onConflict: "rules", rulesFile, backupDir }, vctx)).rejects.toThrow(/需要人工处理/);
    expect(read("src/source.cpp")).not.toBe("remote\n");
  }, 120_000);
});
