import path from "node:path";

/**
 * 来源：cronkit `src/core/paths.ts`。只保留与宿主无关的路径归一化；
 * 数据目录、配置、日志路径属于调用方（novoard-agent），不进能力包。
 */
export function normalizePathKey(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").toLowerCase();
}
