# TRAE 与豆包工作 MCP：方案比较与下一步

日期：2026-09-01。本文先记录检索与本地源码审查结论；随后已按建议实现并真实验证豆包 MCP，见[实施记录](../verification/2026-09-01-doubao-mcp.md)。插件仍未安装，TRAE 接入未实现。

## 结论

保留一个 Plugin + 一个调度 Skill 的方向，但不再预先认定必须自研两个 MCP。此次官方文档检索发现 TRAE 已有 `traecli exec`、`mcp-server`、`acp` 等外部调用入口：应先核实账号、Windows 支持及额度是否满足用户目的，再决定是否保留 TRAE CDP 桥接。两个 MCP 即使保留，也是两个服务边界，不是两套重复基础设施。CDP 本身并不强制要求 MCP。

- TRAE：官方 CLI 满足现有账号与额度需求时，优先纳入现有 Skill/CLI 调用层；若确有 MCP 需要，先验证官方 `mcp-server`，不要为 CLI 再自造 MCP。只有官方路线不适用时，才优先复用 TRAECNclaw 的 MCP/网关/任务闭环。
- 豆包工作：先证明完整任务可提交、可归属、可判定结束，再用官方 MCP SDK 与现有 CDP 库封装最小应用适配器。
- 共享状态字段、错误分类和验收规则；仅提取实际重复的小函数。不强迫 TRAE 的成熟队列迁移到 CLI worker，也不为两个应用新建一套总调度服务。

## 已比较的路线

| 路线 | 证据与适用范围 | 建议 |
| --- | --- | --- |
| TRAE 官方 CLI / MCP | 官方命令文档列出非交互 exec、JSONL 输出、最终消息文件及 stdio mcp-server，属于被外部调用的接口 | 第一优先核实；不能由此推断与桌面客户端共享每日免费积分 |
| TRAECNclaw | 本地源代码已有 MCP→HTTP 网关→CDP、任务 ID、幂等检查、持久化队列和结果回收 | 官方路线不适用时的复用候选，须先厘清源码来源与补丁 |
| Microsoft Playwright MCP | 官方提供 CDP 连接、页面操作和快照；不是 TRAE/豆包专用任务协议 | 适合验证页面与选择器，不直接把通用点击工具当成最终任务接口 |
| 官方 MCP SDK + Playwright/CDP 库 | 复用协议和浏览器连接，仅自行编写应用任务语义 | 豆包工作优先候选；确切依赖版本、许可证与实际连接兼容性在实施时锁定 |
| 豆包聊天网页 / 模型 API / 同名第三方工作室 | 对象与桌面 DoubaoWork 不同 | 不能拿这些方案的成功替代桌面 Agent 验收 |

Playwright 官方说明 connectOverCDP 只支持 Chromium，且能力完整性低于原生 Playwright 连接。因此豆包自定义协议页面、iframe、下载与文件选择需实测，不能由 Chromium 内核直接推断全部兼容。必要时使用已有 CDP 库补少量缺失操作，不先自写完整 CDP 客户端。

TRAE 官方资料中 PAT 自动化登录有企业版旗舰套餐限制；不能把此限制推断为全部 CLI 登录都只支持企业账号，也不能反过来声称当前个人账号可用。是否支持当前 Windows 环境、能否使用现有订阅/每日积分、CLI 与桌面能力是否等价，仍是选型前置验证项。豆包工作方面，本轮有限的一手资料检索未找到可直接复用的桌面任务入口；这不是不存在的证明。

## TRAE 本地复用审查

以下路径均相对 `third-part-research/traecnclaw/`，结论限定于当前本地副本：

1. `src/http/handlers/unified-agent.js`、`src/http/task-orchestrator.js` 已处理任务受理与幂等；`src/http/task-store.js` 有落盘和跨进程存储锁，可保留。
2. `src/http/gateway.js:263` 的 UI 锁是实例内 Promise 链，不是跨进程窗口锁。需保证同一受控窗口只有一个控制者；锁过期不能直接抢占仍可能运行的任务。
3. `src/http/handlers/task-actions.js:361` 会在尝试停止后直接标记 cancelled，即使停止失败。对外应区分取消请求、已确认停止、远端状态未知。
4. `src/config/quickstart.js:86` 的 Windows 退出按应用镜像名执行，可能影响其他实例。插件默认仅连接已准备好的窗口，不自动结束应用或为开启 CDP 重启它。
5. `src/http/recovery-helper.js` 会依据 submittedToTrae 等状态恢复队列。需要专门测试“界面已发送、提交确认未落盘”的间隙；发送不明时不得自动重发。现有幂等记录有保留期限，不能宣称永久 exactly-once。

归档副本不是干净上游快照：本轮 `git status` 再次确认 LICENSE/README 修改及大量未跟踪源码。本地 package 元数据和许可证声明 MIT，不等于已证明全部新增文件的来源；正式引入必须逐项确定来源，保留通知和补丁清单，不能直接发布归档目录。

## 对外接口和内部职责

