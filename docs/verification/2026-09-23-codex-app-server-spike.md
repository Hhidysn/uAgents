# Codex app-server 内部原型验证

日期：2026-09-23。本机 `codex-cli 0.153.4`。此记录先做无 Provider 协议探测和子进程 fixture，随后用源码内部 app-server transport 完成 Astra 真实多轮任务；公开 target 和已安装插件仍使用 exec。

## 执行

- `codex app-server generate-json-schema --out .local/verification/codex-app-server/schema` 成功。稳定 Schema 的 `ClientRequest` 包含 `initialize`、`thread/resume`、`thread/fork`、`thread/read`、`turn/start` 和 `turn/interrupt`。
- 生成的 `ThreadForkParams` 有可选的 `lastTurnId`，可指定包含到哪个已完成 Turn；内部 app-server 原型已持久化该来源 Turn ID。
- 使用隔离的本地 stdio 子进程执行 `initialize` → `initialized` → `thread/list` → `thread/start(ephemeral=true)`。返回 `initialize=true`、`thread_list=true`、`user_agent=true`、`ephemeral_thread=true`、`thread_model=true`；未创建 Turn 或发送 Prompt。对 stdin 发送 EOF 后，app-server 启动器及管道正常关闭。

## 内部传输与会话原型

新增内部可选的 `CodexAdapter({ transport: 'app-server' })` 路径，公开 target 仍使用 exec。内部路径使用每 Task 一个 stdio 子进程；`initialize` 后创建 Thread，在写入 `turn/start` 前保存 `possibly_sent` 检查点，收到 Turn 回执后保存 Thread ID 与 Turn ID。只有匹配的终态通知、非空 assistant 文本，以及启动器关闭和子进程树静止证据才能产生成功结果。服务端审批请求不会被自动同意；错线程、缺失终态及审批请求保持不确定。成功终态先通过 stdin EOF 让 app-server 正常退出，超时后对已核实身份的启动器调用既有进程树终止器。

TaskService 路径在发送前先核实启动器 PID、启动时间和可执行文件；`possibly_sent` 检查点之后、`turn/start` 字节之前，原子写入完整原生进程记录。正常关闭后经进程树检查才释放 workspace guard；子进程存活或检查失败时保留 guard，reconcile 也不能越过该 guard 直接认定终态。身份探测失败时不发送 RPC，也不留下无 PID 的 provisional guard。真实本机 CLI 单轮 Astra 在此路径下 `sent/completed/succeeded`，进程记录为 `exited/released` 且 PID/启动时间有效；最终入口顺序再次运行得到相同结果，记录于忽略的 `.local/verification/codex-app-server-process-e2e-v2/summary.json`。

跨进程崩溃夹具补了两个相邻边界：Worker 在 accepted 检查点后退出时，新的 Runtime 等租约到期与进程树静止，按持久化 Thread/Turn 做只读恢复，得到原生完成文本，整个工作区只出现一次 `turn/start`。Worker 在 `possibly_sent` 检查点后、进程记录与 Prompt 发送前退出时，新 Runtime 的 `resume` 路由至 app-server 只读查询，结果仍为 `indeterminate`，工作区没有任何 `turn/start`。新增跨进程窗口：fixture 持久化已收到但尚未回执的 `turn/start` 后杀死 Worker；新 Runtime 等进程树静止和租约到期后按 `clientUserMessageId` 只读找回同一 Turn 与回复，工作区仍只有一次 `turn/start`。运行时按持久化 transport 证据选择恢复 Adapter；公开新任务仍走 exec。

标准 Worker 路径现可运行内部 opt-in Task：`TaskService.submit(input, { dispatchTransport: 'app-server' })` 将传输选择纳入有效请求哈希、Task payload 和注册事件。Worker 重启后从注册事件选择 Adapter，并核对 payload 中的标记；标记被改动时发送前拒绝。未带标记的 Codex Task 仍走 exec，同一 request ID 不能改选传输后重复提交。fixture 经标准 Worker 路径完成 `start → continue → fork → branch-continue`；公开 `UnifiedRuntime.submit` 不设置这个内部标记，capability 仍为 `resume=false/fork=false`。

