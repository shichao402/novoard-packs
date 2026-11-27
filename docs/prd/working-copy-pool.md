# PRD：workingCopyPool 能力包（工作副本池）

- 状态：草稿，待审阅
- 日期：2026-11-16
- 讨论来源：2026-11-16 与用户讨论 OSG 多分支工程的磁盘管理。结论：池子是独立的通用能力包，放在本仓，由 novoard-agent 调度；交互入口全部复用 agent 现有机制（磁贴、带 inputs 的磁贴、内置会话、定时）
- 依赖：novoard-agent 仓 ADR-0019（能力包协议）、ADR-0020（磁贴运行时输入与查询工具）
- 修订（2026-11-27）：常驻分支断代删除，改为工程清单 `projects`；槽位只放在 `[storage].roots` 里，池定义目录下不再有 `slots/`；新增池外改动校正

## 背景

大型 SVN 工程（以 OSG 为例：全量约 700GB，去掉美术资源后约 30GB）需要同时跟进 5 个以上分支。按目录手工管理工作副本，磁盘很快被占满，也说不清哪个目录是哪个分支、还要不要。

workingCopyPool 把一组工作副本收成一个池：用户只说要哪个分支，池子负责找一个工作副本切过去，用完归还，过期自动回收，工程清单里已挂槽的分支每天保持最新。用户不再关心工作副本放在哪个物理目录：槽位对用户不可见，入口是 `branch/<分支>`，需要真实路径时由调用方（如 OSGLauncher）代理。

手工管理的工作副本不在池子范围内。池只操作自己在状态中登记的槽位，槽位只在 [storage].roots 明确授权的本机专用目录中创建，池定义目录（池根）本身只放配置、入口、存档和状态；不扫描、不收编、不覆盖其他目录。池外手动维护的工作副本（比如日常用的 trunk）和池里的同名分支互不影响。

## 目标与非目标

目标：

- 按分支占用和释放，入口是固定路径 `<池根>/branch/<分支>`，与槽位无关。入口只在分支挂在槽位上且目录存在时才有，没挂槽时入口失效。
- 槽位数量由配置决定，不按磁盘自动推算。槽位按 [storage] 分配到一个或多个盘，每个盘可单独设剩余空间下限；已有槽位的实际路径保持不变。
- 本地改动在切换或删除前一律存档，不会被冲掉。
- 工程清单（`projects`）描述池里需要哪些分支，消费方据此生成工程卡片；已挂槽的每天更新，没挂槽的在打开时按需分配，不为它们抢槽位。
- 只做通用池化逻辑，不含任何项目专属规则。项目差异全部写在池根的配置文件里。

非目标：

- 不管理槽位里的构建产物和编辑器缓存（如 Unity `Library`）。对池子来说它们只是目录内容，需要按分支缓存时由项目能力包（如 OSGToolset）另行提供工具。
- 不做交互界面。用户入口由 agent 的磁贴、选择框和内置会话提供。
- 不做跨机器共享池。
- 不收编池外已有的工作副本（后续再议）。
- 不跟踪 IDE、Unity 是否还开着。调用方通过 `hold`/`unhold` 告知；进程跟踪、心跳和超时放弃由调用方（如 OSGLauncher）负责。
- 第一版只支持 SVN。

## 用户怎么用

用户不敲命令。全部入口都是 novoard-agent 的 target：

| 入口 | 例子 | 依赖 |
| --- | --- | --- |
| 固定磁贴 | 点“s2pub 开工”：占用 s2pub，释放占用，更新，打开 Unity | 本包 action 工具 |
| 带选项的磁贴 | 点“开分支”，从候选列表选一个分支和保留时长 | 本包 query 工具 + ADR-0020 |
| 内置会话 | “开 release_1.12 跟 bug-12345” | agent 侧补带参触发与查候选（见“依赖与排期”） |
| 定时 | 每晚 gc + refresh | 本包 action 工具 |

