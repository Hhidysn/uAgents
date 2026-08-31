# 首轮 CLI 与运行机制验证

日期：2026-08-31。环境：Windows，Node.js 24.13.0。用户授权：核对现有能力、必要模拟验证、agy 真实小任务验证及据实实施最小插件；不修改全局配置、不自动安装或换计费路线。

## 结果与未完成部分

当前已跑通 agy 真实任务、专用目录内文件生成、匹配会话结果回收和产物检查。用户明确表示“不用管只读限制。继续”后，取消原先零工具门禁，使用原生 Agent 与权限；implementation 单次启用 accept-edits。页面脚本逻辑检查通过，浏览器交互及视觉验收未完成。仅 agy 首个切片可用，不代表其余 CLI/MCP 已完成。

仓库版本为 `0.1.0-alpha.2`，包含一个 Skill 和独立、可直接执行的 Node 脚本。没有 MCP 声明、个人市场注册、依赖安装或全局 AGENTS.md 修改。下文保留 alpha.1 失败预检的历史事实，当前结果见“原生权限下的真实任务”。

## 原生能力核对

| 目标 / 本机版本 | 已核对的入口与能力 | 本轮未验证 |
| --- | --- | --- |
| agy 1.1.22 | 帮助与模型清单；stream-json、会话 ID、真实文件生成；--add-dir 与单次 accept-edits；结果和产物回收 | 图像能力、现有项目直接接入、强制只读/路径隔离、续接、远端取消 |
| WorkBuddy 内嵌 CLI 2.132.0 | `node <WorkBuddy>/resources/app.asar.unpacked/cli/dist/codebuddy.js`；print、JSON/stream-json、resume、tools/permission-mode；原生 bg、ps、logs、attach、kill、serve、daemon | 后台存活、真实模型任务、实际工具限制、服务端鉴权及取消 |
| OpenCode 1.18.13 | `opencode run`、format json、session、serve、acp、attach；pure 仅禁用外部插件，auto 自动审批 | 本轮未重新发模型请求，未启动服务验证 REST/ACP 生命周期 |

WorkBuddy 与 OpenCode 的帮助核对由只读 explorer 完成。WorkBuddy 安装包自带 `cli-reference.md`、`http-api.md` 描述了 runs 的提交、查询、流和取消端点；这是本机文档证据，不能当成本轮已启动服务的证明。

决定：agy 先用每任务一个 worker；后续 WorkBuddy 优先验证原生后台机制，OpenCode 优先验证现有会话/服务能力。暂不创建统一守护服务、数据库或队列。

## 历史：alpha.1 的无工具预检

使用全新、专用工作目录和项目级自定义 Agent 定义，没有读取或改写供应商认证文件。调用模式为 stream-json，先等待 init，不发送 user 消息。

- 模型清单返回了 `gemini-3.1-pro-low` 等路线；本轮固定该模型，不自动兜底。
- 第一次 `tools: []` 定义的初始化仍报告完整工具集合。随后改为显式 `view_file` 的探测遇到两次资格检查 EOF；在网络恢复后的最后一次无提示词探测中，显式列表仍返回完整工具集，会话 ID 为 `bb639e5f-fbad-4414-b71e-814a209c3bd3`。这不足以证明运行期实际白名单已受限。
- 使用插件正式预检入口再次验证后，返回 `blocked / text_only_permissions_unverified`、`submission: not_sent`、`tool_count: 57`。
- 该次原生会话 ID：`721fecd7-47a6-4a9b-9daa-5b26f2893bd3`；本地 task ID：`d69140e7-5354-4773-b10a-4c3df1099cbe`。两者明确区分。
- 插件实际确认了所请求模型与工作目录，并在检测到工具集合不能满足纯文本限制时停止子进程，没有发送提示词。

这证明当时的门禁阻断了调用，不证明 agy 完全没有权限控制，也不证明 init 列表必然等于运行期有效白名单。用户随后明确取消强制只读要求；这项历史限制不再是当前任务的准入条件。本版也不声称已实现硬性只读模式。

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

alpha.1 自动测试为 26 项通过；本次更新后为 **29 项通过，0 失败，0 跳过**。新增或修订原生工具允许执行、对象型权限错误、implementation 产物回收、原生成功但缺少文件、非法产物路径及 Junction 越界检查。Plugin 与 Skill 校验通过。Skill 校验器在 Windows 默认 GBK 下不能读中文 UTF-8 文档，使用 `python -X utf8` 执行，没有修改系统编码。

原始运行记录在 Git 忽略的 `.local/verification/`、`.local/test-runs/`；不发布这些数据。中断或无法清理的磁盘故障仍可能留下短期 inbox/tmp，当前不提供自动清理或安全擦除保证。

## 实现与后续范围