内部会话原型把已完成来源 Turn ID 持久化到 Task 的 session binding。续接前调用元数据 `thread/read`，再以 `thread/turns/list` 倒序分页核对原生最新 Turn 恰是来源 Turn；fork 也分页查找并核实来源 Turn，再用 `thread/fork.lastTurnId` 固定上下文边界。TaskService 只对有原生 Turn ID 的 app-server 来源允许从较早的已完成 Task fork；continue 及无法固定 Turn 边界的 exec fork 仍要求来源为当前 Thread 最新 Task。exec 与 app-server 的来源绑定互不跨用。真实子进程 fixture 已覆盖 `start → continue → fork → branch continue`、从较早 Task fork，以及外部 Turn 推进后续接失败但 fork 仍以原来源 Turn 为边界。超过一页的来源历史也已覆盖；分页异常、循环游标，或来源 Turn 落在最近 4096 条以外时会在发送前失败。`thread/resume` 回执后、`turn/start` 前再次读取最新 Turn；fixture 中在 resume 期间注入外部 Turn 会在发送前拒绝。原生读取与发送之间仍没有 compare-and-swap，最后一次读取之后的并发竞态仍需处理或明确为发布限制。

发送前用无 Prompt 的 `--version` 探测以及入口文件内容、规范路径和官方 npm 包的原生 `codex` 可执行文件 SHA-256 生成安装指纹，将其写入 `dispatch.possibly_sent` 检查点，并绑定到后续 Task 的 session。换用另一份 CLI 入口或修改原生二进制会在发送前拒绝续接。真实本机 CLI 0.153.4 的无 Prompt `prepare` 已生成合法指纹；本地 fixture 不含官方二进制时只绑定入口与版本。指纹仍不覆盖 npm 包内全部文件，也不消除探测后到启动前的文件替换竞态。

真实 Node 子进程 fixture 与 TaskService 集成测试覆盖了通知先于 `turn/start` 回执的顺序、已接受 Turn 丢失完成通知，以及 Turn ID 回执丢失后的只读定位。写入 `turn/start` 时使用唯一 Task `request_id` 作为 `clientUserMessageId`；后者通过 `thread/turns/list` 与 `thread/items/list` 分页查询，只在持久化 Thread 中恰好匹配一个 `userMessage.clientId` 时接受原生 Turn ID。超过一页的丢回执历史已覆盖；错误 Turn ID、无匹配、重复匹配或分页不完整保持不确定，不重发 Prompt。

已接受 Turn 收到取消请求时，内部传输发送带确切 Thread/Turn ID 的 `turn/interrupt`，仅在同一 Turn 的 `interrupted` 终态及进程树静止被确认后记录取消。中断 RPC 回执本身不能确认取消；缺终态或缺 `turn/start` 回执仍保持不确定。取消与完成竞态中若原生 Turn 最终 `completed` 且回复完整，则按已完成记录。只读分页查询可把已接受的 `interrupted` Turn 恢复为取消。模拟子进程已覆盖中断 RPC 被拒、终态通知丢失、只读恢复和进程树未静止。

`node --test --test-concurrency=4 tests/codex-app-server.test.mjs tests/codex-cli.test.mjs tests/unified-cli-adapters.test.mjs tests/plugin-package.test.mjs tests/durable-checkpoints.test.mjs tests/runtime-crash.test.mjs tests/queue-recovery.test.mjs tests/entrypoint-recovery.test.mjs tests/sqlite-store.test.mjs`：**130/130 PASS**。共享状态机、进程 guard 与恢复回归 **45/45 PASS**；Windows 原生进程树终止测试单独运行 **4/4 PASS**。后者与其它测试并行时出现一次终止后复查短暂仍见 descendant 的失败，故记录为环境时序波动，尚未据此放宽进程树静止判定。相关文件的 `node --check` 与 `git diff --check` 通过；`plugin-creator/scripts/validate_plugin.py plugins/uagents` 返回 Plugin validation passed。未执行 cachebuster 或重装。

## Astra 真实多轮 E2E

