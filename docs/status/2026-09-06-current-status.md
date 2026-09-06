# uAgents 当前状态与能力矩阵

## Durable Native Execution 进展（2026-09-06 后续实现）

Durable Native Execution 的 Gate A–D 已完成并提交，Gate E 的本地 release-candidate 安装验收也已完成。Gate A 为 `686b02d feat: add durable native process ledger`，Gate B 为 `6702f32 feat: guard durable workspace executions`，Gate C 为 `f71a891 feat: add durable cli execution substrate`，Gate D 为 `fa01ca5 feat: make OpenCode execution durable`，发布候选版本元数据提交为 `2fd090b chore: version durable execution release candidate`。Gate B 的 Windows `inspect-process` 能区分“确认不存在”和 CIM 检查失败，并通过只读 `inspect-process-tree`、PID/start-time/executable identity 与 descendant quiescence 保守维护 workspace guard。

workspace admission 现在在最终 lease 事务中重新检查所有重叠、未释放的 durable guard。旧 Worker lease 即使过期，只要旧 native process 仍存活、descendant 仍存在或检查结果不确定，新的重叠 workspace 请求都不会进入执行。已有 native-process row 的同一 Attempt 也不能回到 fresh dispatch/recover/cancel-as-unsent 路径。

Gate C 提供通用 durable CLI substrate：使用 `native/<attempt-id>/stdout.log`、`stderr.log`、`exit.json` 的 file-backed 输出；先创建 transcript，再写 provisional process guard，再 spawn；在首个 prompt byte 之前验证 child PID/start/executable 并持久化 `possibly_sent`。native child 使用 detached + file-backed stdout/stderr，因此真实 provider-free fixture 已证明观察 Worker 被强制终止后，native process 仍可继续写 terminal transcript，且 prompt count 始终为 1。

`accepted` checkpoint 现在可安全重放：完全相同的 target/session/task identity 是幂等 no-op，不重复写 `native_sessions` 或 `dispatch.accepted`；冲突 identity/target fail-closed；恢复中首次发现 identity 也不会把已 `indeterminate` 的 Task 强行改回 `running`。stdout 仍保持 1 MiB 解析安全上限，stderr durable limit 为 64 KiB；partial UTF-8、partial line、parser failure 后未提交行重试、PID mismatch、pre-bind child exit、checkpoint/spawn failure 和 observation timeout 不杀 durable process 等路径都有 provider-free 回归。

Gate D 已把 **Windows 源码中的 OpenCode production path** 接到 durable controller。fresh dispatch 仍保持原有 `opencode run --model ... --format json --dir ... --title ...` 与 caller-controlled `native_args`，没有默认 `--auto`/`--pure`。Worker 在 session 出现前死亡时，`resume`/`reconcile` 会在原 Attempt 上读取 persisted process + transcript，首次发现同一 session 后幂等写入 `accepted`；Worker 在 accepted 后死亡并等 lease 过期时，旧 native process 仍会阻止第二个重叠 workspace writer。两类 provider-free 破坏性 fixture 都证明 recovery spawn count 为 0、prompt count 始终为 1。

OpenCode durable recovery 是“恢复观察/协调”，不是多轮会话续写：uAgents 不会在自动恢复中添加 `opencode run --session` 或 `--continue`，也不会重新发送原 prompt。`cancel` 或 `observation_timeout_ms` 只结束当前 observer；它们不等于 native execution cancellation，仍存活或状态不明的 native process 继续持有/保守保持 workspace guard。Windows **当前源码**已新增 verified `execution_timeout_ms`：独立 per-Attempt guardian 在发送前完成 durable ready handshake，deadline 从 `dispatch.possibly_sent` 持久化时间开始，超时后只终止 PID/start-time/executable 仍匹配的 owned process tree，并在 root death + descendant quiescence 得到证明后释放 guard。本地 tree 终止不会冒充 provider/native cancelled；确认本地终止仍以 `indeterminate + execution_timeout` 收敛，无法确认终止则保持 `execution_timeout_termination_unconfirmed` 与保守 guard。非 Windows OpenCode 仍拒绝该能力。

