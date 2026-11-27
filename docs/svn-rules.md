# SVN 冲突规则（svnRules）

工作副本更新、切换时会遇到冲突，有些冲突的本地一侧其实没有保留价值：生成物、Unity 重新导入改掉的 `.meta` guid、和远端内容一模一样的文件、本地早就删掉了的目录。规则文件把这类判断写下来，由引擎自动取远端；规则覆盖不到的冲突保持阻塞，交给人处理。

规则文件由项目维护（OSG 的在 OSGToolset 仓 `svn-rules.toml`），通用包只读取，不运行项目代码。引擎在 `shared/svn-resolve.ts`，workingCopyPool 和 versionControl 的 `svn-update` 共用。

## 规则文件

```toml
version = 1

[categories]
# 类别名 = 相对工程根的路径；"/" 结尾表示目录（递归），否则只匹配该路径本身
generated = ["GameCore/GeneratedFiles/", "Project/Assets/Plugins/X86_64/GameCore.stable"]
art = ["Project/Assets/Art_Resources/"]

[discard]
always = ["generated"]   # 总是丢弃本地改动、取远端
optional = ["art"]       # 使用方显式开启才丢弃

[[rule]]
id = "identical"
when = "local-equals-incoming"

[[rule]]
id = "unity-meta-guid"
paths = ["*.meta"]
when = "yaml-keys-only"
keys = ["guid", "timeCreated"]

[[rule]]
id = "local-missing"
when = "local-only-missing"
```

- 路径归属按最长前缀，按路径段匹配：`X86_64/GameCore.stable` 不包含 `X86_64/GameCore.stable.meta`。Windows 上不区分大小写。
- 同一路径不能出现在两个类别里；`always` 与 `optional` 不能重叠；引用未定义的类别、未知字段、`version` 不是 1 都按错误报出。
- `paths` 是 glob：`*` 不跨目录，`**` 跨目录，不含 `/` 的模式只匹配文件名。不写 `paths` 表示任何路径。
- 规则按顺序判定，命中第一条即取远端。

三种判定：

| when | 取远端的条件 |
| --- | --- |
| `local-equals-incoming` | 本地版本与远端版本逐字节相同。文本冲突比较 `.mine` 与新基线；树冲突（如远端新增撞上未纳管文件）从仓库导出远端一侧比较 |
| `yaml-keys-only` | 两边是文本，去掉 `keys` 列出的顶层键（行首无缩进的 `key:`）后逐行相同；换行风格、BOM、末尾空行不算差异 |
| `local-only-missing` | 树冲突，本地一侧只剩缺失或已删除的条目，磁盘上没有内容，下面也没有属性改动或未纳管文件 |

## 处理什么

每次处理先 `svn status`，再判定、存档、动手，有动作就再查一轮，最多 3 轮：

- 冲突（文本、属性、树）：所在类别可丢弃，或命中一条规则 → 取远端。文本、属性冲突用 `resolve --accept theirs-full` 再 `revert`；树冲突用 `resolve --accept working` 再 `revert -R`，剩下的未纳管遗留删除。Unity 给 `.mine`、`.rN` 生成的孤儿 `.meta` 一并删除。
- 可丢弃类别里的普通本地改动（修改、新增、删除、缺失）→ 按类别前缀 `revert -R`。
- 可丢弃类别里被 `svn switch` 到别的 URL 的子路径 → 切回工作副本根对应的 URL。
- 其余冲突、`obstructed` 路径保持阻塞，原因写明：哪类冲突、属于哪个类别、为什么没有命中。
- 非可丢弃类别的普通本地改动（源码）不动。更新会和远端合并的那些，先存一份本地版本再更新。

工作副本锁（中断残留）先 `svn cleanup`。本地路径含 `@` 时自动补 peg。

## 存档

动手前先存档，`always` 类别（可再生内容）只记清单不拷内容，其余被处理的本地内容都可以恢复：

```
<存档根>/<YYYYMMDD-HHMMSS>/
  README.txt       说明与恢复方法
  changes.patch    受控改动的 svn diff，路径相对工作副本根；在同一分支的工作副本根执行 svn patch changes.patch
  files/           被处理路径的本地版本原样拷贝（文本冲突是 .mine，二进制是本地文件，属性冲突另存 .prej）
  versioned.txt    清单：阶段、动作、现场、路径、规则
  unversioned.txt  被删除的遗留文件（已拷进 files/）
  rules.json       每轮处理明细，最后一条记仍阻塞的条目
```

只有阻塞、没有任何动作时不建存档目录。

## 接入

**workingCopyPool**：池根 `pool.toml`：

```toml
[svnRules]
file = "C:/path/to/osg/svn-rules.toml"   # 本机绝对路径
enable = ["art"]                          # 开启的可选类别，可为空
```

配置后：

- `refresh`：更新前按规则处理，update/switch 用 `--accept postpone`，更新后有冲突再处理一轮。阻塞槽位也会重试，处理干净就恢复 `ready`。
- `acquire` 切换：切换前、切换后各处理一次；处理不了的标阻塞，不当成就绪交出去。
- `gc`：缩容回收前处理一次；复查阻塞槽位时先按规则处理，再走原有的复查。
- 中断恢复：遗留冲突的槽位标阻塞，交给下一次 refresh / gc。

存档放在 `patches/<分支>/<时间戳>`，按 `patchRetentionDays` 清理。有效租约、持有保护、正在处理、目录所有权未确认、有 svn 进程占着的槽位一律不碰。

没有 `[svnRules]` 时行为不变：冲突即阻塞。旧的 `[hooks]` 已移除，写了按配置错误报出。

**versionControl `svn-update`**：`onConflict = "rules"`，加上：

- `rulesFile`：规则文件路径（必填）；
- `rulesEnable`：开启的可选类别。

存档放在 `<backupDir 或 工作副本_backup>/<日期>/rules/<时间戳>`，结果里写出存档目录。仍有阻塞时以失败结束，原因逐条列出。

## 加新规则

遇到新的一类阻塞时，看阻塞原因里的路径和冲突类型：

- 整个目录都是可再生内容 → 加进 `generated`。
- 只有本地开发者才需要保留的资源 → 加进可选类别，由使用方决定是否开启。
- 本地一侧可以证明没有独有内容 → 加一条 `[[rule]]`，用 `paths` 限定范围。

不要把真实源码放进任何可丢弃类别。规则文件可以让工具丢弃本地改动，只由项目维护者修改。