用隔离的 `.local/verification/codex-astra-app-server-e2e/` 工作区、源码 TaskService 和内部 `CodexAdapter({ transport: 'app-server' })`，显式选择 `gpt-6-astra`，连续运行 `start → continue → fork → branch-continue` 四条只读文本 Task。每一步只在前一步确认成功后发送，未自动重试。四条 Task 均为 `submission=sent`、`native_status=completed`、`status=succeeded`；首轮返回 `UAGENTS_APP_SERVER_ASTRA_OK`，续接复述了首轮文本，fork 得到不同 Thread ID，分支续接正确返回 `NONCE=COPPER-OWL-58`。原生 Thread ID：主线 `01a0ce7b-02cd-7563-849f-63597700e697`，分支 `01a0ce7b-f7ab-7c73-b413-60eb7505d2e2`。四条 Turn ID 均不同，保存在各自 Task 的 native binding 中。

这证明本机当时的 Astra app-server 路线可运行真实模型 Turn、原生 `thread/read`/`thread/resume`/`thread/fork.lastTurnId` 与 uAgents 持久化链路互通。不证明公开 exec 路线的 Astra 真实任务、Luna app-server 可用、真实 Provider 取消或实际模型自报；`model_verified=false` 仍正确。未重新安装或发布插件。

另以只读 `readCodexAppServerTurn` 查询首轮真实 Astra Thread/Turn，得到 `type=succeeded`、`native_status=completed`、`evidence_strength=2`，最终文本与已持久化的 Task 回复完全一致。这证明**已接受且有 Turn ID** 的终态查询路径。

随后又以新的真实 Astra 单 Turn 发送 `clientUserMessageId=d19d3457-536f-4580-bdeb-1a1460c5c2cd`；`thread/read` 返回的该 Turn `userMessage.clientId` 与之完全一致，最终回复为 `UAGENTS_CLIENT_ID_OK`。结合无 Provider fixture，已实现无 Turn ID 时按此字段定位并持久化 native binding；这不构成所有断线时序的 exactly-once 保证。若找不到唯一匹配，Task 保持不确定。

安装指纹变更后，再用隔离的真实 Astra `start → continue` 两 Turn 验证：两者均 `sent/completed/succeeded`，共享 Thread `01a0ce8f-beb1-7b42-968e-7ad5929eb7b5`，回复分别为 `UAGENTS_FINGERPRINT_START` 和 `UAGENTS_FINGERPRINT_CONTINUE`；第二条 Task 的来源绑定指纹与自身发送检查点一致。记录在忽略的 `.local/verification/codex-app-server-fingerprint-e2e/summary.json`。

加入进程树 guard 后，真实 Astra 再次执行 `start → continue → fork → branch-continue`：四个 Turn 均 `sent/completed/succeeded`、进程 `exited/released`，主线与分支 Thread ID 正确；分支回复为 `NONCE=TEAL-FOX-83.`，比脚本严格期望值多了句号，因此脚本以退出码 1 报告文本断言失败。独立检查原生链路及去尾句号的回复均正确。记录在 `.local/verification/codex-app-server-process-multiturn-e2e/summary.json`，不将该脚本称作全通过。

加入原生二进制哈希后，新的真实 Astra `start → continue` 两 Turn 均 `sent/completed/succeeded` 且共享 Thread；来源指纹匹配，脚本严格文本断言通过，记录在 `.local/verification/codex-app-server-binary-fingerprint-e2e/summary.json`。再改用分页来源核对后，另一次真实 Astra `start → continue` 同样通过；对这次首轮的已知 Turn ID 及 `clientUserMessageId` 分别作只读分页查询，均得到同一原生 `completed` Turn 和相同回复。记录在 `.local/verification/codex-app-server-pagination-e2e/`。增加 resume 后第二次来源核对后，新的真实 Astra 两 Turn 再次严格通过，记录在 `.local/verification/codex-app-server-post-resume-check-e2e/summary.json`。

内部传输标记接入标准 Worker 后，在 `.local/verification/codex-app-server-standard-worker-e2e/` 以四个独立 Worker 子进程运行真实 Astra `start → continue → fork → branch-continue`。四个 Worker 均以退出码 0 结束，Task 均为 `sent/completed/succeeded`；前两轮共享 Thread `01a0cedc-06f4-7791-b93c-7bd272978dad`，fork 新建 Thread `01a0cedd-3284-7df2-a390-715e6ab54532`，分支续接沿用新 Thread 且返回预期 nonce。脚本两段均打印 PASS，未重放任何 Prompt。此验证运行的是源码内部 opt-in Task，不等于已安装插件或公开 API 验收。

