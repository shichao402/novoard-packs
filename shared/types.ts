/**
 * 能力包 manifest 与运行上下文类型。
 * 来源：cronkit `src/core/toolset/types.ts`（toolset schemaVersion 1），按 ADR-0019 增加
 * toolset 级 `runtime` 与工具级 `platforms`。
 */
export const SUPPORTED_SCHEMA_VERSION = 1;

export type ParamType = "string" | "number" | "boolean" | "string[]" | "enum";

export type Platform = "win32" | "darwin" | "linux";

export type ParamFormat = "path" | "duration" | "time";

export type ToolParamSpec = {
  name: string;
  type: ParamType;
  required?: boolean;
  default?: unknown;
  enum?: string[];
  description?: string;
  /** 表单上显示的名字，缺省用 name。 */
  label?: string;
  /** 表单控件提示：path 带目录选择（相对工程根），duration 如 10m，time 如 08:00。 */
  format?: ParamFormat;
};

export type ToolManifest = {
  id: string;
  displayName: string;
  description?: string;
  params?: ToolParamSpec[];
  idempotent?: boolean;
  requiresExclusiveWorkspace?: boolean;
  remoteWrite?: boolean;
  supportsDryRun?: boolean;
  supportsResultJson?: boolean;
  allowRawArgs?: boolean;
  lowPriority?: boolean;
  /** 缺省视为全平台（ADR-0019）。 */
  platforms?: Platform[];
};

export type ToolsetManifest = {
  id: string;
  displayName: string;
  schemaVersion: number;
  runtime: "node";
  entry: "dist/pack.mjs";
  tools: ToolManifest[];
};

export type ToolRunContext = {
  cwd: string;
  timeoutMs: number;
  logFile: string;
  abortSignal: AbortSignal;
  dryRun?: boolean;
  resultJsonPath?: string;
  localDate?: string;
  workspacePath: string;
  /** 长任务运行中的实时进度（如 Unity 导入日志心跳、svn update 文件计数）；percent 0–100，未知时省略。 */
  onProgress?: ProgressFn;
};

export type ProgressFn = (message: string, percent?: number | null) => void;

export type ToolRunResult = {
  detail: string;
  code: number | null;
  skipped?: boolean;
};