target 示例（`poolRoot` 作为 target 变量，池工具的 `cwd` 就是池根）：

```yaml
open-branch:
  title: 开分支
  expose: a2a
  audit: summary
  requiresApproval: false
  notify: on-failure
  vars: { poolRoot: "D:/osgpool" }
  inputs:
    - { name: branch, label: 分支, choices: { uses: workingCopyPool/candidates, cwd: "{{poolRoot}}" }, default: last, allowCustom: true }
    - { name: ttl, label: 保留, choices: ["1d", "3d", "forever"], default: "1d" }
  steps:
    - uses: workingCopyPool/acquire
      cwd: "{{poolRoot}}"
      with: { branch: "{{branch}}", ttl: "{{ttl}}" }
    - script: cursor "{{poolRoot}}/branch/{{branch}}"

s2pub:
  title: s2pub 开工
  expose: a2a
  audit: summary
  requiresApproval: false
  notify: on-failure
  vars: { poolRoot: "D:/osgpool", branch: s2pub }
  steps:
    - uses: workingCopyPool/acquire
      cwd: "{{poolRoot}}"
      with: { branch: "{{branch}}" }
    - uses: general/release-occupants
      cwd: "{{poolRoot}}/branch/{{branch}}"
      with: { path: "." }
    - uses: versionControl/svn-update
      cwd: "{{poolRoot}}/branch/{{branch}}"
    - uses: general/unity-open
      cwd: "{{poolRoot}}/branch/{{branch}}"
      with: { projectPath: "client" }

release-branch:
  title: 释放分支
  expose: a2a
  audit: summary
  requiresApproval: false
  notify: on-failure
  vars: { poolRoot: "D:/osgpool" }
  inputs:
    - { name: branch, label: 分支, choices: { uses: workingCopyPool/occupied, cwd: "{{poolRoot}}" } }
  steps:
    - uses: workingCopyPool/release
      cwd: "{{poolRoot}}"
      with: { branch: "{{branch}}" }

wc-pool-nightly:
  title: 池子夜间维护
  expose: local
  audit: summary
  requiresApproval: false
  notify: on-failure
  schedule: "0 4 * * *"
  timeout: 3h
  vars: { poolRoot: "D:/osgpool" }
  steps:
    - uses: workingCopyPool/gc
      cwd: "{{poolRoot}}"
    - uses: workingCopyPool/refresh
      cwd: "{{poolRoot}}"
```

虚拟路径只由池根和分支名决定，所以 acquire 之后的步骤直接用插值拼路径，不需要在步骤之间传递输出。

## 用户故事

**US1 建池。** 在池根放一份 `pool.toml`（必须写 `[storage].roots`），第一次执行任何 pool 工具时自动建出目录结构和状态文件。池根下除 `pool.toml` 外的内容都由池子管理；槽位目录在 roots 里，不在池根下。

**US2 按分支占用。** 选一个分支，几秒到几十分钟后 `branch/<分支>` 可用。分支已在池里时立即返回，只续租。结果里写明用了哪个槽位、是新切的还是已有的、离最新落后多少个 revision。

**US3 临时租约自动回收。** 占用时给保留时长（缺省取配置 `defaultTtl`）。到期后槽位变成可复用，不需要人手释放。

**US4 手动释放。** 从“当前占用中”的候选里选一个释放。释放只改记录，不动文件，工作副本留在原分支上，下次再要这个分支时不用切换。

**US5 工程清单保持最新。** 配置里的 `projects` 列出当前需要的工作分支（以后由分析服务给出，接入前手动维护），消费方按它增、删、更新工程卡片。夜间 refresh 只把已挂在槽位上的工程更新到最新；没挂槽的跳过，打开时再按需分配，不抢有效租约。选槽位和缩容时优先换出不在清单里的空闲槽位，有余量时宁可新建也不换出工程槽位。

