# PRD：workingCopyPool 能力包（工作副本池）

- 状态：草稿，待审阅
- 日期：2026-11-16
- 讨论来源：2026-11-16 与用户讨论 OSG 多分支工程的磁盘管理。结论：池子是独立的通用能力包，放在本仓，由 novoard-agent 调度；交互入口全部复用 agent 现有机制（磁贴、带 inputs 的磁贴、内置会话、定时）
- 依赖：novoard-agent 仓 ADR-0019（能力包协议）、ADR-0020（磁贴运行时输入与查询工具）

## 背景

大型 SVN 工程（以 OSG 为例：全量约 700GB，去掉美术资源后约 30GB）需要同时跟进 5 个以上分支。按目录手工管理工作副本，磁盘很快被占满，也说不清哪个目录是哪个分支、还要不要。

workingCopyPool 把一组工作副本收成一个池：用户只说要哪个分支，池子负责找一个工作副本切过去，用完归还，过期自动回收，常驻分支每天保持最新。用户不再关心工作副本放在哪个物理目录。

手工管理的工作副本不在池子范围内。池只操作自己在状态中登记的槽位：缺省位于池根/slots，也可以在 [storage].roots 明确授权的本机专用目录中创建；不扫描、不收编、不覆盖其他目录。

## 目标与非目标

目标：

- 按分支占用和释放，入口是固定路径 `<池根>/branch/<分支>`，与槽位无关。
- 槽位数量由配置决定，不按磁盘自动推算。新槽位可按 [storage] 分配到多个盘，旧槽位的实际路径保持不变。
- 本地改动在切换或删除前一律存档，不会被冲掉。
- 常驻分支每天更新，不在池里时自动准备。
- 只做通用池化逻辑，不含任何项目专属规则。项目差异全部写在池根的配置文件里。

非目标：

- 不管理槽位里的构建产物和编辑器缓存（如 Unity `Library`）。对池子来说它们只是目录内容，需要按分支缓存时由项目能力包（如 OSGToolset）另行提供工具。
- 不做交互界面。用户入口由 agent 的磁贴、选择框和内置会话提供。
- 不做跨机器共享池。
- 不收编池外已有的工作副本（后续再议）。
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

**US1 建池。** 在池根放一份 `pool.toml`，第一次执行任何 pool 工具时自动建出目录结构和状态文件。池根下除 `pool.toml` 外的内容都由池子管理。

**US2 按分支占用。** 选一个分支，几秒到几十分钟后 `branch/<分支>` 可用。分支已在池里时立即返回，只续租。结果里写明用了哪个槽位、是新切的还是已有的、离最新落后多少个 revision。

**US3 临时租约自动回收。** 占用时给保留时长（缺省取配置 `defaultTtl`）。到期后槽位变成可复用，不需要人手释放。

**US4 手动释放。** 从“当前占用中”的候选里选一个释放。释放只改记录，不动文件，工作副本留在原分支上，下次再要这个分支时不用切换。

**US5 常驻分支保持最新。** 配置里列出的常驻分支永不被淘汰。夜间 refresh 把它们更新到最新；不在池里的，用空闲槽位准备好。没有空闲槽位时报告“未就绪：池满”，不抢有效租约。

**US6 本地改动不丢。** 槽位被切换或删除前，受版本控制的改动先导出成 patch 存档，再还原。存档按分支和时间存放，可以找回。

**US7 池满时说清楚。** 没有可用槽位且已到上限时，占用失败，列出每个槽位的分支、租约到期时间和标签。

**US8 中断后能恢复。** 切换中途被取消、超时或机器重启，下次操作这个槽位时先恢复，不会让虚拟路径指向一个切了一半的工作副本。

**US9 缩容。** 把 `maxSlots` 调小后，多出来的槽位在空闲时由 gc 删除（删除前同样存档改动），有租约的等租约结束。

**US10 看全池状态。** 查询每个槽位的分支、状态、租约、标签、本地改动摘要、落后 revision 和最后使用时间。agent 磁贴和内置会话都用它。

## 配置：`<池根>/pool.toml`

```toml
# 槽位上限，按需调整
maxSlots = 6
# 不指定保留时长时的租约
defaultTtl = "1d"
# SVN 仓库根
svnRoot = "https://svn.example.com/osg"
# 常驻分支（用分支名，见 aliases）
resident = ["s2pub", "exp", "live"]

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

### 多盘存储（2026-11-23）

可选 `[storage] roots = [本机绝对专用目录, ...]` 与 `minFreeGiB = 非负整数`。根目录必须事先存在；新建时在状态锁内选择空间最多且满足准入阈值的候选，写入槽位 `path`。同一池正在新建的槽位按此阈值进行保守的同文件系统预留，检出前再次检查空间。没有合格候选则失败，不回退到未配置的盘。

缺省 roots 为池根/slots，阈值为 0。旧槽位没有 path 时仍按旧布局解析，新槽位一律记录实际绝对路径；改 roots 不迁移旧工程。空间阈值不是工程大小预测或运行期间的容量保证。完整配置、恢复与降级边界见 [多盘说明](../multi-disk-pool.md)。

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
  slots/s01 .. sNN       缺省位置的 SVN 工作副本；多盘新槽位可以在外部 storage 根中
  branch/<分支>          指向槽位的链接（Windows 用 junction，其他平台用符号链接）
  patches/<分支>/<时间>/ 改动存档：changes.patch + 未纳管文件清单
  .pool/state.json       槽位状态
  .pool/lock             状态锁
  .pool/cache/           候选分支列表缓存
  .pool/history.jsonl    占用与释放历史（candidates 的“最近使用”来源）
```

