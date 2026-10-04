# OpenCode V2 回执与执行时限修复

日期：2026-10-04，Asia/Shanghai。起始 HEAD 为 `8a66d5eccbe66ac74b732f4e55c06fd8a036235f`，仓库起始干净。本次证据对应未提交工作树；源码与安装副本 hash 清单在 `.local/verification/opencode-v2-20261004/manifest.json`。Node 24.13.0，Windows，OpenCode 2.0.21。

## 问题与改动

真实 V2 调用输出 `step_start`、`text` 后退出 0，没有 V1 的 `step_finish`。旧 parser 报完成未知，且按不存在的最终消息筛选后丢失答案。现在在这一特定路径读取同一 session 的原生导出，核对 workspace、最终 assistant message ID、完成及 idle 时刻、provider/model、与持久 stdout 完全一致的最终答案。读取有 5 秒、8 MiB 限制；原始导出不落盘。失败、外来会话、旧消息和不完整证据不变成成功，部分文本会保留。普通与 durable transport 均等待异步核查；同 Attempt reconcile 不发送新 prompt。

V2 的错误字段为顶层 `type/status`，旧代码只解析 V1 `name/data.statusCode`。现在两者兼容，保留 HTTP 状态与原生错误类型，丢弃响应正文／headers／凭据；明确 `provider.quota` 的 HTTP429归为 `quota_exhausted`。

V2 默认服务可在 CLI 被终止后继续执行。设置 `execution_timeout_ms` 的新任务自动用 `--standalone` 私有服务，拒绝冲突 `--server` 或禁用 standalone 的参数，使已有双 guardian 的拥有进程树停止逻辑覆盖实际执行。保留保守 `indeterminate/execution_timeout`，不称 Provider 已确认取消。

## 已执行检查

`node --test --test-concurrency=1 tests/opencode-v2-completion.test.mjs tests/cli-transports.test.mjs`：31/31通过，包括身份／终态不匹配、失败读取、部分答案、脱敏、私有服务参数、普通调用和同 Attempt durable 恢复。

`node --test --test-concurrency=1 tests/durable-cli-execution.test.mjs tests/opencode-durable-recovery.test.mjs tests/unified-cli-adapters.test.mjs tests/plugin-package.test.mjs`：45/45通过，包括观察进程死亡、guard、双 guardian、续接／fork fixture、错误保留、其它 CLI target 及无 node_modules 插件包。不是完整仓库回归。

`node --test tests/adapter-contract.test.mjs tests/registry-policy.test.mjs`：26/26通过。合计102项定向测试通过；最终31项parser／transport与26项合同结果分别留在本机验证目录的 `targeted-final.txt`、`contracts-final.txt`。

`npm --prefix plugins/uagents/mcp/unified run build` 完成。相关源码和 portable bundles 同步到本次技能提供的已安装插件路径，原文件备份在本机验证目录；同步使用 hash 清单核对。Git diff whitespace 检查通过。

## 当前安装副本的真实模型调用

全部在独立目录要求无工具、无文件操作，仅返回 `UAGENTS_V2_FIXED`。

| route | task | 实际结果 |
| --- | --- | --- |
| `opencode-go/deepseek-v4.1-flash` | `4f9ea382-5ba6-4c6f-915b-2ea91b71308f` | `succeeded`，完整固定文本，模型自报匹配 |
| `opencode-go/glm-5.3-flash` | `b40b278d-d2a3-4fc8-8e1c-0005972bed60` | `succeeded`，完整固定文本，模型自报匹配 |
| agy `gemini-3.8-flash-medium` | `01d1c976-82e5-4c47-99ba-5ff4dca261c8` | `succeeded`，完整固定文本，模型自报匹配 |

修复前的小诊断任务 `1d04a77e-1ef7-4ef0-a719-910db4c381fd`、`1c04d237-d1a7-427c-8166-dac58b577815` 均用原 UUID 执行 reconcile 恢复为 `succeeded`，Attempt ordinal仍1、Attempt ID不变；没有提交新 prompt。

真实执行时限任务 `f13ce0f8-412b-4c94-8cb5-64581191f89e` 在隔离目录运行前台120秒Node诊断命令，配置15秒硬时限。命令确实启动；guardian证据显示 `termination_confirmed=true`，native root退出，workspace guard释放，诊断子进程已不存在，完成标记未生成。实际状态为 `indeterminate/execution_timeout`。证据和检查脚本在本机验证目录。

## 额度与剩余边界

aiGame历史 `google/gemini-3.8-flash` 会话 `ses_efa588971ffeFp5cE0Kun6tsTG` 的 HTTP429明确报告 `GenerateRequestsPerDayPerProjectPerModel-FreeTier`、`generate_content_free_tier_requests`、当时额度20。这是该 Google API项目／模型的免费层配额，不能解释为 agy CLI订阅额度。uAgents不设置请求次数或token限额，非空 `max_cost_usd` 在发送前拒绝；本次无账户、凭据或计费修改。

三条最小调用成功不证明长实现、附件或真实 V2 continuation/fork的全部行为。原生进程停止不证明Provider取消确认；旧共享服务任务的deadline证据不会自动改写。已运行的长期 MCP进程可能仍加载旧模块，后续重启时加载安装副本；本次真实调用走新的本地CLI进程。

## 提交复检

复检对象仍为 `8a66d5eccbe66ac74b732f4e55c06fd8a036235f` 上的本次工作树，同时包含 [L1 错误恢复修复](2026-10-04-l1-dispatch-errors.md)。检视发现并修正普通 transport 将 parser 已核实的模型覆盖为 null，以及显式 variant 核实后回报遗漏 variant 的问题；两个回归用例均先复现失败、修正后通过。新测试文件已纳入 `npm test` 和 `npm run test:unified`。

- 首次串行执行 `tests/opencode-v2-completion.test.mjs`、`tests/cli-transports.test.mjs`、`tests/durable-cli-execution.test.mjs`、`tests/opencode-durable-recovery.test.mjs`、`tests/unified-cli-adapters.test.mjs`、`tests/adapter-contract.test.mjs`、`tests/registry-policy.test.mjs` 和 `tests/plugin-package.test.mjs`：107/107 通过。
- 普通模型持久化修正后，`node --test --test-concurrency=1 tests/opencode-v2-completion.test.mjs tests/cli-transports.test.mjs tests/unified-cli-adapters.test.mjs`：61/61 通过。
- variant 修正后的最终源码，`node --test tests/opencode-v2-completion.test.mjs`：14/14 通过，包括两个新增用例。上述检查覆盖 109 个不同用例。
- `npm --prefix plugins/uagents/mcp/unified run build` 成功，bundles 内容与起始版本一致；随后 `node --test tests/plugin-package.test.mjs`：3/3 通过。
- 8 份变更文档的 33 个本地链接、8 个 JS 文件语法、两个标准测试入口及 `git diff --check` 通过。

最终被测源码 SHA256：

| 文件 | SHA256 |
| --- | --- |
| `cli-base.mjs` | `35ff3b25a14902171bd56328bbb784ccc822ac91c2c0158d8a13329935810f52` |
| `opencode-driver.mjs` | `004192544232e8b73448c69a064dc46e0a7260706701d12bf8156db44f4ae6c0` |
| `opencode-session.mjs` | `f0dca3cf5205d429facd3835641ba1f76e8af45545b87c87611b20328b1bf230` |

复检使用隔离 fixture，设置 `UAGENTS_AUTO_CHECKIN=0`，未新增真实模型调用、领取积分、更新安装副本或重启 MCP 进程。前面的安装和真实调用为原有实测记录；复检不将其算作最终源码的新调用验收。