**US6 本地改动不丢。** 槽位被切换或删除前，受版本控制的改动先导出成 patch 存档，再还原。存档按分支和时间存放，可以找回。

**US7 池满时说清楚。** 没有可用槽位且已到上限时，占用失败，列出每个槽位的分支、租约到期时间和标签。

**US8 中断后能恢复。** 切换中途被取消、超时或机器重启，下次操作这个槽位时先恢复，不会让虚拟路径指向一个切了一半的工作副本。

**US9 缩容。** 把 `maxSlots` 调小后，多出来的槽位在空闲时由 gc 删除（先删不在工程清单里的，再按最后使用时间从早到晚；删除前同样存档改动），有租约或保护的等它们结束。

**US10 看全池状态。** 查询每个槽位的分支、状态、租约、标签、本地改动摘要、落后 revision、最后使用时间和实际目录，以及哪些工程还没挂槽。agent 磁贴、内置会话和 OSGLauncher 都用它。

**US11 池外改动能校正。** 有人在池外把槽位 `svn switch` 到别的分支、删掉了槽位目录，下次 acquire、refresh 或 gc 时池子按真实情况修正记录和入口，不让 `branch/<分支>` 指向别的分支。

## 配置：`<池根>/pool.toml`

```toml
# 槽位上限，按需调整
maxSlots = 6
# 不指定保留时长时的租约
defaultTtl = "1d"
# SVN 仓库根
svnRoot = "https://svn.example.com/osg"
# 工程清单：当前需要的工作分支（用分支名，见 aliases）；以后由分析服务给出
projects = ["s2pub", "exp", "live"]

# 槽位存放位置（必填）：本机专用目录，可跨盘；池根下不放槽位
[storage]
# 每项可以是字符串，也可以写成 { path, minFreeGiB } 给这块盘单独设下限
roots = ["E:/osgpool-slots", { path = "F:/osgpool-slots", minFreeGiB = 300 }]
# 没单独写下限的目录用这个值（GiB），缺省 0
minFreeGiB = 100

[branches]
# 分支名到仓库路径的默认映射，{name} 为分支名
pattern = "branches/{name}"
# candidates 从这些目录列出分支，只取最近 recentDays 天有提交的
listFrom = ["branches"]
recentDays = 30

# 分支名到仓库路径的显式映射，优先于 pattern
[aliases]
trunk = "trunk"
s2pub = "branches/s2_publish"

[sparse]
# 根目录 depth，缺省 infinity
root = "empty"

# 相对工作副本根的路径到 svn depth（exclude / empty / files / immediates / infinity）
[sparse.depth]
"client/Assets/Scripts" = "infinity"
"client/Assets/Plugins" = "infinity"
"client/ProjectSettings" = "infinity"
"client/Packages"       = "infinity"
"client/Assets/UI"      = "infinity"
"client/Assets/UI/Big"  = "exclude"
```

- 配置由用户手写，工具只读不写。
- 每次运行都重新读取配置，改完即生效。
- 解析用打进 `dist/pack.mjs` 的 TOML 库，不引入运行时依赖。
- 校验失败时所有工具以退出码 64 失败，result json 写明哪一行哪个字段。
- `resident` 已断代删除，写了按配置错误报出，提示把需要的分支（包括 trunk）都写进 `projects`。

### 多盘存储（2026-11-23，2026-11-27 改为必填）

`[storage].roots` 必填，每项是本机绝对专用目录的字符串，或 `{ path, minFreeGiB }`；`[storage].minFreeGiB` 是没单独写下限的目录的缺省值（非负整数，缺省 0）。根目录必须事先存在，且不能落在池根里；同一目录重复出现时下限必须一致。新建时在状态锁内选择空间最多且满足该目录下限的候选，写入槽位 `path`。同一池正在新建的槽位按各自下限进行保守的同文件系统预留，检出前再次检查空间。没有合格候选则失败，不回退到未配置的盘。

