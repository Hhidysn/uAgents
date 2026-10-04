# L1 实际分发失败调查

日期：2026-10-04，Asia/Shanghai。调查对话为 `01a10245-452f-7893-a58f-f84efbad9b59`（重新分析正式游戏框架需求），L1 原始记录在 `F:/documents/software/aiGame/third-party/_analysis/l1-runtime-plan-2026-10-04/`。调查开始时 uAgents 已有未提交的 V2 回执修复；本次在该工作树上补充恢复错误的处理，不覆盖前次改动。

## 确认的结果

| 原任务 | 原生证据 | uAgents 原状态 | 判断 |
| --- | --- | --- | --- |
| DeepSeek `cb2202ff-e45f-4e68-8a87-67ec343d55db` | session `ses_ef96ba1e0ffesHn4jXTfMR0zxr`；4轮完成10次只读工具调用；随后 `provider.invalid-request` / HTTP400；exit1；session outcome failed | failed，无正文 | 实际原生失败，不是提交未送达。错误 response.body 为空，不能断言具体请求字段、附件或上下文上限是原因。 |
| GLM `beb93c7f-e0e4-44ca-97e2-5bb8f51d95de` | session `ses_ef96e08b7ffeRqWK7E04VMTf1Q`；9次read；中途 HTTP200 / `provider.invalid-output`，确切原因 `OpenAI Chat stream ended without finish_reason`；随后原生生成新消息，最终 outcome succeeded，9116字符正文，模型 `opencode-go/glm-5.3-flash`；exit1 | failed，保留正文，模型未确认 | uAgents 错把可恢复的中途错误当最终失败。原生完成不代表建议满足原任务全部阅读证明和设计验收。 |

两项都只提交一次，未因本次调查重发。执行时限均20分钟、观察时限15分钟；这两次终止由原生错误触发，没有执行超时证据。先前仅返回固定短文本的成功记录不足以覆盖多轮工具和中途流恢复。

## 修复

原 parser 的 `nativeError` 一旦出现便始终优先返回 failed；V2导出补证只在 exit0 / unknown / 缺 step_finish 时执行。因此，GLM 新消息已完成并 idle 的更强证据被跳过。

现在记录错误所属消息。仅在错误之后出现不同的新消息、存在正文、exit0或1且没有审批等待时，允许同 session 的只读导出证明恢复。仍严格核对 workspace、最终 assistant message ID、成功 outcome、无最终错误、完成／idle时间、provider/model与stdout正文。失败读取、身份／正文不符、最终错误、其它退出码与审批等待均不提升为成功。原始错误仍保留在原生日志；不靠清空错误或HTTP200猜成功。

历史 Task 的 terminal 状态按当前合同不可改写，本次不修改数据库、不把原 failed 强制改成 succeeded。后续新调用使用修复；旧 GLM 的更正结论由此记录提供。

## 验证与安装

本地证据位于 `.local/verification/l1-dispatch-20261004/`。`replay.mjs` 只读原stdout和已有原生session，不提交模型prompt、不续接、不启动第三方研究。原始export只在内存中使用，落盘摘要不含正文、headers或凭据。

- 新增回归先运行失败，复现未查询成功终态的旧行为。
- `node --test --test-concurrency=1 tests/opencode-v2-completion.test.mjs tests/cli-transports.test.mjs`：36/36通过，覆盖普通和durable调用的exit1恢复、同一Attempt、模型持久化，以及证据不匹配、最终错误、审批等待的负例。
- `node .local/verification/l1-dispatch-20261004/replay.mjs`：原始真实GLM日志修复前 failed、修复后 succeeded 且模型匹配；同一DeepSeek日志始终 failed。`baseline.jsonl` 与 `fixed.jsonl` 保存摘要。
- 当前技能对应安装副本同步driver与OpenCode参考文档，保留原文件备份并核对SHA。已运行的MCP进程不会被本次强行重启；新的本地CLI进程读取修复后的模块。

本次没有新增真实Provider调用，不声称DeepSeek HTTP400已修复，也不声称GLM计划通过内容验收。安装与源码hash见本机证据目录的 `manifest.json`。
