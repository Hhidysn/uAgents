# 首轮 CLI 与运行机制验证

日期：2026-08-31。环境：Windows，Node.js 24.13.0。用户授权：核对现有能力、必要模拟验证、agy 真实小任务验证及据实实施最小插件；不修改全局配置、不自动安装或换计费路线。

## 结果与未完成部分

本地任务运行机制已实现并通过模拟验证，skills-only 插件源码位于 `plugins/uagents/`。真实 agy 权限准入未通过，因此没有发送模型提示词，不能声称已跑通 agy 的实际任务或完成全部阶段 1。

仓库版本为 `0.1.0-alpha.1`，包含一个 Skill 和独立、可直接执行的 Node 脚本。没有 MCP 声明、个人市场注册、依赖安装或全局 AGENTS.md 修改。

## 原生能力核对

| 目标 / 本机版本 | 已核对的入口与能力 | 本轮未验证 |
| --- | --- | --- |
| agy 1.1.22 | `agy --help`、`--version`、`models`；print、stream-json、conversation ID、timeout、sandbox、自定义 agent | 实际文本任务、读取/修改文件权限、图像能力、续接、远端取消 |
| WorkBuddy 内嵌 CLI 2.132.0 | `node <WorkBuddy>/resources/app.asar.unpacked/cli/dist/codebuddy.js`；print、JSON/stream-json、resume、tools/permission-mode；原生 bg、ps、logs、attach、kill、serve、daemon | 后台存活、真实模型任务、实际工具限制、服务端鉴权及取消 |
| OpenCode 1.18.13 | `opencode run`、format json、session、serve、acp、attach；pure 仅禁用外部插件，auto 自动审批 | 本轮未重新发模型请求，未启动服务验证 REST/ACP 生命周期 |

WorkBuddy 与 OpenCode 的帮助核对由只读 explorer 完成。WorkBuddy 安装包自带 `cli-reference.md`、`http-api.md` 描述了 runs 的提交、查询、流和取消端点；这是本机文档证据，不能当成本轮已启动服务的证明。

决定：agy 先用每任务一个 worker；后续 WorkBuddy 优先验证原生后台机制，OpenCode 优先验证现有会话/服务能力。暂不创建统一守护服务、数据库或队列。

## 真实 agy 预检

使用全新、专用工作目录和项目级自定义 Agent 定义，没有读取或改写供应商认证文件。调用模式为 stream-json，先等待 init，不发送 user 消息。

- 模型清单返回了 `gemini-3.1-pro-low` 等路线；本轮固定该模型，不自动兜底。
- 第一次 `tools: []` 定义的初始化仍报告完整工具集合。随后改为显式 `view_file` 的探测遇到两次资格检查 EOF；在网络恢复后的最后一次无提示词探测中，显式列表仍返回完整工具集，会话 ID 为 `bb639e5f-fbad-4414-b71e-814a209c3bd3`。这不足以证明运行期实际白名单已受限。
- 使用插件正式预检入口再次验证后，返回 `blocked / text_only_permissions_unverified`、`submission: not_sent`、`tool_count: 57`。
- 该次原生会话 ID：`721fecd7-47a6-4a9b-9daa-5b26f2893bd3`；本地 task ID：`d69140e7-5354-4773-b10a-4c3df1099cbe`。两者明确区分。
- 插件实际确认了所请求模型与工作目录，并在检测到工具集合不能满足纯文本限制时停止子进程，没有发送提示词。

这证明当前预检能阻断不满足已约定限制的调用，不证明 agy 完全没有权限控制，也不证明 init 列表必然等于运行期有效白名单。需要进一步核实一个不改全局配置、可在单次调用中强制并验证限制的入口，才能开放此受限模式。