同一工作区再从已被主线续接超过的首轮 Task fork：标准 Worker 退出码 0，Task 为 `sent/completed/succeeded`，新 Thread `01a0ceeb-29d3-7c63-94c7-311e61d756f1` 返回首轮回复 `UAGENTS_WORKER_START`。随后只读 `thread/turns/list` 查得新 Thread 恰含首轮来源 Turn `01a0cedc-07cf-7113-a405-e34f1be3232c` 和新 fork Turn，不含主线后来的 Turn。这验证真实 CLI 的旧来源 Turn 边界，而非仅靠模型复述判断。

真实 Astra 中断只尝试一次：`turn/start` 回执已给出 Thread `01a0ce90-cdae-7c70-88e6-e5fd564506a3` 和 Turn `01a0ce90-ce80-71e2-8748-212f9a289167`，随后立即请求中断。传输返回 `unknown`、`launcher_close_confirmed=false`，没有观察到终态。只读 `thread/read` 返回 RPC 错误，底层描述该 Thread 的 rollout 为空。没有重发 Prompt，也没有把请求回执当成取消成功。此案例表明极早中断的恢复仍不可靠；其记录在 `.local/verification/codex-app-server-interrupt-e2e/summary.json`。事后按原始 Node 父 PID 与 `app-server --stdio` 命令行检查时未发现仍在运行的相关进程，但这不是当时进程树静止的持久化证明。

新增进程记录后的第二次真实 Astra 取消：Task `f9988543-8e2f-426b-bcbd-5cfbdef416d4` 已接受原生 Turn 并记录取消意图，流式阶段返回 `indeterminate`；此时启动器为 `exited`、workspace guard 为 `released`，即进程树已核实静止。之后只读 `reconcileTask` 查得**同一 Turn** 的原生状态 `interrupted`，Task 收敛为 `cancelled`，未再发送 `turn/start`。记录位于忽略的 `.local/verification/codex-app-server-process-cancel-e2e/summary.json` 与 `reconcile.json`。这证明一种真实通知丢失时序可恢复，不覆盖上一段的极早空 rollout 时序。改成分页读取后，再对该真实 Thread/Turn 只读查询，仍返回同一 `interrupted` Turn 和 `cancelled` 观察。

## 后续接入边界

下一步需要验证真实审批等待、更多中断时序、长历史的真实分页表现，以及发送/回执/断线各时点的恢复矩阵。Luna 真实多轮仍受当前 inference 配额限制。保留现有 exec 路线；未完成故障矩阵及安装版验收前，不改变公开 Codex capability。

## 2026-09-24：公开显式预览路线

在请求 Schema 增加 `execution.codex_transport="app-server"`，仅允许 Windows 上的 `target=codex`、`model=gpt-6-astra`。默认 Codex 顶层 capability 仍为 `resume=false/fork=false` 和 `cli-jsonl`；单独的 `opt_in_transports.app-server` 描述预览能力。CLI、MCP 源 Schema、policy、TaskService、注册事件和标准 Worker 已贯通。来源不是已核实 app-server Turn 时在注册前拒绝续接。未指定字段的任务仍走原 exec。

使用源码公开 CLI `submit --request` 和四个真实 Astra Worker，在隔离的 `.local/verification/codex-app-server-public-cli-e2e/` 工作区完成 `start → continue → fork-from-older-start → branch-continue`。脚本退出码 0 并输出 `PUBLIC_CLI_APP_SERVER_E2E_PASS`。四条 Task 均 `sent/completed/succeeded`；主线 Thread `01a0cf11-d7f0-7890-b6d2-818dca3df5dc`，fork Thread `01a0cf12-d8ad-7620-9e1c-3b34c46ebafa`，两条分支共享 fork Thread。首轮、续接和旧来源 fork 均回复 `UAGENTS_PUBLIC_CLI_START`，分支续接回复 `UAGENTS_PUBLIC_CLI_BRANCH`。`model_verified=false` 仍保留，因为没有可信原生模型自报。

公开预览暂不包含 Luna、非 Windows、原生附件、审批自动处理或完全可靠的极早中断恢复。默认 exec 能力不变。旧来源 fork 的原生 Turn 边界已有上面的真实只读历史证据；本次公开 CLI 脚本主要验证入口、选择和 Worker 接线。

