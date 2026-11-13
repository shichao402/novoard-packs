import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { manifest as general } from "../packs/general/src/manifest";
import { manifest as versionControl } from "../packs/versionControl/src/manifest";
import type { ToolManifest } from "../shared/types";

// 基准：cronkit 4c7b2ec `BUILTIN_MANIFEST.tools`，去掉 script 工具与 confirmRemoteWrite 参数。
const here = path.dirname(fileURLToPath(import.meta.url));
const cronkitTools: ToolManifest[] = JSON.parse(
  readFileSync(path.join(here, "fixtures", "cronkit-builtin-tools.json"), "utf8"),
);
const NEW_TOOLS = new Set(["release-occupants"]);
// cronkit 由步骤 timeout 承担、迁移后需单列的参数
const NEW_PARAMS: Record<string, string[]> = { "quit-idle": ["timeout"] };

// cronkit 用 `path` 在 target 工程根下取子目录；迁移后由步骤的 cwd 承担，工具不读，已删除。
// release-occupants 的 path 是新工具自己的必填参数，不在此列（它也不在 cronkit 基准里）。
const REMOVED_PARAMS = new Set(["path"]);
const cronkitPorted: ToolManifest[] = cronkitTools.map((t) =>
  t.params ? { ...t, params: t.params.filter((p) => !REMOVED_PARAMS.has(p.name)) } : t,
);

const baseline = new Map(cronkitTools.map((t) => [t.id, t]));

/** 去掉迁移后新增的内容：platforms、单列参数，以及表单展示字段（label、format、cronkit 没有的参数说明）。 */
function withoutPlatforms({ platforms: _platforms, ...rest }: ToolManifest): ToolManifest {
  const extra = NEW_PARAMS[rest.id] ?? [];
  if (!rest.params) return rest;
  const origin = new Map((baseline.get(rest.id)?.params ?? []).map((p) => [p.name, p]));
  const params = rest.params
    .filter((p) => !extra.includes(p.name))
    .map(({ label: _label, format: _format, ...p }) => {
      if (origin.get(p.name)?.description === undefined) delete p.description;
      return p;
    });
  return { ...rest, params };
}

describe("manifest 与 cronkit builtin 一致", () => {
  const ported = [...versionControl.tools, ...general.tools].filter((t) => !NEW_TOOLS.has(t.id));

  it("工具集合与顺序一致", () => {
    expect(ported.map((t) => t.id)).toEqual(cronkitTools.map((t) => t.id));
  });

  it("每个工具的字段与参数一致（platforms 为新增字段，不参与比较）", () => {
    expect(ported.map(withoutPlatforms)).toEqual(cronkitPorted);
  });

  it("只有 release-occupants 带 path 参数（其余工具的 path 已随 cronkit 子路径语义删除）", () => {
    const withPath = [...versionControl.tools, ...general.tools]
      .filter((t) => (t.params ?? []).some((p) => p.name === "path"))
      .map((t) => t.id);
    expect(withPath).toEqual(["release-occupants"]);
  });

  it("任何工具都不再有 confirmRemoteWrite，远端写工具保留 remoteWrite", () => {
    for (const t of [...versionControl.tools, ...general.tools]) {
      expect((t.params ?? []).map((p) => p.name)).not.toContain("confirmRemoteWrite");
    }
    const remote = versionControl.tools.filter((t) => t.remoteWrite).map((t) => t.id);
    expect(remote).toEqual(["svn-copy", "svn-delete", "git-push"]);
  });

  it("toolset 头部字段符合 ADR-0019", () => {
    for (const m of [versionControl, general]) {
      expect(m).toMatchObject({ schemaVersion: 1, runtime: "node", entry: "dist/pack.mjs" });
    }
  });

  it("platforms：versionControl 全平台；quit-idle、release-occupants 仅 win32；unity-warmup win32+darwin", () => {
    expect(versionControl.tools.every((t) => t.platforms === undefined)).toBe(true);
    const byId = Object.fromEntries(general.tools.map((t) => [t.id, t.platforms]));
    expect(byId).toEqual({
      "unity-warmup": ["win32", "darwin"],
      "quit-idle": ["win32"],
      "release-occupants": ["win32"],
    });
  });

  it("quit-idle：新增可选 timeout，承接 cronkit 步骤 timeout", () => {
    const tool = general.tools.find((t) => t.id === "quit-idle");
    expect(tool?.params?.find((p) => p.name === "timeout")).toMatchObject({ name: "timeout", type: "string", format: "duration" });
    expect(tool?.params?.find((p) => p.name === "timeout")?.required).toBeUndefined();
  });

  it("release-occupants：path 必填，extraFiles 可选", () => {
    const tool = general.tools.find((t) => t.id === "release-occupants");
    expect(tool?.params).toMatchObject([
      { name: "path", type: "string", required: true },
      { name: "extraFiles", type: "string[]" },
    ]);
    expect(tool?.params?.[1]?.required).toBeUndefined();
  });

  it("表单字段：每个参数都有 label；format 只用 path/duration/time", () => {
    for (const t of [...versionControl.tools, ...general.tools]) {
      for (const p of t.params ?? []) {
        expect(p.label, `${t.id}.${p.name}`).toBeTruthy();
        if (p.format) expect(["path", "duration", "time"]).toContain(p.format);
      }
    }
    const quit = general.tools.find((t) => t.id === "quit-idle");
    const formats = Object.fromEntries((quit?.params ?? []).map((p) => [p.name, p.format]));
    expect(formats).toMatchObject({ idleFor: "duration", countIdleFrom: "time", until: "time", retryInterval: "duration", closeWait: "duration", timeout: "duration" });
  });
});
