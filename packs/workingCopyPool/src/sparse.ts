/**
 * 稀疏规格（PRD working-copy-pool「稀疏」）：按路径给 svn depth，未列出的路径从父目录继承。
 *
 * - 根目录 depth 由 `root` 给出，缺省 infinity。
 * - 父目录有效 depth 为 infinity 时，子目录继承 infinity；否则子目录不在磁盘上（immediates 下以 empty 出现）。
 * - 列出路径的各级未列出祖先，按继承本来不会出现的，自动建成 empty 空壳。
 *
 * 纯函数，不访问 svn；svn.ts 按这里的规划执行。
 */

export const DEPTHS = ["exclude", "empty", "files", "immediates", "infinity"] as const;
export type Depth = (typeof DEPTHS)[number];

export type SparseSpec = {
  /** 根目录 depth，不能为 exclude。 */
  root: Exclude<Depth, "exclude">;
  /** 相对工作副本根的路径（正斜杠）到 depth。 */
  paths: Record<string, Depth>;
};

export const FULL_SPARSE: SparseSpec = { root: "infinity", paths: {} };

export function isDepth(value: unknown): value is Depth {
  return typeof value === "string" && (DEPTHS as readonly string[]).includes(value);
}

/** 不需要稀疏：根 infinity 且没有任何条目，直接完整检出。 */
export function isFullCheckout(spec: SparseSpec): boolean {
  return spec.root === "infinity" && Object.keys(spec.paths).length === 0;
}

/** 兼容旧写法：`exclude = [...]` 等价于根 infinity、这些路径 exclude。 */
export function specFromExclude(exclude: string[]): SparseSpec {
  return { root: "infinity", paths: Object.fromEntries(exclude.map((p) => [p, "exclude" as Depth])) };
}

export function parentOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

