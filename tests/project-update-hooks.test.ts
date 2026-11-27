import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../packs/workingCopyPool/src/config";
import { run } from "../packs/workingCopyPool/src/index";
import { mutate, poolPaths, readState } from "../packs/workingCopyPool/src/state";
import type { ToolRunContext } from "../shared/types";

const baseConfig = `maxSlots = 1\nsvnRoot = "file:///test"\n[storage]\nroots = [${JSON.stringify(path.join(os.tmpdir(), "wcp-hooks-store"))}]\n`;
describe("项目钩子配置", () => {
  it("没有 hooks 保持旧配置结构", () => expect(parseConfig(baseConfig).hooks).toBeUndefined());
  it("argv 保留重复参数，默认不重试 blocked", () => {
    expect(parseConfig(baseConfig + '[hooks]\nbeforeUpdate = ["python", "pack.py", "revert-generated", "--x", "same", "--x", "same"]\n').hooks)
      .toEqual({ beforeUpdate: ["python", "pack.py", "revert-generated", "--x", "same", "--x", "same"], retryBlocked: false });
  });
  it.each([
    ['beforeUpdate = []', /非空命令/],
    ['beforeUpdate = "echo"', /字符串数组/],
    ['beforeUpdate = ["python", ""]', /字符串数组/],
    ['retryBlocked = true', /需同时配置/],
    ['retryBlocked = "true"', /布尔值/],
    ['unknown = true', /未知字段/],
  ])("拒绝错误配置 %s", (body, pattern) => expect(() => parseConfig(baseConfig + '[hooks]\n' + body + '\n')).toThrow(pattern));
});