逻辑能力控制在五类；这是拟议契约，不是现成工具名。TRAE 已有工具优先做准确映射，不为了统一命名再包一层 MCP。

| 能力 | 职责 |
| --- | --- |
| probe | 报告版本、目标窗口和可用能力；不发送任务、不启动或重启应用 |
| submit | 校验 request_id/输入摘要、取得窗口占用、记录发送意图，提交后尽快返回本地任务 ID |
| status | 回收当前任务的运行、审批、完成或未知状态，允许有界的原任务重新核对，不自动重放 |
| result | 返回对应会话/消息的最终回复、产物和完成证据；不抓整个面板或其他历史会话 |
| cancel | 请求停止当前任务；无原生确认时明确报告未知，不把断开 CDP 当成远端停止 |

确有需要的服务优先使用本地 stdio 向 Codex 暴露接口。TRAE 内部已有 HTTP 网关可暂保留；多个 Codex 调用者应共享该应用的唯一控制权，而不是每个 MCP 都启动一个无协调的网关。内部端口仅回环，仍需鉴权和暴露面核查。豆包第一版不额外引入 HTTP 服务。

任务记录放插件安装目录外。返回共同字段：task_id、native_session_id（未知则明确为空）、window_id、状态、回复/产物、证据、错误及建议动作。不同应用可并行，同一受控窗口串行；用户手工切换会话或页面更新导致归属不明时停止自动操作并报告。

不向主模型暴露任意 evaluate、全部历史对话、读取认证信息或自动批准弹窗的通用入口。任务已授权写文件时沿用原生权限，不重新施加强制只读；具体敏感动作仍按当前授权处理。

## 验收顺序

1. **TRAE 官方入口优先。** 核实本机命令、操作系统、登录方式和账号/额度适用性。不为了验证而购买套餐、读取凭据或切换计费路线。符合目标则先做官方 CLI 小任务，沿用已有 CLI 适配框架；不符合才进入 CDP 分支。
2. **TRAE CDP 最小闭环（条件分支）。** 在准备好的专用窗口提交带唯一标识的短任务，验证返回任务 ID、正确回复和完成证据；再做指定文件产出验收。先验现有机制，再决定补丁规模。
3. **TRAE 故障边界。** 同 ID 重复提交只产生一次输入；两个调用者不争抢窗口；提交后断线不重发；取消未确认时为 unknown；审批等待正确返回 needs_user。
4. **豆包页面可行性。** 旧记录只证明输入框可写入/清除。先验证新任务、真实发送、原生任务/消息关联、最终答案与完成状态；不能用静默几秒或输入框清空单独判成功。
5. **豆包封装。** 闭环成立后实现上述最小接口和异常测试。若没有稳定的原生 ID，需以新建专属会话、唯一标识、提交前后消息边界构成可复核关联；无法可靠关联时返回 unknown。
6. **分发。** 仅把最终需要且已实现的 MCP 声明随同一个 Plugin 打包，参考说明按需读取；缺一个应用不影响其他路线。先验证可迁移路径和依赖，再注册安装。

不把 SDK 的实验长任务 API 作为运行机制前提。采用普通 submit/status/result 工具与本地记录，可以避免任务生命周期被某次工具调用绑住。MCP 官方 TypeScript SDK 当前主分支已是 v2，迁移资料明确移除了旧 experimental Tasks；旧教程不能直接作为新实现依赖依据。

## 一手来源与证据边界

- [TRAE CLI 命令行参数](https://docs.trae.cn/cli_command-line-parameters)、[CLI 2.0 快速开始](https://docs.trae.cn/cli_get-started-with-trae-code-cli-2)、[登录令牌](https://docs.trae.cn/cli_login-token)：外部调用入口与 PAT 适用条件，由独立网页调研核对；主线程重复抓取超时，未凭空补足账号/平台结论。
- [TRAECNclaw 分发镜像](https://github.com/Luckycat133/traecnclaw-mcp-skill)：公开 README 侧重 Mac 本地桌面；当前本机 Windows 副本不能直接等同其发布包。
- [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp)：CDP 参数与通用页面工具。
- [Playwright connectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)：连接能力与兼容性限制。
- [MCP 官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)：本地 stdio 与当前 SDK 结构。
- [SDK v2 迁移说明](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)：旧实验 Tasks 移除。
- [OpenAI 插件打包说明](https://developers.openai.com/plugins/build/plugins)：Skill/MCP 共同打包及服务独立策略。
- [本地资料索引](../research-index.md)、[现有设计](../superpowers/specs/2026-08-31-uagents-plugin-design.md)：源码来源记录及此前验收边界。

本轮网页检索部分请求发生网络错误；未因此推断候选不存在。官方文档能力、第三方项目声明、本地静态审查和真实运行通过分别记录，不互相替代。

本轮 `Get-Command traecli,trae,traecn` 未返回 PATH 可发现的命令；仅证明当前命令环境未发现这些入口，不证明整台机器未安装。未执行 CLI 登录或安装。
