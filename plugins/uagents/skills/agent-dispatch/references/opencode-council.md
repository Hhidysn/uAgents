# OpenCode：独立文本提案与会审

只在选择 OpenCode 或多模型讨论时读取。本版支持原生 run + JSON 事件，不需要独立 MCP 或常驻服务；Windows 实测 1.18.13。

## 路线和环境

target=opencode、mode=analysis。目前仅接入用户已授权常用的两条路线：opencode-go/deepseek-v4-flash、opencode-go/glm-5.2。其他模型仍可由用户以后显式接入，本版不会自动消耗其额度。GLM 不可用时保留失败/未知结果，不替换模型。

CLI 从 PATH 中查找原生可执行文件；Windows 也识别 npm 目录下 node_modules/opencode-ai/bin/opencode.exe。自定义位置可用 UAGENTS_OPENCODE_BIN 指定绝对原生可执行路径；不把 .cmd/.ps1 丢进 shell 转发，不读或复制凭据。

原生命令为 run --pure --model <路线> --format json --dir <任务目录> --title <任务标识>，prompt 通过 stdin 发送。--pure 禁用外部插件，不等于强制只读。不传 --auto、--continue、--session 或 --share；每次有意提交都是独立会话。底层原生设置仍适用。

## 一次调用

```json
{
  "request_id": "替换为新UUID",
  "target": "opencode",
  "model": "opencode-go/deepseek-v4-flash",
  "mode": "analysis",
  "prompt": "只依据以下材料给出独立建议，不调用工具、不访问文件、不再委派：……",
  "timeout_ms": 180000
}
```

使用本 Skill 的 scripts/agent-call.mjs，先 submit --request <JSON绝对路径> --state-dir <插件外绝对路径>，再 status/result --id <request_id> --state-dir <同目录>。能力查询为 capabilities --target opencode。无需读其他目标的参考文件。

## 多模型讨论步骤

1. Codex 先记录自己的初步方案和关键假设，再阅读候选答案。
2. 写一份共同 brief，包含事实、约束、评价维度和输出要求；独立阶段不传主线程或其他候选的答案。每个候选使用相同 prompt，但使用不同 UUID 和所选模型。
3. 分别 submit，保存本地 task ID 与返回的 native_session_id。由 Codex 或当前宿主已有的调度助手跟进；不要依赖一个长时间阻塞的 shell 调用。
4. result 取回后检查题目一致性、session 相互独立、终态和文本归属。一个失败不否认其他候选的结果，也不自动换付费路线补齐人数。
5. 可匿名为 A/B 做比较，但保留本地路线映射。按证据综合；没有看过实现的候选说“缺少某机制”，只是待核查意见，不能直接当成代码缺陷。
6. 只有实质分歧需要补充时才明确启动下一轮。当前不是自动循环辩论器，不会自行增加模型、轮次或继续委派。

## 完成判定

OpenCode 没有 WorkBuddy 式的顶层 final result。适配器校验所有事件/part 的 session ID，按 part ID 去重；每次 step_start 清除前一步文本，即使 messageID 相同也不沿用。只回收最后 stop 步对应 messageID 的文本，并要求原生进程正常退出。tool-calls 中间步骤、非零退出、错误事件、截断、混合会话都不能算成功；权限拒绝返回 needs_user 或无法解析时 unknown。

JSON 事件不回显实际模型；model_requested 保存明确传入的路线，model_reported=null 表示没有独立运行期证明，不能把它写成已验证实际模型。也不根据 token/cost 字段断言免费。

取消/超时只停止当前持有的本地进程；没有远端确认时报告 unknown，不自动重发。原生会话查询/续接不是本版的自动恢复功能。probe 仅 --version，不验证账号、模型可用性或余额。

依据：[OpenCode CLI](https://opencode.ai/docs/cli/)、[实测版本 run.ts](https://github.com/anomalyco/opencode/blob/v1.18.13/packages/opencode/src/cli/cmd/run.ts)。源码用于核对事件协议，本插件不打包 OpenCode 源码或凭据。
