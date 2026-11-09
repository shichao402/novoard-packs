#!/usr/bin/env node
/**
 * 构建每个能力包：
 * 1. esbuild 把 packs/<id>/src/index.ts 打成单文件 packs/<id>/dist/pack.mjs（产物随代码提交）；
 * 2. 从打包产物导出的 manifest 生成 packs/<id>/toolset.json（manifest 单一事实源是 src/manifest.ts）；
 * 3. 把该包用到的 shared/scripts/*.ps1 复制到 packs/<id>/scripts/。
 * 输出必须确定：同一源码重复 build 不产生 git diff（`npm run check` 校验）。
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 每个包需要的 ps1；occupants 两包都用，idle-quit 只在 general。 */
const PACKS = {
  versionControl: ["list-occupants.ps1"],
  general: ["list-occupants.ps1", "quit-idle-apps.ps1"],
};

for (const [id, scripts] of Object.entries(PACKS)) {
  const packDir = path.join(root, "packs", id);
  const outfile = path.join(packDir, "dist", "pack.mjs");
  await build({
    entryPoints: [path.join(packDir, "src", "index.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    legalComments: "none",
    logLevel: "warning",
  });

  const scriptsDir = path.join(packDir, "scripts");
  rmSync(scriptsDir, { recursive: true, force: true });
  mkdirSync(scriptsDir, { recursive: true });
  for (const name of scripts) {
    copyFileSync(path.join(root, "shared", "scripts", name), path.join(scriptsDir, name));
  }

  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  if (mod.manifest?.id !== id) {
    throw new Error(`packs/${id} 导出的 manifest.id 是 ${mod.manifest?.id}，应为 ${id}`);
  }
  writeFileSync(path.join(packDir, "toolset.json"), `${JSON.stringify(mod.manifest, null, 2)}\n`, "utf8");
  console.log(`built packs/${id}: ${mod.manifest.tools.length} tools`);
}
