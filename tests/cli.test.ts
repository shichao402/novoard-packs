/**
 * P4 统一 CLI 与 P5 进度（ADR-0019 §2–5）。
 * - argv 与 novoard-agent `paramsToArgv` 互逆（这里内联一份同语义实现做往返）；
 * - 退出码 0/1/64/99/130 与 --result-json；
 * - 每个工具都用打包产物 dist/pack.mjs 以 --dry-run 跑一次（agent 夹具式调用形状）；
 * - svn update 文件行计数、Unity DisplayProgressbar 百分比。
 */
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT, parseArgv, runCli, UsageError } from "../shared/cli";
import type { ToolManifest, ToolParamSpec, ToolsetManifest } from "../shared/types";
import { validateToolParams } from "../shared/validate";
import { manifest as generalManifest } from "../packs/general/src/manifest";
import { manifest as vcManifest } from "../packs/versionControl/src/manifest";
import { createUpdateProgress, isSvnUpdateItemLine } from "../packs/versionControl/src/svn-status";
import { followUnityLog, unityProgressPercent } from "../packs/general/src/unity";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 与 novoard-agent src/packs/validate.mjs paramsToArgv 同语义。 */
function paramsToArgv(params: Record<string, unknown>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    const flag = `--${key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`;
    if (typeof value === "boolean") {
      args.push(value ? flag : `${flag}=false`);
    } else if (Array.isArray(value)) {
      for (const item of value) args.push(flag, String(item));
    } else if (value !== null && value !== undefined) {
      args.push(flag, String(value));
    }
  }
  return args;
}

function sample(spec: ToolParamSpec): unknown {
  switch (spec.type) {
    case "enum":
      return spec.enum?.[spec.enum.length - 1];
    case "number":
      return 3;
    case "boolean":
      return false;
    case "string[]":
      return ["a b", "c"];
    default:
      return "value with space";
  }
}

function sampleParams(tool: ToolManifest): Record<string, unknown> {
  return Object.fromEntries((tool.params ?? []).map((spec) => [spec.name, sample(spec)]));
}

const packs: Array<[string, ToolsetManifest]> = [
  ["versionControl", vcManifest],
  ["general", generalManifest],
];

describe("parseArgv", () => {
  for (const [, manifest] of packs) {
    for (const tool of manifest.tools) {
      it(`${manifest.id}/${tool.id}：agent 生成的 argv 往返一致`, () => {
        const params = sampleParams(tool);
        const expected = validateToolParams(tool, params);
        expect(expected.errors).toEqual([]);
        const argv = [tool.id, "--project-root", "/tmp/proj", ...paramsToArgv(expected.params), "--result-json", "/tmp/r.json", "--dry-run"];
        const parsed = parseArgv(manifest, argv);
        expect(parsed.params).toEqual(params);
        expect(parsed.projectRoot).toBe(path.resolve("/tmp/proj"));
        expect(parsed.resultJson).toBe("/tmp/r.json");
        expect(parsed.dryRun).toBe(true);
      });
    }
  }

  it("参数错误都抛 UsageError", () => {
    const bad = [
      [],
      ["--project-root", "."],
      ["no-such-tool", "--project-root", "."],
      ["svn-update"],
      ["svn-update", "--project-root", ".", "--strategy", "nope"],
      ["svn-update", "--project-root", ".", "--bogus", "1"],
      ["svn-update", "--project-root", ".", "--release-occupants=maybe"],
      ["svn-update", "--project-root", ".", "stray"],
      ["svn-switch", "--project-root", ".", "--url"],
    ];
    for (const argv of bad) {
      expect(() => parseArgv(vcManifest, argv), argv.join(" ")).toThrow(UsageError);
    }
  });
});

