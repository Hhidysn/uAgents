# Codex CLI Target — v1 设计

## 目标

将本机已安装、已登录的 Codex CLI 作为 uAgents 的独立 `codex` target 接入现有 Task / Council / CLI / Unified MCP。uAgents 只负责批准模型路线、启动 native 进程、记录会话及执行结果；不实现另一个 Codex agent loop。

本机确认基线：`codex-cli 0.153.4`；npm package `@openai/codex` 的 `bin.codex=bin/codex.js`，`node <bin.js> --version` 可用。`codex exec --json` 支持 stdin prompt（`-`），`-m` 显式模型，`-C` 指定工作目录。`codex exec resume/fork` 存在，但 v1 不做跨 Task 会话映射。

## 用户 contract

- target `codex`：analysis、implementation，text 与 workspace_readable，text/file outputs（通过现有 expected_outputs 捕获）。
- 首个批准 model selector：`gpt-6-astra`；`route_id=codex/gpt-6-astra`，`provider=codex`。仍需显式选模型，不提供 default、不从本机发现结果自动批准新模型。
- `models codex` 在未有稳定 no-prompt native catalog 时展示 configured-only 模型；`probe codex --model gpt-6-astra` 只运行 `--version`，不发送 prompt，也不证明 provider 实际可用。
- v1 不声明 native file/image inputs、resume/fork。用户可通过 workspace 读取文件，但这不等于 native file attachment。
- 无新权限执行模式：沿用 Codex CLI 登录、配置和原生权限处理，不加 `-s`、`--approve-for-me` 或 `--dangerously-bypass-approvals-and-sandbox` 等默认标志。

## Transport

Host locator 将 `%APPDATA%\\npm\\codex[.cmd/.ps1]` 或 npm package 的 `bin/codex.js` 归一到实际可直接执行的 JS entry，使用已有 HostStore 文件指纹/缓存；不通过 shell 启动 shim。无已验证安装时允许与其它 CLI 一致的本机 package/path 查找，不安装/登录。

每个新 Task 启动一次 `process.execPath <codex.js> exec --json --model <model_resolved> --cd <workspace> -`。任务文本通过 stdin 一次性写入，内容包含 workspace、mode、expected outputs 及 prompt。不给 argv 放任务正文。直接读取 stdout JSONL，stderr 只作为过程诊断，不混入响应正文。

协议关注：`thread.started(thread_id)` 提供原生会话 ID；`item.completed(item.type=agent_message, text)` 提供最终文本候选；`turn.completed(usage)` 表示一次 turn 正常完成；`turn.failed(error)`、`error`、异常退出/无终态属于失败或发送后不确定。必须先观察到匹配 native session 和 terminal turn，再发布成功；不推断 `model_reported`（CLI JSON 事件没有可靠的所选模型自报字段），故 `model_verified=false`。

Task worker 在 stdin 写入前持久化 `possibly_sent` checkpoint；拿到 native thread ID 时发布 `accepted` checkpoint。一次提交失败/进程异常退出后不自动重放。发送后 cancel 关闭本地进程，并返回 remote state unknown；不声称远端模型已经取消。观察窗口使用现有 `observation_timeout_ms`，有界 stdout/stderr JSONL。

## 集成与证据

- 新增独立 `transports/codex-process.mjs` 与 `adapters/codex/adapter.mjs`，复用 `TaskService`、worker checkpoint、artifact capture、Council member，不引入 Codex SDK 依赖。
- 新增 `registry/builtins` route、`agent-locator`、adapter dispatch、模型列表 configured-only、User Skill 与 current/reference docs。
- Fixture 测试必须覆盖 argv 无 prompt、stdin 写入、thread/turn 正常完成、thread ID 更换、失败/无 terminal、取消/超时、probe 未发送、TaskService 集成和 Host locator npm shim 解析。
- 本轮实现阶段只做无 prompt CLI/version smoke 与 mock JSONL，真实 provider 调用需要另行明确授权。

## 后续独立功能

Codex `exec resume` / `fork`、native image `-i`、可能变化的 native model catalog、跨进程 journal 恢复、Codex 专用授权/UI 交互等，等真实 CLI E2E 证据后再单独设计；不提前在 v1 capability 中宣称。
