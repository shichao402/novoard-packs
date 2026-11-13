/**
 * 取消收尾（ADR-0019 §5）：
 * - stdin 取消指令 `{"type":"cancel"}` 与 SIGTERM 走同一套中止；
 * - svn 写工作副本的命令被中断后补跑 svn cleanup（用 PATH 上的假 svn 验证）。
 */
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, isCancelLine, runCli, watchCancelLine } from "../shared/cli";
import type { ToolsetManifest } from "../shared/types";
import { run as runVersionControl } from "../packs/versionControl/src/index";

describe("stdin 取消指令", () => {
  it("isCancelLine 只认 type=cancel 的 JSON 行", () => {
    expect(isCancelLine('{"type":"cancel"}')).toBe(true);
    expect(isCancelLine('  {"type":"cancel"}\r')).toBe(true);
    expect(isCancelLine('{"type":"progress"}')).toBe(false);
    expect(isCancelLine("cancel")).toBe(false);
    expect(isCancelLine("{oops")).toBe(false);
  });

  it("跨块拼行；停止后不再回调", () => {
    const input = new PassThrough();
    let hits = 0;
    const stop = watchCancelLine(input, () => { hits += 1; });
    input.write('{"type":');
    input.write('"cancel"}\n{"type":"other"}\n');
    expect(hits).toBe(1);
    stop();
    input.write('{"type":"cancel"}\n');
    expect(hits).toBe(1);
  });

  it("runCli：stdin 写入取消指令 → 工具收到中止，写「已取消」并退出 130，监听被清理", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "novoard-packs-cancel-"));
    const manifest: ToolsetManifest = {
      id: "fake", displayName: "fake", schemaVersion: 1, runtime: "node", entry: "dist/pack.mjs",
      tools: [{ id: "t", displayName: "T" }],
    };
    const stdin = new PassThrough();
    const resultFile = path.join(dir, "r.json");
    try {
      const pending = runCli(
        manifest,
        (_id, _p, ctx) => new Promise((_, reject) => ctx.abortSignal.addEventListener("abort", () => reject(new Error("已取消")))),
        ["t", "--project-root", dir, "--result-json", resultFile],
        { out: () => {}, err: () => {}, signals: new EventEmitter(), stdin, logDir: dir },
      );
      await new Promise((r) => setTimeout(r, 10));
      stdin.write('{"type":"cancel"}\n');
      expect(await pending).toBe(EXIT.INTERRUPTED);
      expect(JSON.parse(readFileSync(resultFile, "utf8"))).toEqual({ detail: "已取消" });
      expect(stdin.listenerCount("data")).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("svn 中断后 cleanup（假 svn）", () => {
  let dir: string;
  let marker: string;
  const savedPath = process.env.PATH;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "novoard-packs-svn-"));
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    mkdirSync(path.join(dir, "wc", ".svn"), { recursive: true });
    marker = path.join(dir, "cleanup.log");
    // switch 挂住等被结束；cleanup 记一笔
    writeFileSync(
      path.join(bin, "svn"),
      `#!/bin/sh\nif [ "$1" = "cleanup" ]; then echo "$@" >> "${marker}"; exit 0; fi\nexec sleep 30\n`,
    );
    chmodSync(path.join(bin, "svn"), 0o755);
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });

  function ctx(controller: AbortController) {
    const wc = path.join(dir, "wc");
    return {
      cwd: wc, workspacePath: wc, timeoutMs: 60_000, logFile: path.join(dir, "t.log"),
      abortSignal: controller.signal, dryRun: false, localDate: "2026-11-13",
    };
  }

  it("svn-switch 被取消：结束 svn 后补跑 cleanup，错误带说明", async () => {
    const controller = new AbortController();
    const pending = runVersionControl("svn-switch", { url: "https://example.invalid/trunk" }, ctx(controller));
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    await expect(pending).rejects.toThrow("已取消（已 svn cleanup）");
    expect(readFileSync(marker, "utf8")).toMatch(/^cleanup --non-interactive/);
  });

  it("svn-copy（URL 对 URL）被取消：不 cleanup", async () => {
    const controller = new AbortController();
    const pending = runVersionControl(
      "svn-copy",
      { source: "https://example.invalid/a", destination: "https://example.invalid/b", message: "m" },
      ctx(controller),
    );
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    await expect(pending).rejects.toThrow(/^已取消$/);
    expect(existsSync(marker)).toBe(false);
  });
});