本版源码回归命令 `node --test --test-concurrency=4 tests/codex-app-server.test.mjs tests/codex-cli.test.mjs tests/unified-cli-adapters.test.mjs tests/plugin-package.test.mjs tests/durable-checkpoints.test.mjs tests/runtime-crash.test.mjs tests/queue-recovery.test.mjs tests/entrypoint-recovery.test.mjs tests/sqlite-store.test.mjs tests/protocol.test.mjs tests/registry-policy.test.mjs` 为 **154/154 PASS**。Unified MCP 在自身目录重建 bundle 后执行 `node --test test/server-smoke.test.mjs` 为 **14/14 PASS**，并检查已打包的 `codex_transport` Schema。`validate_plugin.py` 通过，`git diff --check` 退出码 0。首次并行回归曾有一个 2 秒 fixture 首轮超时，单独重跑通过；把该夹具的观察超时调整为 4 秒后全组通过。MCP 冒烟测试必须从 `plugins/uagents/mcp/unified` 运行，根目录调用会令其相对的 `dist/server.mjs` 找不到并超时。

已按个人 marketplace 配置将 21 个变化/新增插件文件同步到 `C:\Users\24590\plugins\uagents`，每个文件复制后校验 SHA-256；该目录的插件校验通过，直接运行其 CLI 显示默认 `cli-jsonl/resume=false/fork=false` 和 Windows/Astra `opt_in_transports.app-server`。使用这个 marketplace 源副本再次运行独立的四轮真实 Astra CLI 链路，`PUBLIC_CLI_APP_SERVER_E2E_PASS`，四条 Task 均为 `sent/completed/succeeded`，见忽略的 `.local/verification/codex-app-server-marketplace-source-e2e/summary.json`。

按 plugin-creator 更新流程刷新 manifest 为 `0.2.0-alpha.1+codex.20260923163647` 后，首次 `codex plugin add uagents@personal` 以退出码 1 拒绝切换：`failed to activate updated plugin cache version ... while ... remains active`。当时的任务仍加载旧缓存，因此没有通过卸载活跃插件规避限制；下一轮重试和安装版验收见下节。

## 2026-09-24：安装缓存激活与验收

在下一轮任务中，`codex plugin add uagents@personal --json` 返回退出码 0，安装版本 `0.2.0-alpha.1+codex.20260923163647`，缓存路径 `C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260923163647`。缓存目录的 `validate_plugin.py` 通过；仓库、marketplace 源与安装缓存的 `src`、`skills`、MCP bundle 和 manifest 共 89 个文件逐一 SHA-256 一致。直接从缓存目录运行 CLI，`capabilities codex` 显示默认 `cli-jsonl/resume=false/fork=false`，以及 Windows/Astra 的 `opt_in_transports.app-server`；`schema request` 包含 `execution.codex_transport`。

随后从**安装缓存 CLI 路径**、隔离的 `.local/verification/codex-app-server-installed-cache-e2e/` 状态目录运行真实 Astra `start → continue → fork-from-older-start → branch-continue`。脚本退出码 0 并输出 `PUBLIC_CLI_APP_SERVER_E2E_PASS`；四条 Task 均 `sent/completed/succeeded`，主线 Thread `01a0cf29-7326-7973-96f1-50c768e5426f`，fork Thread `01a0cf2a-1384-7f60-ae8c-47926315eaa1`，来源回复与分支回复严格符合断言。至此安装版显式预览链路通过；极早中断、审批、外部并发推进和 Luna 路线仍按上文限制处理。

## 2026-09-24：极早中断历史的只读复查

对上文已记录的极早中断 Thread `01a0ce90-cdae-7c70-88e6-e5fd564506a3` 再次只读调用本机 `codex-cli 0.153.4` app-server：`thread/read` 与 `thread/turns/list` 均返回 RPC `-32603`，指出该 Thread 的 rollout 文件为空；`thread/items/list` 返回 `-32601` 不支持。对另一条已完成真实 Thread 再执行现有 `readCodexAppServerTurn`，按已知 Turn ID 和 `clientUserMessageId` 均仍恢复为同一成功回复。故空 rollout 的错误**不能**证明取消成功，也没有足够证据定位已接受 Turn 的终态；维持 `indeterminate`，禁止重发 Prompt。官方 [Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)将 `thread/items/list` 标为实验能力，说明活跃线程存储不支持项目分页时会返回不支持；这与本次空历史错误一致，但不是空 rollout 成因的证明。