槽位一律记录实际绝对路径，后续不随配置迁移；改 roots 只影响后续新建。状态里缺 `path` 的旧槽位不再按池根/slots 解析，直接报迁移错误，按 [多盘说明](../multi-disk-pool.md) 的“从旧布局迁移”处理。空间下限不是工程大小预测或运行期间的容量保证。

### 稀疏规则

`[sparse]` 是一张 depth 映射表，内部只有这一种模型：

- 根目录 depth 由 `root` 给出，不能为 `exclude`。没有 `[sparse]` 段等于 `root = "infinity"` 且不列任何路径，即完整检出。
- 列出的路径取列出的 depth。未列出的路径从父目录继承：父目录为 `infinity` 时子目录也是 `infinity`；否则子目录不在磁盘上（父目录为 `immediates` 时以 `empty` 出现）。
- 列出路径的各级祖先，按继承本来不会出现的，自动建成 `empty` 空壳，不用写出来。上例中 `client`、`client/Assets` 就是空壳。
- 列出路径落在某个 `exclude` 路径之下、同一路径写两种 depth，都是配置错误。
- 白名单（`root = "empty"` 加若干 `infinity`）下，分支上新增的顶层目录不会被下载；黑名单（`root = "infinity"` 加若干 `exclude`）下则会。按工程选择。
- 列出了但当前分支上没有的路径跳过，并在结果里记一条说明，不算失败。

兼容写法：`exclude = ["a", "b"]` 等价于 `root = "infinity"`，且 `[sparse.depth]` 里 `"a" = "exclude"`、`"b" = "exclude"`。`exclude` 不能和 `root`、`[sparse.depth]` 同时出现。

已有精简工程时，用 `capture-sparse` 从工作副本导出这张表，贴进 `pool.toml` 即可复刻。

## 目录与状态

```
<池根>/
  pool.toml              用户配置
  branch/<分支>          指向槽位的链接（Windows 用 junction，其他平台用符号链接）；只在挂槽且目录存在时才有
  patches/<分支>/<时间>/ 改动存档：changes.patch + 未纳管文件清单
  .pool/state.json       槽位状态
  .pool/lock             状态锁
  .pool/cache/           候选分支列表缓存
  .pool/history.jsonl    占用与释放历史（candidates 的“最近使用”来源）

<storage 根>/            [storage].roots 中的任一目录，可在其他盘
  s01 .. sNN             SVN 工作副本（槽位），实际路径记在状态的 path 里
```

