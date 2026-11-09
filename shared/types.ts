/**
 * 能力包 manifest 与运行上下文类型。
 * 来源：cronkit `src/core/toolset/types.ts`（toolset schemaVersion 1），按 ADR-0019 增加
 * toolset 级 `runtime` 与工具级 `platforms`。
 */
export const SUPPORTED_SCHEMA_VERSION = 1;

export type ParamType = "string" | "number" | "boolean" | "string[]" | "enum";

export type Platform = "win32" | "darwin" | "linux";

export type ToolParamSpec = {
  name: string;
  type: ParamType;
  required?: boolean;
  default?: unknown;
  enum?: string[];
  description?: string;
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
  /** 长任务运行中的实时进度（如 Unity 导入日志心跳）。 */
  onProgress?: (line: string) => void;
};

export type ToolRunResult = {
  detail: string;
  code: number | null;
  skipped?: boolean;
};
