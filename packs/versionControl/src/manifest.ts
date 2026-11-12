import type { ToolManifest, ToolsetManifest } from "../../../shared/types";
import { GIT_TOOLS } from "./git";

// 条目从 cronkit `src/core/toolset/builtin.ts` 转写。迁移规则：删除 confirmRemoteWrite，
// 远端写由 agent 审批（manifest 保留 remoteWrite: true）。全平台，故不写 platforms。

const svnUpdate: ToolManifest = {
  id: "svn-update",
  displayName: "SVN 更新",
  description: "对照远端差异估计将写入的文件；Windows 上可按写集释放占用后再更新",
  idempotent: true,
  requiresExclusiveWorkspace: true,
  supportsDryRun: true,
  params: [
    {
      name: "strategy",
      type: "enum",
      enum: ["follow-latest", "manual", "disabled"],
      default: "follow-latest",
      required: true,
      label: "更新策略",
    },
    {
      name: "onConflict",
      type: "enum",
      enum: ["fail", "postpone", "revert"],
      default: "fail",
      label: "遇到冲突",
      description: "fail: 冲突即失败；postpone: 保留现场挂起本轮，下轮自动继续；revert: 备份后还原",
    },
    { name: "backupOnRevert", type: "boolean", default: true, label: "还原前备份" },
    { name: "backupDir", type: "string", label: "备份目录", format: "path" },
    {
      name: "releaseOccupants",
      type: "boolean",
      default: true,
      label: "释放占用",
      description: "按本次将写入的文件释放占用；独占失败会 cleanup 后重试一次。不想强杀就关掉",
    },
    { name: "path", type: "string", label: "子路径（暂不生效）", description: "沿用自 cronkit，当前版本的工具不读取；要换目录请改步骤的「工程根」" },
  ],
};

const svnCleanup: ToolManifest = {
  id: "svn-cleanup",
  displayName: "SVN Cleanup",
  idempotent: true,
  requiresExclusiveWorkspace: true,
  params: [
    { name: "removeUnversioned", type: "boolean", default: false, label: "删除未纳管文件" },
    { name: "path", type: "string", label: "子路径（暂不生效）", description: "沿用自 cronkit，当前版本的工具不读取；要换目录请改步骤的「工程根」" },
  ],
};

const svnRevert: ToolManifest = {
  id: "svn-revert",
  displayName: "SVN Revert",
  description: "按 svn status 的本地改动估计将改写的文件；Windows 上可先释放占用",
  idempotent: true,
  requiresExclusiveWorkspace: true,
  params: [
    { name: "recursive", type: "boolean", default: true, label: "递归" },
    {
      name: "releaseOccupants",
      type: "boolean",
      default: true,
      label: "释放占用",
      description: "按本地脏文件释放占用。不想强杀就关掉",
    },
    { name: "path", type: "string", label: "子路径（暂不生效）", description: "沿用自 cronkit，当前版本的工具不读取；要换目录请改步骤的「工程根」" },
  ],
};

const svnSwitch: ToolManifest = {
  id: "svn-switch",
  displayName: "SVN Switch",
  idempotent: false,
  requiresExclusiveWorkspace: true,
  remoteWrite: false,
  params: [
    { name: "url", type: "string", required: true, label: "目标 URL" },
    { name: "path", type: "string", label: "子路径（暂不生效）", description: "沿用自 cronkit，当前版本的工具不读取；要换目录请改步骤的「工程根」" },
  ],
};

const svnCopy: ToolManifest = {
  id: "svn-copy",
  displayName: "SVN Copy（远端写）",
  idempotent: false,
  remoteWrite: true,
  params: [
    { name: "source", type: "string", required: true, label: "源 URL" },
    { name: "destination", type: "string", required: true, label: "目标 URL" },
    { name: "message", type: "string", required: true, label: "提交说明" },
  ],
};

const svnDelete: ToolManifest = {
  id: "svn-delete",
  displayName: "SVN Delete（远端写）",
  idempotent: false,
  remoteWrite: true,
  params: [
    { name: "target", type: "string", required: true, label: "要删除的 URL" },
    { name: "message", type: "string", required: true, label: "提交说明" },
  ],
};

export const manifest: ToolsetManifest = {
  id: "versionControl",
  displayName: "版本控制",
  schemaVersion: 1,
  runtime: "node",
  entry: "dist/pack.mjs",
  tools: [svnUpdate, svnCleanup, svnRevert, svnSwitch, svnCopy, svnDelete, ...GIT_TOOLS],
};
