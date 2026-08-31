# WorkBuddy 与 OpenCode 接入验证

日期：2026-08-31。环境：Windows、Node 24.13.0、WorkBuddy 内嵌 CLI 2.132.0、OpenCode 1.18.13。用户在 agy 切片后要求继续执行，沿用此前取消强制只读、允许有界文件写入的授权。插件版本 0.1.0-alpha.3，未安装。

## 验收与结果

验收标准：WorkBuddy 有真实任务与可核对产物；OpenCode 两个常用模型在同题独立上下文返回；插件持续查询、区分终态和未知、防重复提交；不改全局/认证配置，不自动切换模型或安装依赖。

| 路线 | 本地 task ID / 原生 session ID | 结果 |
| --- | --- | --- |
| WorkBuddy 默认路线 | `1415ab8a-7030-4327-ad7b-6e1c5bff7d6b` / 同一显式 UUID | 原生 success、exit 0、文件验收 passed；init 报告 auto、acceptEdits |
| OpenCode DPF | `e9e0973d-1cb7-485f-869c-6a843aa93a13` / `ses_fa791894bffe4oCVTJDnK8bUR4` | succeeded、step_finish(stop)、exit 0，完整独立建议 |
| OpenCode GLM-5.2 | `3f8b301a-b28e-4ccd-af37-0993721cb317` / `ses_fa791886affe878k9klGtIcsP4` | succeeded、step_finish(stop)、exit 0，完整独立建议 |

WorkBuddy 产物为 `.local/verification/plugin-state/1415ab8a-7030-4327-ad7b-6e1c5bff7d6b/workspace/verification.txt`，25 字节，内容为 `UAGENTS-WORKBUDDY-FILE-OK` 加换行，SHA-256 `e9f69e7a4f6e0c608a3c2777bd59bccecb4385d7c5ac2c8b254b2015acb38160`。主线程再次读文件核实，没有代替 WorkBuddy 写产物。

两位 OpenCode 候选通过插件正式 submit/status/result 入口运行，prompt 内容相同，SHA-256 `0c4858c4e2995809b2a1d681f9c423631cda71e86c5d5d13d0a289706f3f12db`；UUID 与原生会话不同。请求路线分别为 opencode-go/deepseek-v4-flash 和 opencode-go/glm-5.2；该事件流不回显实际模型，因此 model_reported 为 null，不冒称独立验证了底层模型。

此前另有一次 DPF 协议探测，原生 session `ses_fa79788d4ffem150yfGOMDHvLA`，返回预期 UAGENTS-OPENCODE-OK 与 stop，exit 0。它用于核对事件格式，不冒充插件正式入口的验收。

再次对已完成的 WorkBuddy 和 DPF 请求使用原 UUID/原 JSON 调用 submit，均返回 duplicate=true，原生 session、worker_pid 与完成时间保持不变，没有启动替代 worker。正式 probe 也分别返回 version_only / not_sent：WorkBuddy 2.132.0（task `3461f38f-acfd-4478-b1cb-312e0a4435af`）、OpenCode 1.18.13（task `10fa9da0-ce84-419f-a752-57f4e1c7b690`），不发送模型提示词。

## 原生机制的取舍

先读本机帮助、WorkBuddy 附带 headless/daemon/cli-reference 文档，以及 OpenCode 对应版本的公开 run.ts，再做小范围实测。没有引入 npm 依赖或另写后台服务。

WorkBuddy 原生 --bg 探测使用专用名称 `uagents-probe-cce1d8ef-3613-448e-89ec-bfa013e5fe15` 与同 UUID session-id，启动命令退出 0，报告 PID 25580 和专属日志。后续 logs <name> 返回 Session not found；该任务日志存在但为 0 字节，ps --json 未返回有效 JSON。不能据此判断远端是否收过任务，也不能推断后台机制在所有环境都不可用；此探测标记完成未知，没有自动重放。正式文件任务是不同内容的新验收任务。

