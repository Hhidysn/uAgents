# 当前 Runtime 与生命周期

uAgents 使用统一 Task runtime 管理 CLI、SDK 和桌面 target。用户层面需要关注的是幂等、状态恢复、Agent 安装发现和受管实例生命周期。

## 幂等与发送状态

- 同一 UUID + 同一有效请求不会重复发送。
- 外部发送前持久化 `possibly_sent`。
- 一旦 prompt 可能已经发送但终态不确定，uAgents 不会自动换 UUID、模型或 Provider 重放。
- `status`、`result`、`list` 只读取本地持久化状态。

## Agent 安装

```text
uagents ensure <target> [--refresh]
uagents probe <target>
uagents stop <target>
```

`ensure` 发现、验证并缓存本机 Agent 入口。CLI/SDK target 不需要 uAgents 自己安装 Provider；桌面 target 可以由 uAgents 使用专用 profile 启动或复用。

`probe` 不发送 Agent prompt。

## Resume / Reconcile

```text
uagents resume <task-id>
uagents reconcile <task-id>
```

这些命令用于恢复同一个 Task 的本地调度/观察，不会自动把原 prompt 再发一次。

OpenCode 在 Windows 上可以持久化 native process/transcript，并在 Worker 重启后继续观察。Observation timeout 或本地 observer cancel 不等于 Provider/native 已确认取消。

Codex 的 Windows/Astra 显式 app-server 路线保存原生 Thread/Turn 与进程证据；Worker 失联后只读复查原 Turn，不自动重新发送 Prompt。原生历史不足以证明终态时保持 `indeterminate`。Codex 的执行权限仍由其原生配置控制。

## Workspace

- workspace 重叠任务受本地 lease/fencing 约束。
- implementation output 可以按 `expected_outputs` 捕获为 immutable artifacts。
- 附件 snapshot 与 artifacts 都记录 SHA-256 evidence。

## Desktop target

Doubao/TRAE 使用受管隔离 profile。uAgents 不自动登录、不接管用户日常窗口，也不会把未知进程当作自己的受管实例停止。

## 开发门禁

核心回归：

```powershell
npm test
npm --prefix plugins/uagents/mcp/unified test
```

插件发布前还应运行 Skill validator、Plugin validator 和 `git diff --check`。历史具体命令与每次测试计数保存在 `docs/verification/`，不作为当前功能定义。