export function joinRel(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** 校验条目之间的关系，返回错误说明（空表示通过）。 */
export function specErrors(spec: SparseSpec): string[] {
  const errors: string[] = [];
  for (const rel of Object.keys(spec.paths)) {
    for (let p = parentOf(rel); p; p = parentOf(p)) {
      if (spec.paths[p] === "exclude") {
        errors.push(`${rel} 在已排除的 ${p} 之下`);
        break;
      }
    }
  }
  return errors;
}

/** 规划：按规格回答每个目录应有的 depth、需要展开哪些子目录。 */
export class SparsePlan {
  private readonly ancestors = new Set<string>();

  constructor(readonly spec: SparseSpec) {
    for (const rel of Object.keys(spec.paths)) {
      for (let p = parentOf(rel); ; p = parentOf(p)) {
        this.ancestors.add(p);
        if (!p) break;
      }
    }
  }

  /** 下面还有列出的路径。 */
  hasDescendants(rel: string): boolean {
    return this.ancestors.has(rel);
  }

  /** 有效 depth：列出的取列出值，否则从父目录有效 depth 继承（根取 root）。 */
  depthOf(rel: string, parentDepth?: Depth): Depth {
    if (!rel) return this.spec.root;
    const own = this.spec.paths[rel];
    if (own) return own;
    const parent = parentDepth ?? this.depthOf(parentOf(rel));
    return parent === "infinity" ? "infinity" : "empty";
  }

  /**
   * 这个目录在工作副本里该设的 depth：infinity 且下面还有列出的路径时用 immediates 展开，
   * 子目录再逐个设置；其余就是有效 depth。
   */
  wcDepth(rel: string, depth: Depth): Depth {
    return depth === "infinity" && this.hasDescendants(rel) ? "immediates" : depth;
  }

  /** 目录当前 depth 是否已满足规划（infinity 展开节点 immediates 或 infinity 都算满足）。 */
  satisfied(rel: string, depth: Depth, current: string | undefined): boolean {
    if (depth === "infinity" && this.hasDescendants(rel)) return current === "immediates" || current === "infinity";
    return current === depth;
  }

  /**
   * 父目录有效 depth 不是 infinity 时，需要显式带下来的直接子目录名（列出的或其祖先），
   * 不含 exclude（不在磁盘上即满足）。
   */
  neededChildren(rel: string): string[] {
    const out = new Set<string>();
    const prefix = rel ? `${rel}/` : "";
    const consider = (p: string): void => {
      if (!p.startsWith(prefix) || p === rel) return;
      const name = p.slice(prefix.length).split("/")[0];
      const child = joinRel(rel, name);
      if (child === p && this.spec.paths[p] === "exclude") return;
      out.add(name);
    };
    for (const p of Object.keys(this.spec.paths)) consider(p);
    return [...out].sort();
  }
}

/** dry-run 用的人读计划。 */
export function describeSparse(spec: SparseSpec): string[] {
  if (isFullCheckout(spec)) return ["稀疏：不排除，完整检出"];
  const entries = Object.entries(spec.paths).sort(([a], [b]) => a.localeCompare(b));
  const group = (depth: Depth): string[] => entries.filter(([, d]) => d === depth).map(([p]) => p);
  const lines = [`稀疏：根目录 ${spec.root}，未列出的目录从父目录继承`];
  for (const depth of DEPTHS) {
    const items = group(depth);
    if (items.length) lines.push(`  ${depth}：${items.join("、")}`);
  }
  const plan = new SparsePlan(spec);
  const shells = [...new Set(Object.keys(spec.paths).flatMap((p) => ancestorsOf(p)))]
    .filter((p) => !(p in spec.paths) && plan.depthOf(p) !== "infinity")
    .sort();
  if (shells.length) lines.push(`  自动空壳（empty）：${shells.join("、")}`);
  return lines;
}

function ancestorsOf(rel: string): string[] {
  const out: string[] = [];
  for (let p = parentOf(rel); p; p = parentOf(p)) out.push(p);
  return out;
}

// ---------------------------------------------------------------- 从工作副本导出

export type DirDepth = { rel: string; depth: Depth };

/**
 * 从工作副本各目录的实际 depth 反推最小规格：只保留跟继承结果不一致的目录。
 * immediates 目录下没有 empty 子目录（都被单独设过）时视为 infinity 展开节点。
 */
export function captureSpec(dirs: DirDepth[]): SparseSpec {
  const actual = new Map(dirs.map((d) => [d.rel, d.depth]));
  const children = new Map<string, string[]>();
  for (const { rel } of dirs) {
    if (!rel) continue;
    const parent = parentOf(rel);
    children.set(parent, [...(children.get(parent) ?? []), rel]);
  }
  const effective = new Map<string, Depth>();
  for (const rel of [...actual.keys()].sort((a, b) => a.split("/").length - b.split("/").length)) {
    let depth = actual.get(rel)!;
    if (depth === "immediates") {
      const kids = children.get(rel) ?? [];
      if (!kids.some((k) => actual.get(k) === "empty")) depth = "infinity";
    }
    effective.set(rel, depth);
  }

  const rootDepth = effective.get("") ?? "infinity";
  const root: SparseSpec["root"] = rootDepth === "exclude" ? "infinity" : rootDepth;
  const listed = new Map<string, Depth>();
  for (const [rel, depth] of effective) {
    if (!rel) continue;
    const parent = effective.get(parentOf(rel)) ?? root;
    if (parent === "infinity" && depth === "infinity") continue;
    if (parent === "immediates" && depth === "empty") continue;
    listed.set(rel, depth);
  }
  // 父目录不是 infinity 的 empty 目录，若下面有列出的路径，会被自动建成空壳，不必列出
  for (const [rel, depth] of [...listed]) {
    if (depth !== "empty") continue;
    const parent = effective.get(parentOf(rel)) ?? root;
    if (parent === "infinity") continue;
    const prefix = `${rel}/`;
    if ([...listed.keys()].some((p) => p.startsWith(prefix))) listed.delete(rel);
  }
  const paths = Object.fromEntries([...listed].sort(([a], [b]) => a.localeCompare(b)));
  return { root, paths };
}

/** 规格写成 pool.toml 片段。 */
export function formatSpecToml(spec: SparseSpec): string {
  const lines = ["[sparse]", `root = "${spec.root}"`];
  const entries = Object.entries(spec.paths);
  if (entries.length) {
    lines.push("", "[sparse.depth]");
    const width = Math.max(...entries.map(([p]) => JSON.stringify(p).length));
    for (const [p, d] of entries) lines.push(`${JSON.stringify(p).padEnd(width)} = "${d}"`);
  }
  return `${lines.join("\n")}\n`;
}
