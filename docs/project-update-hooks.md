# 项目更新前钩子

工作副本池不拥有项目生成物白名单，也不依赖其他能力包。需要在 `refresh` 更新前运行项目工具时，在池根 `pool.toml` 配置：

```toml
[hooks]
beforeUpdate = ["python", "/absolute/path/to/project-pack/toolset.py", "revert-generated"]
retryBlocked = false
```

`beforeUpdate` 是非空命令 argv 数组，最多 64 项，不含控制字符。使用 spawn 直接启动，不经过 shell。池向末尾追加 `--project-root <实际工作副本根>`。命令及脚本路径由设备管理员配置；推荐固定本机已安装能力包的解释器和入口绝对路径，避免 PATH 漂移。工具必须接受此参数，非零退出会阻止 SVN update。超时为工具上下文时间上限与十分钟的较小值。

`retryBlocked` 默认为 false，开启需要同时配置钩子。没有配置 `[hooks]` 时维持原有行为。

## 执行边界

- 只用于 refresh 更新已存在的常驻分支；缺少常驻分支仍走原有 obtain/create/switch 流程，不在根目录外层批量处理槽位。
- 在短暂 state 锁内标记槽位 `op.kind=update`；钩子和 SVN 更新在锁外执行，但 `op` 一直保留，其他池任务不得抢占。
- 租约有效、正在处理、非 ready/blocked 状态或目录所有权未确认时跳过，不运行钩子。
- 跨盘槽位沿用 state 中的实际 path，并检查存储父目录归属。
- 运行前检查 SVN 进程占用，释放本工程占用。占用释放失败时不运行钩子。
- 钩子成功后核对 SVN 冲突、树冲突、阻碍、锁及 switched 状态。残留问题会中止 update，保留现场。
- 明确启用 retryBlocked 时可以尝试项目定向修复；只有检查和更新全部成功才清除 blockedReason 并标记 ready。目录所有权未确认不会绕过。
- 钩子进度帧透传到卡片；普通输出进入日志。取消时发送标准 `{"type":"cancel"}` stdin 行并停止进程树，中断槽位留给原有恢复流程。
- 钩子失败、超时或取消不能退化为整库 revert，不会忽略失败继续更新。

## 安全约束

项目包自行维护最小白名单，禁止将可再生目录扩展到真实源码或整个工作副本。该配置可以执行本机命令，只允许设备管理员编辑，不应从远端分支或未经校验的网页文字自动生成。通用池源码和公开仓库不包含任何内网地址、项目名或资产清单。