当前 WorkBuddy 采用 -p + stream-json + --verbose，由已有逐任务 worker 持续读到进程退出。显式 session UUID；implementation 单次 acceptEdits；不传 -y、fallback-model 或认证覆盖。公开变量 CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS=1 用于单轮结果边界，避免首个 result 后仍有模型派生后台任务。

OpenCode 采用原生 run --pure --model <route> --format json --dir <workspace>。该命令已有进程内服务和原生 session，无需再常驻 serve。提示词通过 stdin 输入；不传 auto/continue/session/share。Windows 从 PATH/npm 布局寻找原生 opencode.exe，不经 .cmd/.ps1 拼接命令。

两个目标在送入输入之后才产生可用身份事件，所以先记录 may_have_been_sent，再事后核对；与 agy 先 init 后发送的行为明确区分。CLI 缺失时准确报错，不自动安装。

## 会审综合

主线程先把自己的选择写入 `.local/verification/cli-council-brief.md`，候选只收到共同事实/约束/输出要求，没有互看答案或看到主线程方案。候选输出由主线程检查原始 result。

- A 接受按需 CLI 方案，重点提醒失败、超时和崩溃必须有明确结果，建议并发重复提交验收。
- B 接受独立会话方案，提醒提交前要有幂等账本，未知状态禁止重发，建议重启后的回收检查。
- 这些是基于题目事实的设计意见，不是仓库代码审计。现有 task/store 已实现 UUID 独占目录、摘要冲突、提交前登记、可能发送状态、结果落盘和 stale→unknown；回归测试包含这些路径，不能把候选的“缺少”描述直接当成仍未修复的缺陷。
- 不采纳自动重启未知任务或仅凭 session 存在恢复运行的推断。关闭 Codex、系统重启、原生远端取消确认与自动会话恢复仍未验证。

## 自动验证与边界

`npm test` 运行原有 29 项和新增 22 项，共 51 项，全部通过。新增覆盖：明确路线和不支持模型拒绝、Windows npm 原生入口发现、WorkBuddy UUID/cwd/result 校验、权限拒绝及后台任务状态、OpenCode 最终 step 文本选择与 part 去重、混合会话、错误/非零退出/截断、两个目标的 detached 回收、去重、版本探测、畸形流、超时与取消。

独立代码审查后补强四个边界：已登记取消在 CLI 定位前返回；登记后超过 15 秒仍无 worker 启动确认时返回 worker_launch_unconfirmed，同一请求不得重放；进程停止后的 error 不覆盖原有取消/超时原因；OpenCode 每次 step_start 清除前一步文本，即使 messageID 被重复使用，也不能把中间规划当成最终答案。对应回归测试均通过。登记与进程启动并非原子操作，启动间隙采用明确报告未知、不自动重放的策略，不宣称进程必定启动或具有 exactly-once 执行保证。

收紧步骤边界后，用此前真实 OpenCode 协议探测保留的去敏事件重放新解析器，仍返回 succeeded 和 UAGENTS-OPENCODE-OK；没有为此再次请求模型。Plugin 与 Skill 官方本地校验脚本均通过，Git 空白检查通过。

模拟测试不消耗模型额度。真实调用则是用户授权的现有路线；WorkBuddy 报告 auto，未核实底层模型或每日积分，OpenCode token 元数据也不能证明免费。没有读取、打印或修改密钥/认证文件，没有切换供应商兜底。

所有临时请求、结果和测试产物在 Git 忽略的 `.local/verification/` 与 `.local/test-runs/`。全局 AGENTS.md 和用户 .gitignore 的 SHA-256 与执行前相同。没有个人市场注册或 MCP 声明；TRAE、豆包 MCP 及安装分发仍在后续阶段。

来源：[OpenCode CLI](https://opencode.ai/docs/cli/)、[v1.18.13 run.ts](https://github.com/anomalyco/opencode/blob/v1.18.13/packages/opencode/src/cli/cmd/run.ts)；WorkBuddy 本机安装包的 dist/web-ui/docs/cn/cli/headless.md、cli-reference.md、daemon.md 和当前 --help。生产插件不依赖调研归档或这些文档所在的本机路径。