分支名转目录名时把 `/`、`\`、`:` 等替换为 `_`，状态里保留原名。

槽位状态：

| 字段 | 说明 |
| --- | --- |
| `id` | `s01` 等 |
| `path` | 新建时记录的实际绝对目录（在某个 storage 根下），必填；后续不随配置迁移 |
| `branch` | 当前所在分支，空表示刚建 |
| `url` | `svn info` 读到的 URL，用于校验 |
| `phase` | `ready` / `switching` / `blocked` / `retiring` |
| `lease` | `{ until, tag }`，`until` 为 `forever` 或时间戳；空表示没有租约 |
| `lastUsed` | 最近一次占用时间 |
| `blockedReason` | `blocked` 时的原因 |
| `holds` | 持有保护：`{ <holdId>: { at, label?, path } }`，`path` 为建立时校验过的实际目录；空表示没有保护 |

“空闲”不是存储的状态，而是推导出来的：`phase = ready`、没有租约或租约已过期、没有持有保护。因此租约过期不依赖 gc 及时运行。工程清单里的分支所在的槽位同样可以是空闲的，它们只在挑选顺序上排在后面。

租约和持有保护是两回事：租约表示“这个分支我要用一段时间”，到期自动失效；持有保护表示“外部应用（IDE、Unity、OSGLauncher 等）此刻正打开着这个目录”，不看时间、不看调用进程是否还活着，只能由同一 `holdId` 的 `unhold` 解除。两者都会让槽位不被切换或回收，互不清除。

### 并发

- 本包自己维护 `.pool/lock`，所有读写 `state.json` 的操作都在锁内完成，锁内只做读改写，耗时操作（switch、checkout、删除）放在锁外，用槽位 `phase` 标记占位。
- 锁文件带 pid 和时间；持有进程已不存在时视为残留并接管。
- 所有本包工具都不声明 `requiresExclusiveWorkspace`。agent 的路径锁按 cwd 字符串加锁，不会解析链接，管不住槽位；以本包的锁和 `phase` 为准。
- 已知限制：其他包的 svn 工具通过 `branch/<分支>` 操作同一槽位时，本包看不到。处理方式：本包遇到工作副本被锁时，先检查是否有 svn 进程占着这个工作副本，有就把本次操作标为失败并说明原因，不执行 cleanup，避免破坏正在运行的 svn。

## 工具清单

除 `capture-sparse` 外，所有工具的 cwd 都是池根。平台：全平台；涉及释放占用的部分只在 win32 生效。

### 查询工具（`kind: "query"`，ADR-0020）

只读，15 秒内返回，结果写在 result json 的 `choices` 里。

| 工具 | 用途 | 内容 |
| --- | --- | --- |
| `candidates` | “开分支”的候选项 | 依次为：池中已有的分支（hint：就绪 / 已占用到某时 / 受保护及持有者 / 落后 N）、工程清单里还没挂槽的（hint：工程清单加需要怎么分配）、`history.jsonl` 最近使用的、`listFrom` 下最近有提交的（hint：需切换、需新建槽位、需切换（会换出工程槽位）或池满）。按 value 去重 |
| `occupied` | “释放分支”的候选项 | 当前有有效租约的分支，hint 为到期时间和标签 |
| `status` | 全池状态 | `choices` 为空，`detail` 为人读摘要（含每个槽位的实际目录和未挂槽的工程）；另在 result json 的 `pool` 字段给出结构化状态（`projects` 工程清单、`storage`、`slots`），供内置会话和 OSGLauncher 使用 |

`listFrom` 的 `svn ls -v` 结果缓存在 `.pool/cache/`，10 分钟内直接用缓存，保证查询不会因为网络慢而超时。远端列不出来时只返回本地部分，并在 hint 里说明。

### 执行工具

**`acquire`**，参数 `branch`（必填）、`ttl`（时长或 `forever`，缺省 `defaultTtl`）、`tag`（可选）。

选槽位的顺序：

1. 已有槽位在这个分支上（就绪或阻塞，且没有进行中的操作）：续租（新到期时间取较晚者），刷新 `lastUsed`，返回。分支正被另一个任务切换或更新时报忙。
2. 有不在工程清单里的空闲槽位：取 `lastUsed` 最早的一个，走“切换流程”。
3. 槽位数小于 `maxSlots`：走“新建流程”，由 [storage] 选定实际目录。
4. 有工程清单里的空闲槽位：取 `lastUsed` 最早的一个，走“切换流程”（换出的工程下次打开时再分配）。
5. 以上都不满足：失败，按 US7 列出现状。

有效租约、持有保护、阻塞和有进行中操作的槽位不会被选中。工程清单里的分支在容量允许时保持挂槽：有余量时宁可新建，也不换出空闲的工程槽位。

**`release`**，参数 `branch`。清除租约，写历史，不动文件。分支不在池里或没有租约时成功并标 `skipped`。不清除持有保护；槽位仍受保护时在 `detail` 里写出持有者。

**`hold`**，参数 `branch`（必填）、`holdId`（必填）、`expectedPath`（必填，绝对路径）、`label`（可选，给人看的说明）。外部应用打开工作副本前调用：

- 在池锁内一次完成：找到分支所在槽位，确认 `phase = ready` 且没有进行中的操作，再确认槽位的实际目录（解析链接后）就是调用方看到的 `expectedPath`，然后写入 `holds[holdId]`。任何一步不满足都失败且不写入，调用方应刷新后重新确认，避免保护错槽位。
- `holdId` 由调用方决定，1–200 个可见字符，首尾不能有空白；建议带调用方前缀，如 `osglauncher:<项目>`、`osgtoolset:operation:<pid>`。同一 `holdId` 重复调用只刷新时间与说明。
- 分支须已在池里（先 `acquire`）。不创建、不续租租约，不动文件。

**`unhold`**，参数 `branch`、`holdId`（必填）、`confirmClosed`（布尔，必须为 true）、`releaseLease`（布尔，缺省 false）。

- `confirmClosed` 不为 true 时按用法错误拒绝（退出码 64），dry-run 同样校验。
- 只删除这个 `holdId`，其他持有者不受影响，`detail` 写出剩余持有者。
- `releaseLease` 为 true 时同时清除租约（等同再调一次 `release`，写历史）。
- 分支不在池里或该 `holdId` 不存在时什么都不改，成功并标 `skipped`，可重复调用。

**`gc`**，无参数。

- 推进中断恢复，并校正池外改动（见“池外改动校正”）。
- 复查阻塞槽位：工作副本恢复正常后设为 `ready`，`branch` 记为实际分支；实际分支已在别的槽位上时保持阻塞，写明重复的槽位，等人切回或解除保护后交给池回收，不当成空闲槽位换出。
- 槽位数超过 `maxSlots` 时，从空闲槽位里删除多出的：先删不在工程清单里的，再按 `lastUsed` 从早到晚，删除前走“改动存档”。受保护的槽位不算空闲，等保护解除后再回收。
- 同步 `branch/` 入口（补建缺失的，删除失效的），清理超过 30 天的 patch 存档（天数可在配置中用 `patchRetentionDays` 调整）。
- 汇总报告：恢复与校正、解除阻塞、仍阻塞、已回收、待缩容的槽位和入口变化。

**`refresh`**，无参数。对工程清单里的每个分支：

- 已挂在槽位上：`svn update`，再按 `[sparse]` 重新应用稀疏规则，最后读回落后 revision。
- 没挂槽：跳过，报告“未挂槽（按需占用时分配）”。refresh 不新建、不切换、不为工程抢槽位。
- 被占用、受保护、阻塞或正被别的任务处理：跳过并报告原因，不抢。

任一工程失败不影响其他工程，最后按失败数决定退出码。`projects` 为空时什么都不做并标 `skipped`。

**`capture-sparse`**，参数 `path`（必填，现有工作副本目录，相对路径按 cwd 解析）。只读，不需要 `pool.toml`。

- `svn info -R --show-item depth` 读出每个目录的实际 depth，逐行解析，不把整份输出留在内存里。
- 只保留跟继承结果不一致的目录：`infinity` 目录下的 `infinity`、`immediates` 目录下的 `empty` 不列出；下面还有列出路径的空壳也不列出。
- `immediates` 目录下没有 `empty` 子目录（子目录都单独设过）时，视为 `infinity` 展开节点。
- `detail` 输出可直接贴进 `pool.toml` 的 `[sparse]` 片段。

### 切换流程

1. 锁内把槽位 `phase` 设为 `switching`，记下目标分支；删除旧分支的链接。
2. 改动存档（见下）。
3. Windows 上释放占用：复用 `shared/occupants` 释放该槽位目录的占用进程，IDE 只请求正常关闭。释放不掉就恢复 `phase = ready`、恢复链接，失败返回。
4. `svn switch <url>`，然后按 `[sparse]` 重新应用（switch 保留各目录已设的 depth；目标分支新增的目录按继承规则补设，列出了但分支上没有的路径跳过）。
5. `svn info` 校验 URL。成功则锁内设 `ready`、写 `branch`、`url`、租约，建新链接。

### 新建流程

1. 锁内占一个新槽位号，选择 storage 落点并写 `path`，`phase = switching`；空间不足或目标已有内容则拒绝，不删已有目录。锁外复查容量、exclusive mkdir，成功后记录 `op.created`，防止中断时误删未经确认的目录。
2. 稀疏检出：根目录按 `root` 检出（下面还有列出路径的 `infinity` 目录先以 `immediates` 展开），再从根逐层调整：
   - 列出的目录设到列出的 depth；
   - 非 `infinity` 目录下需要的空壳和列出目录逐个 `--set-depth` 带下来，`empty`/`files` 目录下不需要的子目录排除；
   - `infinity` 展开节点下未列出的子目录设为 `infinity`，列出 `exclude` 的设为 `exclude`；
   - 同一层按 depth 分批，每批最多 50 个路径。

   这样不需要的目录从头到尾不会被下载。同一套逻辑也用于切换后与 refresh 后的重新应用，配置改了下次运行即按新规则收敛（包括改回完整检出）。
3. 之后同切换流程第 5 步。

第一版只做稀疏检出。“从已有槽位本地复制再切换”更快，但源槽位可能正被 Unity 或 IDE 占用，复制出的工作副本状态不可靠，留到后续评估。

### 改动存档

1. `svn status` 收集改动。
2. 受版本控制的改动（修改、添加、删除）：`svn diff` 写入 `patches/<分支>/<时间>/changes.patch`，再 `svn revert -R`。
3. 未纳入版本控制且未被忽略的文件：只把清单写入存档目录，不删除。它们阻碍 switch 时（svn 报 obstruction），槽位标为 `blocked`。
4. 冲突、树冲突、外部锁：不处理，槽位标为 `blocked`，原因写入 `blockedReason`。

被忽略的文件（如 `Library`）不在 `svn status` 默认输出里，池子不碰。

`blocked` 的槽位不参与选择，直到用户处理后由下一次 gc 复查恢复为 `ready`。

### 中断恢复

工具启动时，锁内检查所有 `phase = switching` 且记录的进程已不存在的槽位：

1. 工作副本被锁且没有 svn 进程占用：`svn cleanup`。
2. 读 `svn info`：URL 与目标分支一致，并且 `svn status` 没有未完成的操作，视为切换已完成，补建链接并设 `ready`；否则视为未完成，保持无链接，设 `ready`、`branch` 记为实际 URL 对应的分支，留给下一次 acquire 重新切换。
3. 读不出 `svn info`（新建中断）：删除已确认由本次操作创建的槽位目录。外置父目录不可访问或目录所有权未确认时保留槽位与目录并报告，不换盘重建。

本包遵循 ADR-0019 §5 的取消协议：收到取消后结束 svn 子进程，补跑一次限时 cleanup，写 result json 后以 130 退出，剩下的交给下一次运行的中断恢复。

### 池外改动校正

`acquire`、`refresh`、`gc` 在中断恢复之后校正池外改动，`status` 等查询工具不改状态。只读 `svn info`，不切换、不删除工作副本，只看没有进行中操作、所有权已确认的就绪或阻塞槽位：

- storage 根不可访问（如盘没挂上）：记一条说明，保留记录，不换盘重建。
- 槽位目录已被删除：没有持有保护就移除槽位记录；有保护就标为阻塞，保护解除后下次运行再移除。
- 目录还在但没有 `.svn`：标为阻塞，内容留给人处理。
- 被人在池外 `svn switch` 到别的分支：按实际分支记录，租约和保护跟着目录走（还有人在用）；实际分支不符合分支规则时记为未定。实际分支已在别的槽位上时，`branch` 置空并标为阻塞，由 gc 复查（见 `gc`）。
- 最后同步 `branch/` 入口：只有分支挂在就绪或阻塞的槽位上且目录存在时入口才存在；补建缺失的，删除指向不存在槽位、目录已不在或与状态不符的链接。只删链接，不碰真实目录。

### 结果

result json 在 ADR-0019 的 `detail` 之外增加：

- `summary`：一句话，如“release_1.12 就绪（s03，切换，落后 0）”。
- `pool`：仅 `status` 与 `acquire` 返回，结构化的槽位信息，供内置会话使用。

进度按 ADR-0019 §4 输出，svn 的文件计数复用 versionControl 的解析。

## 配套：general/unity-open

现有 `general/unity-warmup` 以 `-batchmode -quit` 运行，会阻塞到导入结束，不能用来打开编辑器给人用。新增 `unity-open`：

- 参数：`projectPath`（相对 cwd 的 Unity 工程目录，缺省 `.`）。
- 复用 `src/unity.ts` 的 `readProjectVersion`、`resolveUnityEditor` 和 `shared/occupants` 的 `isUnityLockHeld`。
- `Temp/UnityLockfile` 被占用时视为已经打开，成功并标 `skipped`。
- 以非 batchmode 方式启动，`detached`、不继承 stdio、不加入 CLI 的进程组，启动后立即返回。取消步骤不会关掉 Unity。
- 不声明 `requiresExclusiveWorkspace`、`lowPriority`。平台：win32、darwin。

打开 IDE 不新增工具，用 target 的 `script` 或 `openPath` 步骤。

## 依赖与排期

| 编号 | 内容 | 依赖 | 验收 |
| --- | --- | --- | --- |
| P6 | workingCopyPool 包骨架：manifest、配置读取与校验、状态文件、锁、`status` | 无 | 单测覆盖配置校验、锁接管、空闲推导 |
| P7 | `acquire`、`release`：切换流程、新建流程、改动存档、链接 | P6 | 用本地 `svnadmin create` 建的临时仓跑通：新建、切换、带改动切换后能从 patch 恢复、池满报错 |
| P8 | `gc`、`refresh`、中断恢复、池外改动校正 | P7 | 单测模拟 switching 残留；临时仓上验证缩容、已挂槽工程的更新、池外 switch 与目录被删的校正 |
| P9 | `candidates`、`occupied`（`kind: query`） | P6；在 agent 实现 ADR-0020 前可以发布，但只有升级后的 agent 能用作候选项 | 查询 15 秒内返回；远端不可达时返回本地部分 |
| P10 | `general/unity-open` | 无 | Windows 上从 agent 磁贴启动，步骤立即结束，取消任务不影响 Unity |
| P11 | Windows 实机验收：真实 OSG 池，跑通“开分支”、“s2pub 开工”、夜间维护 | P7–P10，agent 侧 ADR-0020 | 按 US1–US11 逐条过 |

本 PRD 之外、需要 novoard-agent 仓完成的：

- ADR-0020 落地（契约 2.6、`resolveInputs`、inputs 接口、控制台选择框，以及 manifest 的 `kind` 字段）。agent 目前不校验 manifest 里的未知字段，所以旧 agent 装了带 `kind` 的新包不会报错。
- 内置会话：`novoard_run_target` 增加 `vars`；新增查询候选项的工具。

Hub 来源清单新增第三条：git 指向本仓，subdir `packs/workingCopyPool`。

## 风险

- `svn switch` 跨差异很大的分支时，耗时可能接近重新检出，需要在 P11 用真实分支实测。
- 稀疏规则如果写错，新建槽位会下载大量美术资源。dry-run 打印根目录 depth、按 depth 分组的列出路径和自动空壳；已有精简工程的，优先用 `capture-sparse` 导出而不是手写。
- Windows junction 指向的目录被 IDE 打开时，删除 junction 可能失败。切换流程把删除链接放在释放占用之后重试一次，仍失败就中止。
- 长路径：OSG 工作副本较深，storage 根应尽量短（如 `E:/osgpool-slots`），README 中写明。
