# Codex CLI 跨 Task continue/fork 原型验收记录

日期：2026-09-23；仓库分支：`master`。**结论：内部 exec 桥接原型通过本地子进程 E2E；真实 Provider 多轮验收因额度限制未完成；不发布 Codex resume/fork capability。**

## 实现范围

- 不替换此前已验收的一次性 `codex exec --json --model <model> --cd <workspace> -`。
- 对 TaskService 已验证的源 Task/原生 UUID，`continue` 使用 `codex exec resume --json --model <model> <native-uuid> -`；`fork` 使用 `codex exec fork --json --model <model> <native-uuid> -`。这些子命令的 help 没有 `--cd`；spawn `cwd` 使用同一已核实 workspace。新 Prompt 始终只写 stdin，不使用 `--last`、`--sandbox` 或 bypass 标志。
- Codex Session 的源 Task 必须具有已确认的成功 native completed turn；新 Task 只允许从本地已接受的该 Thread 最新 Turn 派生，防止把历史 Task ID 错当作当前原生上下文边界。
- 续接 JSONL `thread.started.thread_id` 必须等于源 UUID；fork 必须不同；改变 ID 在发送后保持不确定而非成功。绑定缺失/无效 UUID 在发送前失败。
- 同一 `request_id` 的精确重复请求返回原 Task，而不是因来源线程之后被推进而拒绝或重发；其它 target 保持既有 session 语义。
- 这组原型通过测试注入内部 registry 打开，而公开 builtins **继续** `resume=false`、`fork=false`；没有更新发布插件版本或安装缓存。

## 无 Provider 验收

新增 `tests/fixtures/fake-codex-session-cli.mjs`：用真实 Node 子进程复现 Codex 新建、resume、fork、继续分支，记录各 native UUID、stdin Prompt、fork 祖先和执行次数，不接触模型提供方。

`tests/codex-cli.test.mjs`、`tests/unified-cli-adapters.test.mjs` 覆盖正确 argv、无 Prompt argv、session ID 一致/变化、无效来源/跨 workspace/跨 target/过期 source、未发送失败、TaskService 提交/重放。完整 fixture 路径为：

```text
new Task -> continue same Thread -> fork new Thread -> continue fork Thread
native calls = 4, repeated request_id -> duplicate without fifth call
```

最终回归：Core 测试以 `--test-concurrency=4` 运行 **357/357 通过**；Doubao MCP **11/11**、TRAE MCP **9/9**、Unified MCP **14/14** 通过（包含 MCP 预构建）。当前源码 `capabilities codex` 仍报告 `resume=false`、`fork=false`。`git diff --check` 通过；未重新安装或发布插件。

## 真实 Luna 尝试（未通过）

使用源码 TaskService + CodexAdapter、模型 `gpt-5.6-luna`，在 `.local/verification/codex-sessions-e2e/` 的隔离目录发起一个全新只读指令（后续 continue/fork 仅在前一步成功时启动）。源文件、运行库和 transcript 都留在 ignored `.local`，不纳入提交。

```text
request_id:       1a435b51-bd61-4826-880e-6b6f448cdea0
native_thread_id: 01a0ca1b-efd8-7463-8ac5-282186cea676
submission:       sent
status:           failed
native_outcome:   failed
error:            native_turn_failed
```

同一 Thread 的本机 Codex 原生会话日志包含 `task_complete.error.codex_error_info=usage_limit_exceeded`，CLI 当时显示 credits balance `0`、建议 `2:17 AM` 后再试；`codex login status` 仍为 `Logged in using ChatGPT`。这说明**本次 provider-bearing 首轮在额度检查处失败**，不能用它宣称 session bridge 成功或失败，也不能推断可立即重试成功。没有发送第二、第三、第四轮，也没有自动以新 UUID 重放。

## 发布门槛与剩余风险

1. 额度可用后，重新使用新的任务链做真实 `start → continue → fork → branch-continue`，断言上下文记忆与 native Thread identity；随后从正式安装插件缓存验收。
2. 不能声称 exec 桥接拥有可靠的跨进程 reconciliation、进程树终止、Turn 回执修复或 app-server 审批/事件能力。后续需检查并发中同一 Thread 的来源最新性及未决 Turn 保护；本原型目前不对外开放。
3. 图片/文件原生输入保持关闭；Codex JSONL 无可信模型身份自报，`model_verified=false` 仍是正确记录。

## 同日补充：排队后的来源复核

源码增加了 Codex session Task 在取得 workspace lease、完成 adapter 准备之后、发送 prompt 之前的来源复核。复核使用已持久化的来源绑定，拒绝已被其它 Turn 推进的源线程；若同一源 Task 的另一个请求可能已经发送但没有获得原生线程 ID，也拒绝新发送。后者保持原任务的不确定状态，不自动重放。

新增真实 Node 子进程 fixture 覆盖“两个续接及一个 fork 先排队，首个续接完成后其余请求发送前失败”和“前序 Prompt 已读取但没有 `thread.started`，同源后续请求发送前失败”。执行 `node --test --test-concurrency=4 tests/codex-cli.test.mjs tests/unified-cli-adapters.test.mjs`：**40/40 PASS**；`git diff --check` 通过。公开 capability 仍为 `resume=false`、`fork=false`，安装版插件未更新。

本机用量查询显示 `gpt-5.6-luna` 对应的推理额度窗口已用满；没有消耗重置额度或再次发送 Luna Provider Prompt。因此这次补充仍不构成真实多轮 Provider 验收。