const hasSvn = ["svn", "svnadmin"].every((cmd) => spawnSync(cmd, ["--version", "--quiet"]).status === 0);
function sh(command: string, args: string[]): string {
  const r = spawnSync(command, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${command}: ${r.stderr}`);
  return r.stdout;
}

describe.skipIf(!hasSvn)("更新前钩子（真实 SVN）", () => {
  let base: string;
  let root: string;
  let store: string;
  let wc: string;
  let url: string;
  let hook: string;
  let ctx: ToolRunContext;
  const events = (): string => existsSync(path.join(root, "events.txt")) ? readFileSync(path.join(root, "events.txt"), "utf8") : "";
  const config = (withHook = true, retryBlocked = true): void => {
    writeFileSync(path.join(root, "pool.toml"), [
      "maxSlots = 1", `svnRoot = ${JSON.stringify(url)}`, 'projects = ["b1"]',
      ...(withHook ? ["[hooks]", `beforeUpdate = ${JSON.stringify([process.execPath, hook, root])}`, `retryBlocked = ${retryBlocked}`] : []),
      "[storage]", `roots = [${JSON.stringify(store)}]`,
    ].join("\n"));
  };
  const refresh = (): Promise<unknown> => run("refresh", {}, ctx);
  const state = () => readState(poolPaths(root)).slots[0];
  const conflict = (rel: string): void => {
    const writer = path.join(base, "writer-" + path.basename(rel));
    sh("svn", ["checkout", `${url}/branches/b1`, writer]);
    writeFileSync(path.join(wc, rel), "local\n");
    writeFileSync(path.join(writer, rel), "remote\n");
    sh("svn", ["commit", writer, "-m", "remote"]);
    sh("svn", ["update", wc, "--accept", "postpone"]);
    expect(sh("svn", ["status", "--xml", path.join(wc, rel)])).toContain('item="conflicted"');
  };

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wcp-hooks-")));
    const repo = path.join(base, "repo");
    sh("svnadmin", ["create", repo]);
    url = pathToFileURL(repo).href;
    const seed = path.join(base, "seed");
    mkdirSync(path.join(seed, "branches/b1"), { recursive: true });
    for (const rel of ["generated.bin", "source.cpp"]) writeFileSync(path.join(seed, "branches/b1", rel), "base\n");
    sh("svn", ["import", seed, url, "-m", "seed"]);
    root = path.join(base, "pool");
    store = path.join(base, "store");
    mkdirSync(root);
    mkdirSync(store);
    hook = path.join(base, "project hook.mjs");
    writeFileSync(hook, [
      'import { appendFileSync, readFileSync } from "node:fs";',
      'import path from "node:path";',
      'import { spawnSync } from "node:child_process";',
      'const root = process.argv[2];',
      'const wc = process.argv[process.argv.indexOf("--project-root") + 1];',
      'const state = JSON.parse(readFileSync(path.join(root, ".pool/state.json"), "utf8"));',
      'if (state.slots[0].op?.pid !== process.ppid) throw new Error("slot not claimed");',
      'appendFileSync(path.join(root, "events.txt"), wc + "\\n");',
      'const r = spawnSync("svn", ["revert", "--non-interactive", path.join(wc, "generated.bin")]);',
      'process.exit(r.status ?? 1);',
    ].join("\n"));
    ctx = { cwd: root, workspacePath: root, logFile: path.join(base, "pool.log"), timeoutMs: 60_000, abortSignal: new AbortController().signal };
    config(false);
    await run("acquire", { branch: "b1" }, ctx);
    await run("release", { branch: "b1" }, ctx);
    wc = path.join(store, "s01");
    config();
  }, 60_000);

  afterEach(() => { if (base) rmSync(base, { recursive: true, force: true }); });

  it("先持有槽位 op 再还原；真实生成物冲突消失，源码改动保留", async () => {
    conflict("generated.bin");
    writeFileSync(path.join(wc, "source.cpp"), "user source\n");
    const result = await refresh() as { code: number };
    expect(result.code).toBe(0);
    expect(events()).toContain(wc);
    expect(readFileSync(path.join(wc, "generated.bin"), "utf8")).toBe("remote\n");
    expect(readFileSync(path.join(wc, "source.cpp"), "utf8")).toBe("user source\n");
    expect(state().op).toBeUndefined();
  }, 60_000);

  it("默认跳过 blocked；显式重试且全部成功才清除阻塞", async () => {
    conflict("generated.bin");
    await mutate(poolPaths(root), (s) => { s.slots[0].phase = "blocked"; s.slots[0].blockedReason = "generated conflict"; });
    config(true, false);
    await refresh();
    expect(events()).toBe("");
    expect(state().phase).toBe("blocked");
    config();
    await refresh();
    expect(state().phase).toBe("ready");
    expect(state().blockedReason).toBeUndefined();
  }, 60_000);

  it("源码冲突仍阻塞，钩子不会自动还原源码", async () => {
    conflict("source.cpp");
    await mutate(poolPaths(root), (s) => { s.slots[0].phase = "blocked"; s.slots[0].blockedReason = "source conflict"; });
    const before = readFileSync(path.join(wc, "source.cpp"));
    const result = await refresh() as { code: number; detail: string };
    expect(result.code).not.toBe(0);
    expect(result.detail).toContain("仍有需要人工处理的问题");
    expect(readFileSync(path.join(wc, "source.cpp"))).toEqual(before);
    expect(state().phase).toBe("blocked");
    expect(state().op).toBeUndefined();
  }, 60_000);

  it("租约有效或所有权未确认不会运行钩子", async () => {
    await mutate(poolPaths(root), (s) => { s.slots[0].lease = { until: "forever" }; });
    await refresh();
    expect(events()).toBe("");
    await mutate(poolPaths(root), (s) => { s.slots[0].lease = null; s.slots[0].ownershipUnconfirmed = true; });
    await refresh();
    expect(events()).toBe("");
  }, 60_000);

  it("钩子失败则不执行 update，保留本地内容", async () => {
    writeFileSync(hook, "process.exit(7);");
    writeFileSync(path.join(wc, "generated.bin"), "local\n");
    const result = await refresh() as { code: number; detail: string };
    expect(result.code).not.toBe(0);
    expect(result.detail).toContain("钩子失败（7）");
    expect(readFileSync(path.join(wc, "generated.bin"), "utf8")).toBe("local\n");
    expect(state().op).toBeUndefined();
  }, 60_000);

  it("取消钩子传入 stdin 取消行，并留下 op 供恢复", async () => {
    writeFileSync(hook, 'process.stdin.once("data", () => process.exit(0)); console.log(JSON.stringify({type:"progress",message:"hook-ready"}));');
    const controller = new AbortController();
    ctx.abortSignal = controller.signal;
    ctx.onProgress = (message) => { if (message === "hook-ready") controller.abort(); };
    await expect(refresh()).rejects.toThrow(/取消/);
    expect(state().op?.kind).toBe("update");
  }, 60_000);
});
