import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { followUnityLog } from "../packs/general/src/unity";

// cronkit 同文件里的 deadlineAtFromCron 用例属于调度器，随 PRD-7 A2 移植到 novoard-agent。
describe("followUnityLog", () => {
  it("streams new lines as heartbeat and collects warning lines", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "novoard-packs-unitylog-"));
    try {
      const logFile = path.join(dir, "unity.log");
      const beats: string[] = [];
      const tailer = followUnityLog(logFile, (line) => beats.push(line));

      // 首次采样：文件不存在属正常，不应心跳
      expect(beats).toEqual([]);

      writeFileSync(logFile, "\uFEFFDisplayProgressbar: something (10%)\n", "utf8");
      tailer.tickForTest();

      writeFileSync(logFile, "Refreshing native plugins\n", { flag: "a" });
      tailer.tickForTest();
      // 两个采样周期后：心跳推进到最新一行
      expect(beats[beats.length - 1]).toBe("Refreshing native plugins");

      writeFileSync(
        logFile,
        "Shader error: 'Foo' had invalid preprocessor\nException: something broke\nall good\n",
        { flag: "a" },
      );
      tailer.tickForTest();
      expect(beats[beats.length - 1]).toBe("all good");
      expect(tailer.warnings()).toEqual([
        "Shader error: 'Foo' had invalid preprocessor",
        "Exception: something broke",
      ]);

      tailer.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores duplicate warning lines and keeps last line only per sample", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "novoard-packs-unitylog-"));
    try {
      const logFile = path.join(dir, "unity.log");
      const beats: string[] = [];
      const tailer = followUnityLog(logFile, (line) => beats.push(line));

      writeFileSync(
        logFile,
        "error: same message\nerror: same message\nerror: same message\nfinal line\n",
        "utf8",
      );
      tailer.tickForTest();
      expect(beats).toEqual(["final line"]);
      expect(tailer.warnings()).toEqual(["error: same message"]);

      tailer.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