分支名转目录名时把 `/`、`\`、`:` 等替换为 `_`，状态里保留原名。

槽位状态：

| 字段 | 说明 |
| --- | --- |
| `id` | `s01` 等 |
| `path` | 新建时记录的实际绝对目录，缺省兼容池根/slots/id；后续不随配置迁移 |
| `branch` | 当前所在分支，空表示刚建 |
| `url` | `svn info` 读到的 URL，用于校验 |
| `phase` | `ready` / `switching` / `blocked` / `retiring` |
| `lease` | `{ until, tag }`，`until` 为 `forever` 或时间戳；空表示没有租约 |
| `lastUsed` | 最近一次占用时间 |
| `blockedReason` | `blocked` 时的原因 |

“空闲”不是存储的状态，而是推导出来的：`phase = ready`、不是常驻分支、没有租约或租约已过期。因此租约过期不依赖 gc 及时运行。

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
| `candidates` | “开分支”的候选项 | 依次为：池中已有的分支（hint：就绪 / 已占用到某时 / 落后 N）、常驻分支、`history.jsonl` 最近使用的、`listFrom` 下最近有提交的（hint：需切换，或需新建槽位）。按 value 去重 |
| `occupied` | “释放分支”的候选项 | 当前有有效租约的分支，hint 为到期时间和标签 |
| `status` | 全池状态 | `choices` 为空，`detail` 为人读摘要；另在 result json 的 `pool` 字段给出结构化状态，供内置会话使用 |

`listFrom` 的 `svn ls -v` 结果缓存在 `.pool/cache/`，10 分钟内直接用缓存，保证查询不会因为网络慢而超时。远端列不出来时只返回本地部分，并在 hint 里说明。

### 执行工具

**`acquire`**，参数 `branch`（必填）、`ttl`（时长或 `forever`，缺省 `defaultTtl`）、`tag`（可选）。

选槽位的顺序：

1. 已有槽位在这个分支上：续租（新到期时间取较晚者），刷新 `lastUsed`，返回。
2. 有空闲槽位：取 `lastUsed` 最早的一个，走“切换流程”。
3. 槽位数小于 `maxSlots`：走“新建流程”。
4. 以上都不满足：失败，按 US7 列出现状。

有效租约和常驻分支所在的槽位不会被选中。

**`release`**，参数 `branch`。清除租约，写历史，不动文件。分支不在池里或没有租约时成功并标 `skipped`。

**`gc`**，无参数。

- 推进中断恢复（见下）。
- 槽位数超过 `maxSlots` 时，从空闲槽位里按 `lastUsed` 从早到晚删除多出的，删除前走“改动存档”。
- 清理指向不存在槽位的链接，以及超过 30 天的 patch 存档（天数可在配置中用 `patchRetentionDays` 调整）。
- 汇总报告：已回收、阻塞、待缩容的槽位。

**`refresh`**，无参数。对每个常驻分支：

- 在池里：`svn update`，再按 `[sparse]` 重新应用稀疏规则，最后读回落后 revision。
- 不在池里：按 `acquire` 的槽位选择规则准备，但不创建租约。
- 被占用或阻塞：跳过并报告原因，不抢。

任一常驻分支失败不影响其他分支，最后按失败数决定退出码。

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
| P8 | `gc`、`refresh`、中断恢复 | P7 | 单测模拟 switching 残留；临时仓上验证缩容与常驻更新 |
| P9 | `candidates`、`occupied`（`kind: query`） | P6；在 agent 实现 ADR-0020 前可以发布，但只有升级后的 agent 能用作候选项 | 查询 15 秒内返回；远端不可达时返回本地部分 |
| P10 | `general/unity-open` | 无 | Windows 上从 agent 磁贴启动，步骤立即结束，取消任务不影响 Unity |
| P11 | Windows 实机验收：真实 OSG 池，跑通“开分支”、“s2pub 开工”、夜间维护 | P7–P10，agent 侧 ADR-0020 | 按 US1–US10 逐条过 |

本 PRD 之外、需要 novoard-agent 仓完成的：

- ADR-0020 落地（契约 2.6、`resolveInputs`、inputs 接口、控制台选择框，以及 manifest 的 `kind` 字段）。agent 目前不校验 manifest 里的未知字段，所以旧 agent 装了带 `kind` 的新包不会报错。
- 内置会话：`novoard_run_target` 增加 `vars`；新增查询候选项的工具。

Hub 来源清单新增第三条：git 指向本仓，subdir `packs/workingCopyPool`。

## 风险

- `svn switch` 跨差异很大的分支时，耗时可能接近重新检出，需要在 P11 用真实分支实测。
- 稀疏规则如果写错，新建槽位会下载大量美术资源。dry-run 打印根目录 depth、按 depth 分组的列出路径和自动空壳；已有精简工程的，优先用 `capture-sparse` 导出而不是手写。
- Windows junction 指向的目录被 IDE 打开时，删除 junction 可能失败。切换流程把删除链接放在释放占用之后重试一次，仍失败就中止。
- 长路径：OSG 工作副本较深，池根应尽量短（如 `D:/osgpool`），README 中写明。
