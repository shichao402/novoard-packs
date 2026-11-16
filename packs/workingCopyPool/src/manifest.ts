import type { ToolManifest, ToolsetManifest } from "../../../shared/types";

// 规格：docs/prd/working-copy-pool.md。所有工具的 cwd 都是池根；全平台，释放占用只在 win32 生效。
// 不声明 requiresExclusiveWorkspace：agent 的路径锁按 cwd 字符串加锁、不解析链接，管不住槽位，以本包的锁和 phase 为准。

const candidates: ToolManifest = {
  id: "candidates",
  displayName: "候选分支",
  description: "开分支的候选项：池中已有、常驻、最近使用、listFrom 下最近有提交的分支",
  kind: "query",
  idempotent: true,
  supportsDryRun: true,
  supportsResultJson: true,
};

const occupied: ToolManifest = {
  id: "occupied",
  displayName: "占用中的分支",
  description: "释放分支的候选项：当前有有效租约的分支",
  kind: "query",
  idempotent: true,
  supportsDryRun: true,
  supportsResultJson: true,
};

const status: ToolManifest = {
  id: "status",
  displayName: "池状态",
  description: "每个槽位的分支、状态、租约、标签、本地改动、落后 revision 与最后使用时间",
  kind: "query",
  idempotent: true,
  supportsDryRun: true,
  supportsResultJson: true,
};

const acquire: ToolManifest = {
  id: "acquire",
  displayName: "占用分支",
  description: "按分支占用一个工作副本，入口固定为 <池根>/branch/<分支>",
  kind: "action",
  idempotent: true,
  supportsDryRun: true,
  supportsResultJson: true,
  params: [
    { name: "branch", type: "string", required: true, label: "分支" },
    { name: "ttl", type: "string", label: "保留时长", description: "如 1d、3d、12h 或 forever；缺省取 pool.toml 的 defaultTtl" },
    { name: "tag", type: "string", label: "标签", description: "如 bug-12345，池满时会列出" },
  ],
};

const release: ToolManifest = {
  id: "release",
  displayName: "释放分支",
  description: "清除租约，不动文件；下次再要这个分支时不用切换",
  kind: "action",
  idempotent: true,
  supportsDryRun: true,
  supportsResultJson: true,
  params: [{ name: "branch", type: "string", required: true, label: "分支" }],
};

const gc: ToolManifest = {
  id: "gc",
  displayName: "池回收",
  description: "推进中断恢复、复查阻塞槽位、缩容删除多出的空闲槽位、清理断链与过期存档",
  kind: "action",
  idempotent: true,
  supportsDryRun: true,
  supportsResultJson: true,
};

const refresh: ToolManifest = {
  id: "refresh",
  displayName: "更新常驻分支",
  description: "常驻分支在池里就更新到最新，不在池里就用空闲槽位准备好",
  kind: "action",
  idempotent: true,
  supportsDryRun: true,
  supportsResultJson: true,
};

export const manifest: ToolsetManifest = {
  id: "workingCopyPool",
  displayName: "工作副本池",
  schemaVersion: 1,
  runtime: "node",
  entry: "dist/pack.mjs",
  tools: [candidates, occupied, status, acquire, release, gc, refresh],
};