Verified execution-timeout 已完成本地 release-candidate 安装验收。源码提交为 `3fb582e feat: enforce verified OpenCode execution timeouts`，release metadata 为 `a231a5a chore: version verified timeout release candidate`，当前安装版本为 `0.2.0-alpha.1+codex.20260906234542`。

Verified execution-timeout 门禁已通过：Core `254/254` + MCP `11/9/2`，共 `276/276`。其中包含真实 Windows harmless Node process-tree termination、guardian durable-ready fail-closed、live Worker timeout、Worker 先死亡后 guardian 独立执行 deadline、prompt count 始终为 1、guard quiescence 后第二 writer 才能进入，以及原 Attempt reconcile 零 spawn/零 resend。没有执行真实 OpenCode/provider timeout 请求。

新版本已通过正常 `codex plugin add uagents@personal --json` 安装。仓库 tracked plugin、个人 marketplace source 和新 cache 的发布集合均为 `120` 个文件、`4,134,966` 字节，逐文件 SHA-256 `120/120` 一致且 marketplace/cache 无额外文件。旧 marketplace source 保留为 `C:\Users\24590\plugins\uagents-backup-before-20260906234542`，旧 cache 未删除。独立 fresh `codex exec --ephemeral --sandbox read-only` 明确加载新 cache 的 `agent-dispatch` Skill，并从该 cache 只读查询得到 `opencode.execution_timeout=true`、`analysis + implementation`、files in/out true 和两条既有 Flash route。

上一轮 Durable Native Execution Gate E 的历史门禁为 Core `238/238` + MCP `11/9/2`，共 `260/260` 通过；决定性的 durable recovery / dual-writer / transcript 子集为 `25/25`。该轮版本 `0.2.0-alpha.1+codex.20260906212805` 曾完成个人 marketplace 与 fresh Codex 验收；它现在作为旧缓存保留。当前安装事实以上述 `...20260906234542` verified-timeout RC 为准。

日期：2026-09-06（Asia/Shanghai）。项目目录：`F:\documents\software\uAgents`。

本文是当前状态入口，专门回答两个问题：OpenCode 是否支持文件修改编码，以及已安装缓存、最新提交版和当前工作树是否一致。
本次安装以当前工作树为唯一源码基线，并已在独立新启动的 Codex CLI 进程中验证宿主实际加载路径。

## 一句话结论

OpenCode 在当前工作树和当前安装缓存中都支持 `analysis` 和 `implementation`，并开放声明式文件输入与文件输出验收。
运行时通过 `opencode run --model ... --format json --dir ... --title ...` 启动；`--pure`、`--auto` 等原生选项由
`execution.native_args` 控制。uAgents 仍不提供执行沙箱，`execution.permission` 只作为 Schema 1.0 兼容元数据，
不再参与权限能力准入。

## 版本事实

| 层次 | 当前事实 | 结论 |
| --- | --- | --- |
| 插件 manifest | `0.2.0-alpha.1+codex.20260906234542` | 当前工作树、marketplace source 和新安装 cache 的版本字符串相同 |
| Durable 已提交基线 | `686b02d`（Gate A）、`6702f32`（Gate B）、`f71a891`（Gate C）、`fa01ca5`（Gate D）、`2fd090b`（RC metadata） | 当前源码、个人 marketplace 源和新缓存均包含 durable OpenCode production/recovery |
| 当前源码 | Gate A–E durable baseline + `3fb582e` verified execution-timeout + `a231a5a` RC metadata | 已安装并完成 provider-free fresh-process 验收；仍不是公开发行版 |
| marketplace 源 | `C:\Users\24590\plugins\uagents` | 从当前提交同步 120 个 tracked 插件文件；旧源完整备份 |
| 实际安装缓存 | `C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260906234542` | `codex plugin add uagents@personal --json` 返回并启用的当前版本 |
| 旧缓存 | `...0.2.0-alpha.1+codex.20260906212805`、`...0.2.0-alpha.1+codex.20260906063959`、`...0.2.0-alpha.1+codex.20260905113451` | 均保留用于回滚，不是当前 marketplace 安装版本 |