describe("runCli", () => {
  const manifest: ToolsetManifest = {
    id: "fake",
    displayName: "fake",
    schemaVersion: 1,
    runtime: "node",
    entry: "dist/pack.mjs",
    tools: [{ id: "t", displayName: "T", params: [{ name: "mode", type: "string" }] }],
  };

  function harness() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "novoard-packs-cli-"));
    const out: string[] = [];
    const err: string[] = [];
    const signals = new EventEmitter();
    const resultFile = path.join(dir, "r.json");
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), signals, logDir: dir };
    const result = () => (existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : null);
    return { dir, out, err, signals, resultFile, io, result, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("成功：退出 0，结果文件带 detail/skipped，进度输出 JSON 帧", async () => {
    const h = harness();
    try {
      const code = await runCli(
        manifest,
        async (_id, params, ctx) => {
          ctx.onProgress?.("一半", 50);
          ctx.onProgress?.("阶段");
          return { detail: `ok ${String(params?.mode)}`, code: 0, skipped: true };
        },
        ["t", "--project-root", h.dir, "--mode", "x", "--result-json", h.resultFile],
        h.io,
      );
      expect(code).toBe(EXIT.OK);
      expect(h.result()).toEqual({ detail: "ok x", skipped: true });
      const frames = h.out.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
      expect(frames).toEqual([
        { type: "progress", message: "一半", percent: 50 },
        { type: "progress", message: "阶段" },
      ]);
    } finally {
      h.cleanup();
    }
  });

  it("工具失败退出 1，程序缺陷退出 99，参数错退出 64，原因都写进结果文件", async () => {
    const h = harness();
    try {
      const argv = ["t", "--project-root", h.dir, "--result-json", h.resultFile];
      expect(await runCli(manifest, async () => { throw new Error("svn 挂了"); }, argv, h.io)).toBe(EXIT.FAIL);
      expect(h.result()).toEqual({ detail: "svn 挂了" });
      expect(await runCli(manifest, async () => ({ detail: "退出码 2", code: 2 }), argv, h.io)).toBe(EXIT.FAIL);
      expect(h.result()).toEqual({ detail: "退出码 2" });
      expect(await runCli(manifest, async () => { throw new TypeError("x is undefined"); }, argv, h.io)).toBe(EXIT.UNEXPECTED);
      expect(h.result()).toEqual({ detail: "x is undefined" });
      expect(await runCli(manifest, async () => ({ detail: "", code: 0 }), [...argv, "--nope", "1"], h.io)).toBe(EXIT.USAGE);
      expect(h.result().detail).toMatch(/没有参数 --nope/);
    } finally {
      h.cleanup();
    }
  });

  it("SIGTERM：中止信号传给工具，写「已取消」并退出 130", async () => {
    const h = harness();
    try {
      let sawAbort = false;
      const pending = runCli(
        manifest,
        (_id, _p, ctx) =>
          new Promise((_, reject) => {
            ctx.abortSignal.addEventListener("abort", () => {
              sawAbort = true;
              reject(new Error("已取消"));
            });
          }),
        ["t", "--project-root", h.dir, "--result-json", h.resultFile],
        h.io,
      );
      await new Promise((r) => setTimeout(r, 10));
      h.signals.emit("SIGTERM");
      expect(await pending).toBe(EXIT.INTERRUPTED);
      expect(sawAbort).toBe(true);
      expect(h.result()).toEqual({ detail: "已取消" });
      expect(h.signals.listenerCount("SIGTERM")).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});

describe("dist/pack.mjs：每个工具按 agent 调用形状跑一次（--dry-run）", () => {
  for (const [id, manifest] of packs) {
    const entry = path.join(root, "packs", id, "dist", "pack.mjs");
    for (const tool of manifest.tools) {
      it(`${id}/${tool.id}`, () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "novoard-packs-dist-"));
        try {
          const resultFile = path.join(dir, "r.json");
          const params = validateToolParams(tool, sampleParams(tool)).params;
          const args = [entry, tool.id, "--project-root", dir, ...paramsToArgv(params), "--result-json", resultFile, "--dry-run"];
          const r = spawnSync(process.execPath, args, { cwd: path.dirname(path.dirname(entry)), encoding: "utf8", timeout: 20_000 });
          const supported = !tool.platforms || tool.platforms.includes(process.platform as "win32" | "darwin" | "linux");
          const result = JSON.parse(readFileSync(resultFile, "utf8"));
          if (supported) {
            expect(r.status, r.stderr).toBe(EXIT.OK);
            expect(result.detail).toMatch(/^dry-run: /);
          } else {
            expect(r.status).toBe(EXIT.FAIL);
            expect(result.detail).toMatch(/不支持当前平台/);
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }

  it("参数错误在真实进程里退出 64", () => {
    const entry = path.join(root, "packs", "versionControl", "dist", "pack.mjs");
    const r = spawnSync(process.execPath, [entry, "svn-update", "--project-root", ".", "--strategy", "nope"], { encoding: "utf8" });
    expect(r.status).toBe(EXIT.USAGE);
    expect(r.stderr).toMatch(/strategy 必须是/);
  });
});

describe("P5 进度", () => {
  it("svn update 条目行识别", () => {
    expect(isSvnUpdateItemLine("U    Assets/a.cs")).toBe(true);
    expect(isSvnUpdateItemLine("A    Assets/new dir/b.png")).toBe(true);
    expect(isSvnUpdateItemLine(" U   Assets/prop-only")).toBe(true);
    expect(isSvnUpdateItemLine("   C Assets/tree-conflict")).toBe(true);
    expect(isSvnUpdateItemLine("Updating '.':")).toBe(false);
    expect(isSvnUpdateItemLine("Updated to revision 1234.")).toBe(false);
    expect(isSvnUpdateItemLine("At revision 1234.")).toBe(false);
    expect(isSvnUpdateItemLine("Summary of conflicts:")).toBe(false);
    expect(isSvnUpdateItemLine("     Assets/blank-status")).toBe(false);
  });

  it("svn update 计数：按间隔节流，有总数时给百分比并封顶 99，完成报 100", () => {
    let t = 0;
    const frames: Array<[string, number | null | undefined]> = [];
    const p = createUpdateProgress({ total: 4, emit: (m, pct) => frames.push([m, pct]), intervalMs: 1000, now: () => t });
    p.line("Updating '.':");
    p.line("U    a");
    t = 500;
    p.line("U    b");
    t = 1500;
    p.line("A    c");
    p.line("A    d");
    t = 3000;
    p.line("A    e");
    p.finish();
    expect(p.count()).toBe(5);
    expect(frames).toEqual([
      ["更新文件 1/4", 25],
      ["更新文件 3/4", 75],
      ["更新文件 5/4", 99],
      ["更新完成，共 5 个条目", 100],
    ]);

    const noTotal: Array<[string, number | null | undefined]> = [];
    const q = createUpdateProgress({ total: 0, emit: (m, pct) => noTotal.push([m, pct]), now: () => 0 });
    q.line("U    a");
    expect(noTotal).toEqual([["更新文件 1", null]]);
  });

  it("Unity DisplayProgressbar 百分比", () => {
    expect(unityProgressPercent("DisplayProgressbar: Importing (37%)")).toBe(37);
    expect(unityProgressPercent("DisplayProgressbar: Compiling 12.8 %")).toBe(12);
    expect(unityProgressPercent("DisplayProgressbar: Hold on")).toBeNull();
    expect(unityProgressPercent("Loaded 50% of something")).toBeNull();
  });

  it("followUnityLog 心跳带上本次采样里最新的百分比", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "novoard-packs-unitypct-"));
    try {
      const logFile = path.join(dir, "unity.log");
      const beats: Array<[string, number | null | undefined]> = [];
      const tailer = followUnityLog(logFile, (line, pct) => beats.push([line, pct]));
      writeFileSync(logFile, "DisplayProgressbar: Importing (10%)\nStart importing Assets/a.png\nDisplayProgressbar: Importing (42%)\nStart importing Assets/b.png\n", "utf8");
      tailer.tickForTest();
      writeFileSync(logFile, "Refreshing native plugins\n", { flag: "a" });
      tailer.tickForTest();
      tailer.stop();
      expect(beats).toEqual([
        ["Start importing Assets/b.png", 42],
        ["Refreshing native plugins", null],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