官方资料说明 `plan` 会添加规划指令；headless 会遵循既有权限规则，工作区写入可能自动允许。终端 sandbox 与全部文件/浏览器工具权限不是一回事。依据：[执行模式](https://antigravity.google/docs/cli/modes/)、[权限规则](https://antigravity.google/docs/cli/permissions/)、[Headless](https://antigravity.google/docs/cli/headless/)、[自定义 Agent](https://antigravity.google/docs/subagents)。

## 模拟验证与采用的机制

### 跨工具调用存活

`scripts/probe-detached.mjs` 启动纯本地子进程，启动端随工具调用退出；子进程 12 秒后写出完成记录。后续另一次工具调用读到了完整结果。

本次记录：启动时间 `1788115799371`、子进程开始 `1788115799410`、完成 `1788115811426`（Unix 毫秒）。测试只有本地文件输出，没有模型或网络请求。

边界：未关闭 Codex、注销账户、重启系统或修改 Windows job 配置；没有宣称跨这些边界存活。原生会话存在也不等于远端任务仍在运行。

### 自动测试

命令：`node --test tests/runtime.test.mjs`（或 `npm test`）。测试使用独立 mock CLI，生产 CLI 入口不暴露 fixture 或任意命令参数。

覆盖：后台完成、并发重复请求只发送一次、有效输入冲突、非法 ID、拒绝未实现权限字段、工具/模型准入、无提示词 probe、UTF-8 分块、匹配结果、零退出但原生错误、回复截断、畸形流、输出上限、审批等待、发送前取消、发送后取消/超时为未知、过期心跳、不完整登记不重跑，以及只有插件目录时从不同工作目录加载脚本。

开发中修复两项实测问题：

1. Windows 状态文件原子替换偶尔出现 `EPERM`，定位到 `rename`。对同一临时文件的 rename 最多重试 180ms，不重复启动任务、不修改权限。用短期 FileShare.Read 锁的独立 PowerShell helper 做了回归验证。
2. 本机 Node 24.13.0 的同步目录复制到中文目的路径出现未创建目的目录的现象，最小复现中 ASCII 目的路径成功，而标准库异步复制成功。打包隔离测试使用异步复制；没有修改 Node 或写自定义复制器。

只读 `luna_max` 对实现做了独立审查。已修复并补测登记只有 state 而无 inbox、JSON null/字段缺失/对象型错误、重复结果、Junction 祖先检查、取消与完成竞态，以及写入阶段 ENOSPC 后清理临时 prompt 文件。取消停止还增加有界的管道收尾，避免一直等 native close。

最终一轮自动测试：**26 项通过，0 失败，0 跳过**；Plugin 与 Skill 校验通过。Skill 校验器在 Windows 默认 GBK 下不能读中文 UTF-8 文档，使用 `python -X utf8` 执行，没有修改系统编码。

原始运行记录在 Git 忽略的 `.local/verification/`、`.local/test-runs/`；不发布这些数据。中断或无法清理的磁盘故障仍可能留下短期 inbox/tmp，当前不提供自动清理或安全擦除保证。

## 实现与后续范围

- 输入校验和去重：只接受已实现字段与明确 Gemini slug；UUID 目录抢占、规范化有效输入摘要冲突检查。未知状态不自动生成新 ID 重发。
- 运行状态：worker 原子更新状态与心跳；提交前保存可能发送状态。查询/取消分别执行，不要求主模型一直阻塞。
- 权限：当前只做纯文本门禁，不接受用户项目路径或 implementation 请求。启动 CLI 和账户服务查询仍会发生；无工具保证针对模型提示词执行，不是假设本地 CLI 启动无副作用。
- 结果：要求匹配原生会话 ID、完整结果和有效状态；只把必要答案保存为 result.json。结果内容不自动执行。
- 打包：脚本相互引用相对自身位置；只有已实现的 Skill 在 manifest 中声明。官方结构依据：[Build plugins](https://learn.chatgpt.com/docs/build-plugins)、[Build skills](https://learn.chatgpt.com/docs/build-skills)。

真实 agy 文本调用仍是未完成项。接下来应解决并实测单次权限限制，再发送一个小型真实任务；不得将当前预检阻塞改成默认放行。文件修改、图片、续接、两个 MCP、其他 CLI 和安装发布留在后续阶段。