新增本地 app-server 故障夹具模拟 `turn/start` 已回执、后续原生历史不可读的情形。TaskService 只读 reconcile 后保持同一 Turn 的 `indeterminate`/`sent`，工作区仍只有一次 `turn/start`。这锁定了当前安全降级行为；恢复极早中断仍需原生可读终态或新的权威证据接口。

加入该回归后，同一组 Codex、Runtime、Registry 和协议测试重跑 **155/155 PASS**；本次只新增测试夹具与验证记录，安装缓存中的运行时代码未变。

## 2026-09-24：项目分页不支持时的只读回退

本机生成的协议 Schema 将 `Turn.itemsView="full"` 定义为包含该 Turn 在 app-server 持久历史中可用的全部 ThreadItem。真实 `codex-cli 0.153.4` 的已完成 Thread 只读探测返回 `itemsView="full"`，该 Turn 有 `userMessage` 和 `agentMessage` 各一项；同一 Turn 的 `thread/items/list` 也返回两项。探测未发送 Prompt，见忽略的 `.local/verification/codex-app-server-full-items-probe.mjs`。

只读 reconcile 先沿用项目分页；仅当 `thread/items/list` 明确返回 RPC `-32601` 时，改用 `thread/turns/list(itemsView="full")` 倒序分页重查。回退要求目标 Turn 明确声明 `itemsView="full"`，仍限制页数、检测游标循环，并对丢失 Turn 回执的 `clientUserMessageId` 查完整历史与重复匹配。分页、完整性或身份无法证明时保持 `indeterminate`，不重发 Prompt。真实极早空 rollout 的 `thread/read` 本身仍报错，该路径无法恢复它。

本地故障夹具覆盖已知 Turn、丢失回执且超过一页历史、重复 client ID、以及原生声称未加载完整项目的拒绝路径。相关 34 项 Codex app-server 定向测试通过。完整相关回归首次为 **156/157 PASS**：原有取消测试在并行负载下超过固定 1 秒等待窗口，测试提前关闭数据库产生异步错误。将其改为有截止时间的等待、延长该夹具观察时间，并在关闭数据库前等待 Worker 完成后，原命令重跑为 **157/157 PASS**。新增回退尚未在真实 `-32601` 的健康 Thread 上触发；真实探测只验证了 `full` 数据形态，因此仍保留模拟故障与真实运行的证据边界。

按 `plugin-creator` 更新流程刷新缓存版本至 `0.2.0-alpha.1+codex.20260923171446`，将 manifest 与传输文件同步到个人 marketplace，逐文件 SHA-256 对照通过；`codex plugin add uagents@personal --json` 返回退出码 0。安装缓存的这两个变更文件与源码哈希相同，插件校验通过。从**新安装缓存**导入 `readCodexAppServerTurn`，使用模拟 `-32601` 的本地 stdio 夹具分别按已知 Turn ID、client ID 只读恢复同一回复，输出 `INSTALLED_FALLBACK_PASS`，工作区没有 `turn/start`。此验收覆盖安装版代码接线，未向真实模型发送新任务。

## 2026-09-24：原生审批的源码原型

在 app-server 传输中识别命令执行和文件改动两类 server request，只在已接受 Turn 的 Thread/Turn/Item/请求 ID 匹配后交给 Worker；无处理器、未知种类、错身份、重复 ID 均不自动答复。请求可能先于 `turn/start` 回执到达，先缓冲并在 accepted 检查点后验证。只有上层返回 `accept|decline|cancel`，且 `approval.response_maybe_sent` 已持久化后，才向原 stdio 连接写 JSON-RPC 响应；本地写入后追加 `approval.response_sent`。

Worker 在 `dispatch` 内把完整请求写入 Task 私有文件，事件只存哈希和 Thread/Turn/Item/进程身份，Task 进入 `waiting_user`，但保持原 Worker、连接、心跳与 workspace guard。`uagents status` 给出待审 ID，`uagents approval <task-id> --approval-id <id>` 读取完整请求并核对哈希；加 `--decision accept|decline|cancel` 才记录显式决定。相同决定重复调用只返回既有状态，冲突决定拒绝。通用 MCP 没有写审批工具，也没有自动批准。CLI 返回 `decided` 表示决定已记录，不等于原生已执行或 Task 成功。