核对依据：以 `git ls-files -- plugins/uagents` 为仓库发布权威集合，当前 tracked plugin、marketplace 源和新安装缓存均为 120 个文件、4,134,966 字节，逐文件
SHA-256 `120/120` 一致，且 marketplace/cache 均无额外文件。旧 C 盘源完整保留为
`C:\Users\24590\plugins\uagents-backup-before-20260906234542`，旧缓存均未删除。

本次核对使用了以下只读命令：

```powershell
node "C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260906234542\bin\uagents.mjs" targets
node "C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260906234542\bin\uagents.mjs" capabilities opencode
node "C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260906234542\bin\uagents.mjs" models opencode
node plugins/uagents/bin/uagents.mjs capabilities opencode
```

新缓存 CLI 与当前工作树 CLI 都返回目标集合 `agy`、`workbuddy`、`opencode`、`doubao`、`trae`，以及两条显式 OpenCode 路线：
`commandcode-goat/deepseek/deepseek-v4-flash` 和 `commandcode-goat/z-ai/glm-5.3-flash`。

## 实际能力矩阵

下面的“文件输入/输出”是 uAgents 协议能力，不等于目标原生应用理论上永远不能处理文件。

| 目标 | 模式 | 文件输入 | 文件输出 | 图片 | 模型选择 | 运输与生命周期 | 主要限制 |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| agy | `analysis`、`implementation` | 是 | 是 | 否 | 显式 Gemini | CLI；继承环境 | 无硬只读；模型/cwd/会话核验依赖原生回显 |
| WorkBuddy | `analysis`、`implementation` | 是 | 是 | 否 | 后端默认 | CLI；继承环境 | 后端模型不具备可验证具体身份；无远端取消确认 |
| OpenCode | `analysis`、`implementation` | 是 | 是 | 否 | 两条显式 Command Code Flash 路线 | CLI；Windows durable process/transcript + verified execution timeout | 无 uAgents 执行沙箱；timeout 只确认本地 owned process-tree 终止，不代表 provider/native cancelled；模型不从事件流回显 |
| 豆包工作 | `analysis` | 否 | 否 | 否 | 后端默认 | CDP；受管隔离 Profile | 无原生取消；不回显可验证模型；真实消息 E2E 尚未作为发布前证据完成 |
| TRAE CN | `analysis`、`implementation` | 否 | 是 | 否 | 后端默认 | gateway；受管隔离 Profile | 不接受显式文件输入；无原生取消确认；模型不可靠回显；gateway 白名单待补 |

当前全部目标的静态权限字段都是：`native=true`、`advisory_read_only=true`、
`enforced_read_only=false`、`workspace_write=false`、`full_access=false`。这些字段保留用于兼容能力描述，
不再作为 uAgents 的权限准入门槛。这意味着：

- `analysis` 是任务意图，不是硬性只读。
- `advisory-read-only` 只追加不修改文件/不运行变更命令的提示，不能阻止同一用户权限下的原生 Agent 写入。
- `implementation` 只在目标能力表允许时开放原生编辑流程；它不等于 uAgents 提供了目录级写入沙箱。
- 文件产物捕获、路径校验和 SHA-256 验证是交付验收证据，不是执行隔离。

## OpenCode 证据链

