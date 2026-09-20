# Codex CLI target v1 验证

日期：2026-09-19。设计记录：[Codex CLI target v1](../history/superpowers/specs/2026-09-19-codex-cli-target-design.md)。

## 当前 contract

- `target=codex`、显式 `model=gpt-6-astra`，无默认模型；analysis / implementation、text + workspace、existing expected_outputs。
- 使用 Windows npm package 的 `@openai/codex/bin/codex.js`，通过 `node codex.js exec --json --model ... --cd ... -` 启动，prompt 只写 stdin；不加新的 sandbox、自动审批或 bypass 参数。
- JSONL `thread.started.thread_id` → persisted native session；`item.completed.agent_message` → response；`turn.completed` + 0 exit + 非空 text → success。
- 不伪造 Codex 的 model self-report：`model_reported=null`、`model_verified=false`。不开放 native attachment、跨 Task continuation/fork。

## 本机 no-prompt smoke

本机安装的 Codex：`codex-cli 0.153.4`。通过本机 `node ...\\@openai\\codex\\bin\\codex.js --version` 输出 `codex-cli 0.153.4`。

从当前仓库源码运行：

```text
node plugins/uagents/bin/uagents.mjs targets
node plugins/uagents/bin/uagents.mjs capabilities codex
node plugins/uagents/bin/uagents.mjs models codex
node plugins/uagents/bin/uagents.mjs probe codex --model gpt-6-astra
node plugins/uagents/bin/uagents.mjs ensure codex
```

结果：`targets` 包含 `codex`；能力 `transport=cli-jsonl`、`model_selection=explicit`；`models` 返回 configured-only `codex/gpt-6-astra`，`provider_availability=unconfirmed`；`probe` 返回 `status=succeeded`、`scope=version_only`、`submission=not_sent`、`version=0.153.4`。

`ensure` 验证 npm package JS 入口并将 SHA-256 安装指纹存入 HostStore，不通过 `.cmd` shell shim，也不自动登录、安装或发 prompt。

## 回归

专项 `tests/codex-cli.test.mjs`：8/8 PASS。覆盖 stdin prompt/argv、模型参数、版本 probe、session identity、checkpoint、success/failed/unknown、cancel/timeout 与发送前 checkpoint 失败。

`tests/unified-cli-adapters.test.mjs` 中的 Codex TaskService fixture 通过，覆盖 implementation 模式、session ID、usage、response 以及 `expected_outputs` artifact capture。Host locator npm shim fixture 通过。

```text
Core (--test-concurrency=4) 345/345 PASS
Doubao MCP                 11/11 PASS
TRAE MCP                    9/9 PASS
Unified MCP                14/14 PASS
```

标准高并发 `npm test` 两次并非全绿：首轮 Core 342/344（OpenCode delayed-session 10 秒与 short-lease heartbeat），第二轮 342/345（两条 OpenCode durable 10 秒 fixture 与 stderr 64 KiB 边界 fixture）；这些旧 fixture 隔离运行 23/23 PASS，本轮未修改其 Runtime。最终新增测试后低并发 Core 345/345 PASS。

本轮没有执行 Codex/其它 Agent 的真实 provider-bearing prompt，因此不声称 `gpt-6-astra` 已通过新 adapter 的真实端到端模型验证。Native `--version` 与 configured route 不代表 provider 额度/登录在线状态已经由 uAgents 验证。

## 本机安装版验收

新插件 build：`0.2.0-alpha.1+codex.20260919181436`，通过 `codex plugin add uagents@personal --json` 正常安装，Codex 返回的新 active cache：

```text
C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260919181436
```

Repo / personal marketplace source / installed cache 的 142 个插件发布文件逐一 SHA-256 对比一致：source mismatch 0、cache mismatch 0。源码和 installed-cache Plugin validator，以及两者 Skill validator 均通过。

安装后直接从 cache 运行 `targets`、`models codex`、`probe codex --model gpt-6-astra`，确认第七个 target 已出现，configured route 正确，probe 返回 `0.153.4 / version_only / not_sent`。另运行 `tests/plugin-package.test.mjs`，1/1 通过。

此安装验收同样**未发送任何模型 prompt**。Git commit/push 不在本轮用户授权范围内。
