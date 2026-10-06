# Worker 初始化并发修复与 OpenCode Go 真实调用

Date: 2026-10-06 (Asia/Shanghai)

Revision: 基线 `1ac20c1562bf2e260e159eb6cc9bee288cdfc424` 加当前未提交工作树。Node.js v24.13.0，Windows；执行入口为仓库 `plugins/uagents/bin/uagents.mjs`，不是既有全局安装副本。

## 修复与定向验证

原问题：健康 Worker 尚在异步初始化适配器、未持有任务租约时，重复 Worker 的初始化失败可能将整个任务标为 `worker_start_failed`，使 `run` 提前返回 `run_not_started`；健康 Worker 随后仍可能发送 Prompt。

现在由 `runTask` 在取得任务与执行租约、认领 Attempt、启动心跳后执行初始化。重复 Worker 不初始化或写入错误；持有有效任务和执行租约的失败 Worker 记录可恢复错误并原子清除自己的 Attempt 认领信息。取消和所有权丢失在初始化结束后、发送前检查。

新增并执行四项回归：初始化超过短 TTL 时续约与重复 Worker；初始化失败后清除认领并恢复同一 Attempt；初始化成功/失败时的取消；旧 Worker 初始化成功/失败时丢失所有权。取消覆盖两个分支，所有权测试分别覆盖仅任务租约被替换、全部租约到期，共四个分支。初始化结果处理及外层失败记录都检查任务租约，旧 Worker 不能覆盖替换所有者的状态。

| 命令 | 结果 |
| --- | --- |
| `node --test tests/queue-recovery.test.mjs tests/package-distribution.test.mjs tests/cli-convenience.test.mjs` | 35/35 通过 |
| `node --test tests/runtime-state-machine.test.mjs tests/runtime-crash.test.mjs tests/workspace-locks.test.mjs tests/entrypoint-recovery.test.mjs tests/service-scheduler.test.mjs` | 56/56 通过 |
| `npm run test:pack` | 通过，157 个文件，20 项必需内容 |
| `git diff --check` | 通过，仅有现存 LF/CRLF 提示 |

最终独立任务租约校验补强后，将上述八个测试文件合并再执行一次，91/91 通过；真实 Provider 调用发生在该补强之前，随后没有重复付费调用。补强只增加所有权检查，不改变原生请求或模型参数。

## 本机配置调整

经用户授权，在 `C:/Users/24590/.config/opencode/opencode.json` 删除 `provider.agentrouter`，保留其它服务商及原有默认模型 `opencode-go/deepseek-v4.1-flash`；保存同目录 `.bak.remove-agentrouter-20261006` 备份并执行 `opencode reload`。认证文件原本没有 `agentrouter` 项，因此未修改。原生模型目录仍包含内置 `agentrouter` 名称，这不代表自定义配置仍存在；文件回读已确认自定义服务商删除。本次不确认原服务商到期原因，只记录上一轮原生 `provider.invalid-output` 失败。

## 真实 Provider 调用

通过 agent-dispatch 工作流执行两个独立新 Task，均使用 `opencode-go/deepseek-v4.1-flash`。此前失败 Task 保留，未重放或改变其状态。工作区和状态目录位于 `.local/verification/opencode-go-20261006/`，自动签到在测试进程内禁用。

| 场景 | Task ID | 结果与独立验收 |
| --- | --- | --- |
| 文件修改 | `17e064b4-0f93-46cd-a3b4-1ae7305abb0e` | `succeeded`；将占位 `sumIntegers` 实现为整数数组求和及类型校验，新建 `NOTES.md`；独立重跑 9 项断言通过；两个文件的捕获与 SHA-256 验证通过；sentinel 未变 |
| 中文话题讨论 | `b000b990-08a4-4566-8d44-28fe5e6ec6dd` | `succeeded`；返回 CLI/MCP 优点、代价、失败场景与有条件推荐；中文前缀完整；工作区仅含原 sentinel 且内容未变 |

两项均为 `submission=sent`、`model_reported=deepseek-v4.1-flash`、`model_verified=true`。讨论正文为 418 个字符，内容验收通过；400 字要求为软性长度约束，不计作严格字符数通过。

实际命令：`node .local/verification/opencode-go-20261006/run.mjs launch`（文件修改使用 `submit --request` 与声明产物，讨论使用 `run --prompt-stdin --no-wait`）；`run.mjs inspect` 读取并保存终态；`verify.mjs` 独立执行函数断言、文件范围、中文前缀和模型身份检查。详细请求、终态与验收 JSON 保留在该临时目录中。

本次未执行完整回归、OpenCode 多轮续接/分叉、其它模型或其它服务商调用；未更新既有全局安装的 uagents 副本。
