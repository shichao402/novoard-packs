# novoard-packs

novoard-agent 的通用能力包。协议见 novoard-agent 仓 `docs/adr/0019-capability-pack-protocol.md`。代码从 cronkit 迁出（决策见 Novoard 仓 ADR-0012）。

开工前先看 Novoard 仓 `docs/roadmap/roadmap.md`「跨仓：cronkit 吸收」表，确认依赖项已完成；做完一项回那张表改状态。

## 包含的能力包

- `versionControl`：svn 更新、还原、清理、切换、复制、删除，以及 git 操作。
- `general`：unity 预热、空闲退出（如 Rider）、释放占用进程。

两个包放同一个仓库，是因为它们共用一套"哪个进程占着文件"的检测代码（`shared/occupants`）。这段代码在编译期分别打进两个包，运行时两包互不依赖。

## 目录

```
packs/versionControl/  toolset.json  src/  dist/pack.mjs  scripts/
packs/general/         toolset.json  src/  dist/pack.mjs  scripts/
shared/                exec.ts  occupants.ts  paths.ts  time.ts  types.ts  validate.ts  scripts/*.ps1
tests/                 vitest 用例（从 cronkit 移植）与 manifest 快照
scripts/build.mjs      打包、生成 toolset.json、复制 ps1
```

- 每个包的 manifest 写在 `packs/<id>/src/manifest.ts`，`toolset.json`、`dist/`、`scripts/` 都由 `npm run build` 生成并提交，不要手改。
- `npm run check` 依次跑 tsc、vitest、build，再要求 git 无变化；CI 跑的就是它。
- 包入口 `src/index.ts` 导出 `manifest` 与 `run(toolId, params, ctx)`，直接执行时走 `shared/cli.ts` 的 argv CLI：

```
node packs/<id>/dist/pack.mjs <tool> --project-root <p> [--dry-run] [--result-json f] [--param-kebab v]
```

- 退出码：0 成功；1 工具执行失败；64 参数错误（未知参数、缺值、类型或枚举不合法）；99 意外错误；130 收到 SIGTERM 或 SIGINT 后取消。参数错误时如果给了 `--result-json`，同样写入结果文件。
- result json 字段为 `detail`，以及可选的 `skipped`。进度以单行 JSON `{"type":"progress","message","percent"?}` 写到 stdout。每次运行的日志写到 `<tmp>/novoard-packs/`，非 dry-run 时 stdout 会打印路径。

Hub 来源清单配置两条，git 都指向本仓：

- `versionControl`，subdir `packs/versionControl`；
- `general`，subdir `packs/general`。

## 任务

| 编号 | 内容 | 验收 |
| --- | --- | --- |
| P1 | 仓骨架：TypeScript，esbuild 把每个包打成单文件 `dist/pack.mjs` 并提交；CI 检查 dist 与源码一致 | `npm run build` 后 git 无变化 |
| P2 | versionControl：移植 cronkit `src/core/svn.ts`、`svn-status.ts`、`git.ts`；manifest 从 cronkit `toolset/builtin.ts` 对应条目转写 | 移植 cronkit `tests/svn-status.test.ts` 并通过；Windows 上对真实工作副本跑 svn-update，结果与 cronkit 一致 |
| P3 | general：移植 `unity.ts`、`idle-quit.ts`；release-occupants 作为独立工具；shared 移植 `occupants.ts`、`exec.ts`、`paths.ts` | 移植 `tests/occupants.test.ts`、`idle-quit.test.ts`、`warmup-observe.test.ts`、`exec.test.ts` 并通过 |
| P4 | 已完成。统一 CLI：`node dist/pack.mjs <tool> --project-root <p> [--dry-run] [--result-json f] [--param v]`，退出码与结果文件按 ADR-0019 | 用 novoard-agent 夹具测试脚本对每个工具跑一次 |
| P5 | 已完成。进度：svn-update 输出阶段与文件计数，unity-warmup 输出导入百分比 | agent 控制台能看到步骤内部进度 |

## 迁移规则

- remoteWrite 工具（svn-switch、svn-copy、svn-delete）删除 `confirmRemoteWrite` 参数，改由 agent 审批。
- svn-update 的 releaseOccupants 直接调用 shared/occupants，不经过 general 包。
- platforms：
  - versionControl 全平台；
  - general 中 quit-idle、release-occupants 只支持 win32，unity-warmup 支持 win32 与 darwin。
- 本仓不放任何内网地址与项目专用工具。项目专用工具放各自项目的能力包（如工蜂 OSGToolset）。