本地 stdio fixture 验证命令 `accept/decline/cancel`、文件改动 `decline`、请求先于 Turn 回执、CLI 另一数据库连接写决定、身份不匹配、重复请求、私有文件篡改、无决定超时，以及 Worker 在等待态崩溃后只读恢复。超时/崩溃路径均只有一次 `turn/start` 且没有审批响应。此阶段的完整相关回归 **161/161 PASS**。权限 profile 请求、会话级授权及安装缓存验收仍需补证。

随后增加同时两个请求、等待时取消及审批答复写入失败的定向夹具：两个请求分别收到一次决定后 Task 才离开 `waiting_user`；取消只在同一原生 Turn 的 `interrupted` 终态后确认；写入失败发生在 `approval.response_maybe_sent` 之后，结果保持不确定且没有审批答复。三个定向测试通过，尚未计入上面的 161 项完整回归次数。

使用真实本机 `codex-cli 0.153.4`、独立工作区与仅本次探测进程的 `approval_policy="on-request"`、`sandbox_mode="read-only"` 配置，发送一条要求创建隔离文件的 Astra Prompt。真实 app-server 给出已接受的 Thread `01a0cf5f-1948-79c3-b902-88ad06111f23`、Turn `01a0cf5f-1a11-75b2-a753-4745f70c7881`，随后发出 `item/commandExecution/requestApproval`，请求 Thread/Turn 完全匹配。传输仅答复 `decline`，原生 Turn 最终为 `completed`、传输为 `sent/succeeded`，文本报告拒绝审批且不再尝试其他方法；隔离目标文件不存在。脚本和摘要在忽略的 `.local/verification/codex-app-server-real-approval-decline/`。这是**真实传输拒绝路径**，没有经过 TaskService 的 CLI 决定入口，也未验证真实同意或安装缓存。

加入同时两审批、等待时取消、答复写入失败、等待态 Worker 崩溃与请求文件哈希检查后，完整相关回归重跑 **165/165 PASS**。`approval.response_maybe_sent` 在写入原生 stdin 之前持久化；如果写入失败、进程失联或原生终态不可读，Task 保持不确定，不补写原审批答复，也不重发 Prompt。

再用源码 TaskService、标准 `runTask`、独立 CLI 数据库连接及真实 Astra 做完整**拒绝**链路。仅此测试的 app-server 启动参数覆盖 `approval_policy="on-request"`、`sandbox_mode="read-only"`，并纳入原生进程启动指纹；公开请求没有绕过或自动批准选项。Task `7510277e-f47f-4bcf-92bf-09e06d2d2f0d` 出现 `waiting_user`，CLI 按审批 ID 读取原生命令后记录 `decline`，Worker 在原 stdio 连接答复。原生 Thread `01a0cf64-581d-71a1-939a-265f1d4a6980`、Turn `01a0cf64-58e8-7771-9f87-a8f01aec46b1` 最终 `completed`，Task 为 `sent/succeeded`，目标文件不存在。事后只读审计确认 `approval.requested → decided → response_maybe_sent → response_sent` 各一次、进程 `exited`、workspace guard `released`，启动指纹与实际含测试配置的 argv 一致。脚本、摘要与审计在忽略的 `.local/verification/codex-app-server-real-approval-cli-decline/`。真实同意、权限 profile 与安装缓存仍未验收。

按个人 marketplace 更新流程刷新插件为 `0.2.0-alpha.1+codex.20260923175317`，11 个变化/新增插件文件同步后与源码 SHA-256 一致；`codex plugin add uagents@personal --json` 退出码 0，安装缓存通过插件校验。直接导入该缓存的 TaskService、Worker、Adapter 和 CLI，用 stdio fixture 执行审批拒绝，输出 `INSTALLED_APPROVAL_PASS`，仅一次 Turn、一次 `decline` 答复，进程 `exited`、guard `released`。再用相同安装缓存执行真实 Astra Task `7b27d165-a0b6-4e4d-9950-ec76fba69b59`：出现 `waiting_user`，缓存 CLI 读取请求并记录 `decline`，原生 Thread `01a0cf69-0b86-75a3-aa82-5b1582dfefbb`、Turn `01a0cf69-0c58-7c41-9b93-5f79708fc656` 为 `completed`，Task `sent/succeeded`，隔离目标文件不存在；四个审批事件各一次，进程和 guard 均已释放。摘要在忽略的 `.local/verification/codex-app-server-installed-real-approval-decline/`。安装版真实同意和权限 profile 仍未验收。