- 输入校验和去重：只接受已实现字段与明确 Gemini slug；UUID 目录抢占、规范化有效输入摘要冲突检查。未知状态不自动生成新 ID 重发。
- 运行状态：worker 原子更新状态与心跳；提交前保存可能发送状态。查询/取消分别执行，不要求主模型一直阻塞。
- 权限：原生 Agent；analysis 继承既有模式，implementation 单次 accept-edits，保留终端 sandbox，不加全工具审批跳过参数。仍不接受外部项目路径或硬性 owned_paths；初始化也可能访问账户服务。
- 结果：要求匹配原生会话 ID、完整结果和有效状态；只把必要答案保存为 result.json。结果内容不自动执行。
- 打包：脚本相互引用相对自身位置；只有已实现的 Skill 在 manifest 中声明。官方结构依据：[Build plugins](https://learn.chatgpt.com/docs/build-plugins)、[Build skills](https://learn.chatgpt.com/docs/build-skills)。

后续范围：WorkBuddy 与 OpenCode 适配、两个 MCP、现有项目接入、图像能力、续接及安装分发。不要把已完成的 agy 文件小任务扩大解释为这些目标均已跑通。

## 原生权限下的真实任务

在用户取消强制只读要求后，实际发送了三个有明确边界的 HTML 验证任务，均指定 agy 的 gemini-3.1-pro-low；没有改供应商路线、安装依赖、修改供应商配置或读取凭据。第二、三次是针对已结束任务暴露的问题做修复验证，不是对 unknown 状态自动重发。

| 次数 | 本地 task ID / 原生 session ID | 实际结果 |
| --- | --- | --- |
| 1 | `041ced75-bc35-45e8-b749-05e01fe9207b` / `36477a6e-547f-40cb-9605-455e5ff8dfd1` | 原生 SUCCESS，HTML 实际写到 agy 自有 scratch 的 uagents_todo/index.html，未满足指定目录要求；旧状态保持历史事实，人工验收不通过 |
| 2 | `c9d1814a-b7a4-405b-93da-34a10d13ce45` / `90be0268-5e92-4bab-a556-556c6cc50dad` | 加入 --add-dir、绝对工作目录前缀与 expected_outputs 后，原生修改审批导致 needs_user；native SUCCESS、exit 0 和空回复没有被误报为成功 |
| 3 | `7bf196f8-1d3a-499c-9a00-bc02422137de` / `e168b458-62ac-466b-bdbd-63ec4c432832` | 按已授权写入范围，单次启用 --mode accept-edits；指定目录 index.html 生成成功，匹配结果回收且 artifact_check=passed |

最终产物位于 `.local/verification/plugin-state/7bf196f8-1d3a-499c-9a00-bc02422137de/workspace/index.html`，**7,696 字节**，SHA-256 为 `2466557e62e429764434b72e4ef6809b50b3b42ef2a1d4a667c142a82013b5de`。原生握手报告 permission_mode=request-review，记录单次 native_edit_mode=accept-edits，工具步骤包含 write_to_file。

这次修复的运行机制：

1. 原生工具列表不再作为强制只读门禁。保留模型、cwd、会话归属、去重和未知状态处理。
2. 显式传 --add-dir 与工作目录前缀，不假定进程 cwd 就是 Agent 的活动目录。
3. implementation 必须指定 expected_outputs；原生成功后验证文件真实路径、非空、10 MiB 上限和 SHA-256。缺少或越界产物会标记 failed；这是事后验收，不能阻止原生工具越界。
4. 文件修改使用原生 accept-edits；不改变全局设置，命令权限仍由原生规则处理。对象型工具错误和 stderr 中的权限拒绝均可使结果归为 needs_user。

产物验证：读取实际 HTML，确认独立内嵌 CSS/JS、无外部资源 URL、移动端 media rule 与指定页脚标记。隔离 Node VM 加最小 DOM 替身执行生成的原始 JS，验证初始 3 项/完成 1 项、新增任务、切换完成、进度更新、回车新增和拒绝空白输入，全部通过；没有改写 Gemini 的产物。

浏览器验证边界：Browser 的 URL 安全策略拒绝打开本地 file URL，未换服务、浏览器或协议绕过。没有实际浏览器点击、布局渲染或视觉验收结论。上述 VM 检查仅证明这份脚本在替身 DOM 下的逻辑行为，不等同于浏览器测试。

原始请求、状态、结果、产物及逻辑检查脚本保留在 Git 忽略的 `.local/verification/`。首轮 agy 自有 scratch 产物保留原位，没有自动搬运或删除。全局 AGENTS.md 与用户 .gitignore 的 SHA-256 均与执行前一致。

调用依据：[原生执行模式](https://antigravity.google/docs/cli/modes/)、[Headless 事件与工具错误结构](https://antigravity.google/docs/cli/headless/)、[原生项目行为](https://antigravity.google/docs/cli/projects/)，并核对本机 `agy --help` 的 --add-dir 和 --mode 参数。最终是否免费未作判断，usage 数字不能证明计费来源。
