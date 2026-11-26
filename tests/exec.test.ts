import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OUTPUT_TAIL_CHARS, runCommand, spawnCaptured } from "../shared/exec";

/** 子进程先输出 START，再输出 size 个 x，最后输出 END。 */
const bigOutput = (size: number): string[] => ["-e", `process.stdout.write('START' + 'x'.repeat(${size}) + 'END')`];

/** 子进程把「中文」的 UTF-8 字节拆成两次写出，制造跨 chunk 的多字节字符。 */
const splitUtf8 = ["-e", "const b = Buffer.from('中文\\n'); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 80)"];

function logFile(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), "exec-test-")), "run.log");
}

describe("spawnCaptured", () => {
  it("captures stdout without blocking the event loop", async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 20);
    const result = await spawnCaptured({
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.stdout.write('hello'), 80)"],
      timeoutMs: 10_000,
    });
    clearInterval(timer);
    expect(result.stdout).toContain("hello");
    expect(result.timedOut).toBe(false);
    expect(ticks).toBeGreaterThan(0);
  });

  it("rejects when aborted", async () => {
    const abort = new AbortController();
    const pending = spawnCaptured({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10_000)"],
      timeoutMs: 10_000,
      abortSignal: abort.signal,
    });
    abort.abort();
    await expect(pending).rejects.toThrow("已取消");
  });

  it("keeps the whole stdout even when it is larger than the tail limit", async () => {
    const size = OUTPUT_TAIL_CHARS * 2;
    const result = await spawnCaptured({ command: process.execPath, args: bigOutput(size), timeoutMs: 20_000 });
    expect(result.stdout.length).toBe(size + "STARTEND".length);
    expect(result.stdout.startsWith("START")).toBe(true);
    expect(result.stdout.endsWith("END")).toBe(true);
  });

  it("decodes multi-byte characters split across chunks", async () => {
    const result = await spawnCaptured({ command: process.execPath, args: splitUtf8, timeoutMs: 10_000 });
    expect(result.stdout).toBe("中文\n");
  });
});

describe("runCommand", () => {
  it("keeps only the tail by default and flags the truncation", async () => {
    const size = OUTPUT_TAIL_CHARS * 2;
    const result = await runCommand({ command: process.execPath, args: bigOutput(size), cwd: process.cwd(), timeoutMs: 20_000, logFile: logFile() }).done;
    expect(result.code).toBe(0);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBe(OUTPUT_TAIL_CHARS);
    expect(result.stdout.endsWith("END")).toBe(true);
  });

  it("keeps the whole stdout with fullStdout", async () => {
    const size = OUTPUT_TAIL_CHARS * 2;
    const result = await runCommand({
      command: process.execPath,
      args: bigOutput(size),
      cwd: process.cwd(),
      timeoutMs: 20_000,
      logFile: logFile(),
      fullStdout: true,
    }).done;
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stdout.length).toBe(size + "STARTEND".length);
    expect(result.stdout.startsWith("START")).toBe(true);
  });

  it("does not flag small output as truncated", async () => {
    const result = await runCommand({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ok')"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      logFile: logFile(),
    }).done;
    expect(result.stdout).toBe("ok");
    expect(result.stdoutTruncated).toBe(false);
  });

  it("decodes multi-byte characters split across chunks, in stdout and line callbacks", async () => {
    const lines: string[] = [];
    const result = await runCommand({
      command: process.execPath,
      args: splitUtf8,
      cwd: process.cwd(),
      timeoutMs: 10_000,
      logFile: logFile(),
      onStdoutLine: (line) => lines.push(line),
    }).done;
    expect(result.stdout).toBe("中文\n");
    expect(lines).toEqual(["中文"]);
  });
});