最后仅更新技能说明中的证据边界（真实拒绝已验证、真实同意未验证），按相同流程刷新并安装缓存版本 `0.2.0-alpha.1+codex.20260923175733`。manifest、技能说明及关键运行时代码与源码哈希一致，安装缓存插件校验通过；其 CLI `describe approval` 返回明确的审批 ID 与决定参数。运行时代码与上一缓存版本一致，因此没有重复发起 Provider 任务。

之后为等待态的原生 Session 状态补充 `approval_pending → inProgress` 元数据，更新个人缓存为 `0.2.0-alpha.1+codex.20260923180404`。安装版夹具返回 `INSTALLED_APPROVAL_PASS`；这是后来简化之前的历史构建。

## 2026-09-24：按调度层边界简化 Codex 接入

参照 OpenCode CLI 由目标原生配置管理权限的边界，撤回 uAgents 自行保存、等待和答复 Codex app-server 审批的原型。删除 TaskService/Worker 审批队列、私有请求文件、`approval` CLI 命令及原连接决定回写；保留已验证的 Thread/Turn 身份、续接、fork、进程 guard 和只读恢复。现行 app-server 若收到原生审批 server request，仅记录 `native_approval_required`，该已发送 Task 为 `indeterminate`，不会回写 `accept/decline/cancel`，也不会重发 Prompt。上文真实拒绝路径仅说明**旧构建**曾正确处理审批，不再代表当前提供审批代理。

本地夹具验证命令审批与文件改动审批均只有一次 `turn/start`、零次审批响应；TaskService 路线覆盖审批请求早于和晚于 Turn 回执两种顺序，均留下 `native_approval_required`、没有审批事件，Task 为 `indeterminate`。续接/fork 和崩溃恢复保持原测试覆盖。相关 6 个测试文件合计 **116/116 PASS**。崩溃恢复用例曾在批量负载下触发固定等待窗口，单测通过；改为有截止时间的等待后，同一批测试通过。

按个人 marketplace 流程安装简化构建 `0.2.0-alpha.1+codex.20260923182335`。安装缓存通过插件校验，9 个关键文件与仓库源码 SHA-256 一致。缓存代码经真实 TaskService→Worker→CodexAdapter→stdio 夹具验证，Task `dd4902df-316b-41c6-913d-c72d73227822` 为 `indeterminate/native_approval_required`，一次 `turn/start`、零审批响应、进程 `exited`、guard `released`。隔离工作区和摘要在忽略的 `.local/verification/codex-app-server-installed-simplified/`。

再用同一安装缓存和本机真实 Codex CLI/Astra 原生配置执行无工具分析任务，Task `ae1fdc10-44f6-405c-89cc-6e5e18ec65f9` 为 `sent/succeeded`，原生 Turn `completed`、回复 `UAGENTS_OK`，进程 `exited`、guard `released`。摘要在忽略的 `.local/verification/codex-app-server-installed-simplified-real/`。此真实测试证明无需交互的路径正常；审批路径由安装版 stdio 夹具证明，当前简化构建未让真实 Provider 触发审批。

自动权限审查阻止删除个人插件源码目录中的旧 `src/runtime/codex-approvals.mjs` 单文件，所以安装缓存仍包含这个未引用的历史文件。仓库源码已删除该模块，现行 Worker、TaskService、CLI 和传输均不导入或调用它；安装版上述测试在此条件下运行。清理个人插件目录中的遗留文件尚待允许的删除方式。

随后同步更新 Agent 执行参考中的 Codex 会话和权限说明，按个人 marketplace 流程刷新安装缓存为 `0.2.0-alpha.1+codex.20260923184244`。这一步仅改说明文件与 manifest，运行时代码同上一构建。安装缓存插件校验与 Skill 校验通过；最终工作树执行 `npm test`（核心、Doubao、TRAE、Unified MCP 测试）退出码 0，`git diff --check` 通过。新缓存没有重复发起 Provider 请求。
