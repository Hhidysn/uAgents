# 全 Target 实机连通性、任务调用与十分钟默认观察期限

Date: 2026-10-06 (Asia/Shanghai)

Revision: 基线 `1ac20c1562bf2e260e159eb6cc9bee288cdfc424` 加当前未提交工作树；Windows，Node.js v24.13.0。真实调用通过当前仓库入口 `plugins/uagents/bin/uagents.mjs`，使用 agent-dispatch 工作流，状态与证据位于 `.local/verification/all-targets-20261006/`。

## 全 Target 连通性

为全部八个 target 登记独立 Task，要求只返回 `CONNECT_OK_<target>`，禁止工具调用和文件修改。观察预算明确设为 300000 ms。模型目录与版本不是通过证据；只有 `succeeded` 且回复完全匹配才通过。安装/登录阶段被阻塞的 target 没有实际发送 Prompt，不计作 Provider 连通成功。

| Target | 模型 | 结果 | Task ID 与证据 |
| --- | --- | --- | --- |
| agy | `gemini-3.8-flash-medium` | 通过，约 17 秒 | `887a11fa-f9f2-412d-abeb-49bfa6371463`；精确回复，模型验证通过 |
| OpenCode | `opencode-go/deepseek-v4.1-flash` | 通过，约 11 秒 | `ca240de8-1b61-4863-af70-7e9fe6023c59`；精确回复，模型验证通过 |
| Codex | 本机配置 `gpt-6.1-sol` | 失败 | `e6b5e17a-488d-4db4-8fe4-a29ce514f1ba`；`sent/native_turn_failed`，无正文；本地 `codex login status` 显示已登录，具体请求失败原因未进一步确认 |
| Claude Code | `claudeCode/deepseek-v4-flash` | 失败 | `35207e98-dc2c-4a81-aa5b-0e37fa313540`；原生返回 `Not logged in · Please run /login`；自报模型匹配不等于认证成功 |
| WorkBuddy | backend default | 失败，未发送 | `307469e2-492b-4841-8add-2c826198b41f`；执行路径报 `installation_not_found`，模型 help/缓存可见不能证明该路径可执行 |
| DSH | `deepseek-official/deepseek-flash` | 通过，约 34 秒 | `c1792ba0-2286-4927-bcc8-210562f5cb27`；精确回复，模型验证通过 |
| 豆包工作 | backend default | 不确定 | `7a5dbb07-f5a2-4cd6-9c05-eeca20e12eaa`；`may_have_been_sent/prompt_insertion_unconfirmed`，无回复，未重发 |
| TRAE CN | backend default | 失败，未发送 | `48620ee6-c83c-4b58-a41a-3ff7177d652f`；先停在 `preflight_login`。用户确认登录后，以同一 UUID 和 Attempt `resume`，随后报 `gateway_cleanup_deferred`；独立 `ensure` 也返回该错误，细分原因 `desktop_absence_unconfirmed` |

合计 3/8 通过、4/8 失败、1/8 不确定。没有自动替换模型/Provider、重放不确定 Prompt、批准原生对话框、登录或安装目标 CLI；不强行清理所有权或状态无法确认的旧桌面网关。所有测试目录的 sentinel 内容保持不变。

## OpenCode / agy 任务

两者各执行一次文件修改、一次中文 CLI/MCP 话题讨论，观察预算明确为 600000 ms。

| Target / 场景 | Task ID | 结果 |
| --- | --- | --- |
| OpenCode 文件修改 | `54f4b5b6-57ae-4ada-9ee2-14403ef70a19` | 通过，约 30 秒 |
| OpenCode 讨论 | `5e8be6ec-b849-4136-b63b-12407b9abe25` | 通过，约 17 秒 |
| agy 文件修改 | `ba4afc52-e791-4f31-ba90-b88a89329747` | 通过，约 62 秒 |
| agy 讨论 | `9119b127-8cfc-4c3e-8f4c-e2a778f09fe8` | 通过，约 37 秒 |

文件修改将占位 `sumIntegers` 改为整数数组求和及类型校验，并创建 `NOTES.md`。两个目标各自的函数由主代理独立导入执行 9 项断言，声明产物捕获/校验通过，文件范围与 sentinel 检查通过。讨论返回要求的中文前缀、优劣与条件推荐，目录没有新增或修改文件；字数要求仅作软约束。四项均 `succeeded`、`model_verified=true`。两目标短任务均在两分钟内完成，此结果不能证明更复杂仓库任务的两分钟预算足够。

## 默认期限与已安装 CLI

用户明确选择将普通任务观察默认值从 120000 改为 600000。Core parser、请求 JSON Schema 和 CLI discovery 共用 `DEFAULT_OBSERVATION_TIMEOUT_MS`，MCP 请求仍由同一 Core 归一化。显式请求值、1 秒–20 分钟上下限、CLI 15 分钟默认等待、短 probe/握手、Council 本地验证命令的 2 分钟预算及默认未启用的硬执行预算未改变。已登记 Task 的执行参数不回写。

观察期限并非统一的整项执行时限：agy/Codex exec/Claude Code/WorkBuddy 的观察过期会停止本地子进程，DSH 请求 shutdown 后停止子进程；Windows durable OpenCode、豆包与 TRAE 只结束观察，不能据此确认原生或 Provider 取消。Windows OpenCode 的 `execution_timeout_ms` 是独立的受管进程树执行预算。

| 验证 | 结果 |
| --- | --- |
| `node --test tests/protocol.test.mjs tests/cli-convenience.test.mjs tests/unified-cli.test.mjs tests/council.test.mjs` | 63/63 通过；含默认 10 分钟、显式覆盖、未启用执行预算、CLI 描述回归 |
| `node --test test/server-smoke.test.mjs`（cwd 为 unified MCP） | 15/15 通过 |
| `.local/verification/all-targets-20261006/run.mjs discover/launch-core/launch-remaining/launch-work/inspect` | 八项连接尝试、四项任务，终态与回复保存为 JSON |
| `.local/verification/all-targets-20261006/verify.mjs` | 3/8 连接、4/4 任务验收通过；失败/不确定保留 |
| `npm pack ./plugins/uagents --pack-destination <本地证据目录>/packages --json --silent` | 157 个文件，1774571 bytes |
| `npm install -g <本地 tarball> --ignore-scripts --offline --no-audit --no-fund` | 更新既有本机 uagents 安装；旧包保存在 packages/previous/ |
| 已安装 `uagents describe run` 与 `uagents schema request` | 默认均为 600000 |
| `node scripts/verify-installed-package.mjs <已安装包根目录> <隔离状态目录>` | CLI、技能安装、独立 MCP 工具表验证通过 |
| `git diff --check` | 通过，现存 LF/CRLF 提示不计错误 |

真实任务在默认值调整前已经明确使用 5/10 分钟预算，默认修改没有改变这批请求。未做完整回归、未证明失败 target 可用，未确认其它模型/环境或任意长任务能完成。详细索引、请求、终态、摘要、验收 JSON、当前源码身份与安装产物保存在上述证据目录。
