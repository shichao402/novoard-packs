import type { ToolManifest, ToolsetManifest } from "../../../shared/types";

// unity-warmup、quit-idle 从 cronkit `src/core/toolset/builtin.ts` 转写；release-occupants 为新增工具。

const unityWarmup: ToolManifest = {
  id: "unity-warmup",
  displayName: "Unity 预热",
  idempotent: true,
  requiresExclusiveWorkspace: true,
  lowPriority: true,
  supportsDryRun: true,
  platforms: ["win32", "darwin"],
  params: [
    { name: "nographics", type: "boolean", default: false, label: "无图形模式", description: "以 -nographics 启动 Unity" },
    { name: "executeMethod", type: "string", label: "执行方法", description: "导入完成后调用的静态方法，如 Build.Warmup；留空只导入" },
    { name: "path", type: "string", label: "子路径（暂不生效）", description: "沿用自 cronkit，当前版本的工具不读取；要换目录请改步骤的「工程根」" },
  ],
};

const quitIdle: ToolManifest = {
  id: "quit-idle",
  displayName: "空闲退出进程",
  idempotent: true,
  supportsDryRun: true,
  platforms: ["win32"],
  params: [
    { name: "processNames", type: "string[]", required: true, label: "进程名", description: "如 Unity.exe" },
    { name: "idleFor", type: "string", required: true, label: "空闲多久后退出", format: "duration" },
    { name: "countIdleFrom", type: "string", default: "00:00", label: "从几点开始计空闲", format: "time" },
    { name: "until", type: "string", default: "08:00", label: "最晚等到", format: "time" },
    { name: "retryInterval", type: "string", label: "检查间隔", format: "duration", description: "还没空闲时隔多久再看一次；留空只看一次" },
    { name: "closeWait", type: "string", default: "3m", label: "正常关闭等待", format: "duration" },
    // cronkit 由步骤 timeout 决定（无 retryInterval 时即正常关闭的等待上限）；agent 只有整次运行的上限，
    // 所以单列成参数。缺省时用 CLI 兜底上限。
    { name: "timeout", type: "string", label: "等待上限", format: "duration" },
  ],
};

const releaseOccupants: ToolManifest = {
  id: "release-occupants",
  displayName: "释放占用进程",
  description: "关闭占用指定目录（及额外文件）的进程；IDE 只请求正常关闭，不强杀",
  idempotent: true,
  supportsDryRun: true,
  platforms: ["win32"],
  params: [
    { name: "path", type: "string", required: true, label: "目录", format: "path", description: "要释放占用的目录（相对工作目录或绝对路径）" },
    { name: "extraFiles", type: "string[]", label: "额外文件", format: "path", description: "目录之外还要检查的文件" },
  ],
};

export const manifest: ToolsetManifest = {
  id: "general",
  displayName: "通用工具",
  schemaVersion: 1,
  runtime: "node",
  entry: "dist/pack.mjs",
  tools: [unityWarmup, quitIdle, releaseOccupants],
};