1. 源码 Registry 将 OpenCode 定义为 `modes: ['analysis', 'implementation']`、`inputs.files: true`、`outputs.files: true`：
   [builtins.mjs](../../plugins/uagents/src/registry/builtins.mjs#L21)。
2. Policy 在注册前仍拒绝不匹配的模式、文件输入和文件输出，并拒绝覆盖 OpenCode dispatcher-owned 参数：
   [evaluate.mjs](../../plugins/uagents/src/policy/evaluate.mjs#L32)。
3. 回归测试验证 `implementation` 可到达 Adapter、无 `expected_outputs` 时可成功，并在声明输出时复用共享产物捕获：
   [unified-cli-adapters.test.mjs](../../tests/unified-cli-adapters.test.mjs#L58)。
4. OpenCode driver 将已验证的工作区文件映射为重复的 `--file <absolute-path>` 参数，并按请求顺序透传非冲突原生参数：
   [opencode-driver.mjs](../../plugins/uagents/src/transports/opencode-driver.mjs)。
5. `--pure` 不再默认添加；`--auto`、`--agent` 和 `--variant` 仅在 `execution.native_args` 中请求时发送。
6. 旧缓存查询结果只代表旧版本的能力；新缓存已返回：

   ```text
   modes: ["analysis", "implementation"]
   inputs:  {"text":true,"files":true,"images":false}
   outputs: {"text":true,"files":true,"images":false}
   workspace_write: false
   ```

   该结果属于新安装缓存；旧缓存仍保留但不再是当前 marketplace 的安装版本。

7. 当前 OpenCode reference 已说明新的 implementation、文件输入/输出和 native args 契约：
   [opencode-council.md](../../plugins/uagents/skills/agent-dispatch/references/opencode-council.md)。

因此，当前安装缓存中的 OpenCode 已可用于独立方案、代码审查、文本分析和文件实现任务；仍须接受其原生权限、
模型不回显，以及本报告列出的 session resume、原生取消和多模态等边界。Windows CLI 安装发现与真实可执行文件
验证已在本轮标准 submit 路径上完成。

## 已实现但仍有边界的公共能力

- 统一 Schema 1.0、能力匹配、显式模型路线、四个模型身份字段和结构化错误。
- SQLite WAL 控制面、Task/Attempt/Native Session 分离、同 UUID 幂等、发送前 `possibly_sent` 检查点、
  lease/fencing、有限排队、未发送任务恢复和显式 reconcile。
- CLI-first 调用与一个兼容 stdio MCP；MCP 当前暴露 13 个统一工具。
- CLI 入口发现/校验缓存；豆包和 TRAE 的专用隔离 Profile、Host lease、首次登录等待和原 Attempt 恢复。
- 声明式文件输入快照、输出捕获、路径范围检查和 SHA-256 验证；这些是验收机制而非安全沙箱。

## 仍需补齐的功能

按影响和依赖排序：

| 优先级 | 缺口 | 影响 | 建议验收 |
| --- | --- | --- | --- |
| P1 | 其他 CLI target 的 `native_args` 映射 | 当前第一版只为 OpenCode 建立了协议参数冲突保护和原生参数透传 | 为 agy/WorkBuddy 各自定义 dispatcher-owned 参数，再独立开放原生参数透传；不要无校验复用 OpenCode 规则 |
| P1 | 图片/多模态通道 | 五个目标都不能通过统一协议接收图片 | 固定 MIME、大小、快照、脱敏和目标能力后，再按目标逐个开放 |
| P1 | 原生取消与多轮 resume | 豆包/TRAE 取消后只能进入未知；所有 CLI 续接能力仍有限 | 保存并验证原生任务身份，证明远端终止或同会话续接；不确定时保持 `indeterminate` |
| P1 | 模型身份与额度证据 | WorkBuddy/桌面目标不能证明具体模型；probe 不能证明真实额度 | 仅在原生事件或受信接口能绑定时设置 `model_verified=true`；补显式 live smoke |
| P1 | 真实消息 E2E | OpenCode 已完成一条 DPF 标准 CLI submit 最小真实闭环；其他目标仍主要是 fixture、连接探测或版本探测 | 在用户明确允许额度消耗后，分别完成其他目标最小真实闭环，不自动 fallback |
| P2 | TRAE gateway 版本白名单 | 当前可用但为 honest-degraded，升级后兼容性风险较高 | 固定版本指纹、适配器版本和兼容性回归；未知版本明确降级或阻断 |
| P2 | 状态保留/清理策略 | 长期运行可能积累 Prompt、结果、快照和产物，当前保留上限仍不完整 | 区分必要结果与诊断日志，定义容量/保留期、活动任务保护和显式清理 |
| P2 | 发布工程 | 当前有版本字符串和第三方通知，但顶层许可证、变更日志、供应链清单仍待补 | 干净包、重装、新任务拾取、版本/哈希/许可证和升级回滚形成发布清单 |

## 验证状态与限制

本次 OpenCode native-execution 实现与 Windows CLI 修复的本地门禁为：根项目 176 项、豆包 MCP 11 项、TRAE MCP 9 项、
Unified MCP 2 项，共 198 项通过；`agent-dispatch` skill validator、插件 validator 和
`git diff --check` 同时通过。安装后的源目录和新缓存也分别通过插件 validator，前序 Runtime 修复的独立记录仍见
[2026-09-06 Runtime reliability repair verification](../verification/2026-09-06-runtime-reliability-fixes.md)。

独立新启动的 `codex exec` 进程实际读取上述新缓存路径，并返回 `targets`、`capabilities opencode` 和
`models opencode`；其中 OpenCode 为 `implementation`、`inputs.files=true`、`outputs.files=true`。此前 app
内新任务复用了旧宿主进程快照并显示旧缓存，这一结果未被用作安装通过依据。

本轮先用正常安装后的 CLI 执行 `probe`（`1.18.13`，`version_only`、`submission=not_sent`），再执行
`ensure opencode --refresh`。后者在本机 Windows PowerShell 5.1 `-NoProfile` host runner 下成功完成身份检查，
Node `crypto`/`fs` 完成 SHA-256，最终 installation entry 为真实可执行文件：
`C:\Users\24590\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe`，
SHA-256 为 `50ff54c55e15325fc23ace446a2ef545f75aa1c5990d3352af9b98c331aba55e`，大小 `175350664`。
缓存和 supervisor 不再把 `opencode`、`.cmd` 或 `.ps1` shim 作为最终 entry。

用户授权后又通过标准 CLI `submit --request FILE` 执行了一次真实 OpenCode provider implementation E2E；没有
手工 `verifiedEntry`，没有 fallback，`execution.native_args=[]`，没有自动加入 `--auto` 或 `--pure`。结果如下：

- task/request：`405657de-6609-40d7-83fe-fba13109570a`
- route：`commandcode-goat/deepseek/deepseek-v4-flash`
- native session：`ses_f8a86e1ceffe7pjSB32iW1Y8ZA`，`native_status=stop`
- uAgents：`status=succeeded`、`native_outcome=succeeded`、`objective_verdict=succeeded`、`submission=sent`
- 独立临时 workspace 最终只有 `input.txt` 和 `result.txt`
- artifact：`artifacts/captured/result.txt`，`verified=true`；workspace 与 captured copy 的 SHA-256 都是
  `9bb6928229d33ac70740e46776f9809294c00cb0a9d142ed28b6d6c8709f4fd8`
- provider 返回了 usage，但没有返回可验证的具体模型身份，因此 `model_verified=false`

这证明标准 CLI submit 可以自行发现并验证真实 `opencode.exe`，启动 native OpenCode implementation，读取声明式
文件输入，写入声明输出，并完成路径检查、artifact capture 和 SHA-256 验收。持久化 session/PID/游标、崩溃恢复、
独立执行超时、图片/多模态和双 Worker workspace 写入防护仍不属于本轮修复范围。

本轮发布候选已重新执行：

```powershell
npm test
python C:\Users\24590\.codex\skills\.system\skill-creator\scripts\quick_validate.py plugins/uagents/skills/agent-dispatch
python C:\Users\24590\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py plugins/uagents
git diff --check
```

并把“源码提交、工作树、安装缓存、独立新 Codex CLI 进程加载、真实目标 E2E”分别记录，不能合并成一个“已安装并可用”的结论。
