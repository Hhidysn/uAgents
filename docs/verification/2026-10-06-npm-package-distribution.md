# npm 包分发验证

Date: 2026-10-06 (Asia/Shanghai)

Revision: 分支 `npm-cli-distribution` 工作树，基线提交 `1ac20c1`
Environment: Windows, Node.js v24.13.0, npm 11.17.0

本记录只覆盖"从 Codex 插件形态改为可全局安装的 `uagents` 命令"这一改动。方案与取舍见 [决策记录](../decisions/0001-npm-cli-distribution.md)。

## 范围的当前状态

| 切片 | 状态 | 证据 |
| --- | --- | --- |
| 包清单、`bin`、MIT 许可证、`files` 白名单 | 已实现并验证 | `tests/package-distribution.test.mjs`、`npm run test:pack` |
| 适配器按目标动态加载 | 已实现并验证 | 同上第 4 条：只含核心的副本仍服务其余目标 |
| 下线 `.codex-plugin/` 与 `.mcp.json` | 已实现并验证 | 同上第 1 条 |
| 打包内容核对脚本与 CI | 已实现，CI 尚未真实运行 | `scripts/check-pack-contents.mjs`、`.github/workflows/ci.yml` |
| 已安装包的真实任务派发 | 已验证（agy） | 见下 |
| opencode 宿主的真实调用 | 已验证（带原生 `--auto`） | 见下 |
| pi 宿主的真实调用 | 已验证 | pi 直接调用命令，以及 pi → uagents → opencode → uagents 整链 |
| 豆包工作 / TRAE 真实任务 | 未验证 | 见下 |
| 便捷命令（一句话 run）与 `skills install` | 已实现并验证 | `tests/cli-convenience.test.mjs` 8/8；本机真实 `run` 失败路径见下 |
| 历史查询（`list` 过滤、`sessions` 聚合、MCP 对应工具） | 已实现并验证 | `tests/cli-history.test.mjs` 5/5；本机真实状态目录查询见下 |
| 两个已知失败的测试 | 已修复（改测试等待预算，未改断言，未跳过） | `tests/codex-app-server.test.mjs`：`FIXTURE_OBSERVATION_TIMEOUT_MS` / `CANCELLATION_OBSERVATION_TIMEOUT_MS`，根因与证据见下 |

## 实际执行的检查

`npm run test:pack`（对 `npm pack --dry-run` 的结果核对）：

```json
{ "package": "uagents@0.2.0-alpha.1", "files": 156, "size": 1766802, "unpackedSize": 6258222, "required": 20 }
```

第一次运行就失败在 `mcp/unified/THIRD_PARTY_NOTICES.md`：`files` 白名单只写了 `mcp/unified/dist/`，unified bundle 的第三方声明与许可证因此没有进包。修正白名单后通过。这正是该脚本存在的理由——`files` 白名单测试只能证明"写下的路径存在"，不能证明"没写下的必要文件也进了包"。

`node --test tests/package-distribution.test.mjs`：4/4 通过。第 4 条把 `src`、`bin`、`scripts` 复制到临时目录、**删除两个桌面目标目录**后运行：`targets` 仍列出 8 个目标，`capabilities codex` 正常，`models trae` 退出码 1 且返回 `unsupported_capability` / `Target adapter is unavailable in this installation: trae`，`details.cause_code = ERR_MODULE_NOT_FOUND`。改造前这条路径会因为 `src/adapters/index.mjs` 的静态导入让所有命令一起崩。

临时前缀下的真实安装：

```powershell
npm pack --pack-destination <tmp>
npm install -g --prefix <tmp-prefix> <tmp>/uagents-0.2.0-alpha.1.tgz
```

安装生成 `uagents` / `uagents-service` / `uagents-mcp-bridge` / `uagents-checkin` 四组 shim。在一个与仓库无关的工作目录运行：`uagents describe` 返回 `executable: "uagents"`、25 条命令（本轮新增 `run`、`skills` 与 `sessions` 后为 28 条）；`uagents targets` 返回 8 个目标；`uagents capabilities codex` 返回完整描述符。

`npm test`（完整仓库回归）：**473 项中 473 通过、0 失败、0 skip**，加 MCP 子包 22 + 55/1 预存在 skip + 11 + 11 + 27；退出码 0。得到这个结果前，同一命令在本机上表现出负载敏感的间歇红，详见下两段。

改动前基线：`npm test` 465 项中 463 通过、2 失败，两条都在 `tests/codex-app-server.test.mjs`（`preserves cancellation failure reason when no terminal arrives`、`recovers a cancelled Turn when the terminal notification was lost`，均为期望 `indeterminate` 而得到 `cancelled`）。在 `HEAD`（`1ac20c1`）的独立 worktree 中运行完整 `npm test`：464 项中 11 失败，失败集合不同但类别相同（`tests/codex-app-server.test.mjs`、Council 验证/adopt/cleanup、OpenCode 恢复、worker heartbeat），全部是进程启动、进程树确认或租约时序敏感的用例。因此这是**基线既有失败**，不是本次改动引入的；仓库此前没有 CI，所以没有被发现。

根因（由 [本地 CLI 与完整回归复核](2026-10-06-local-cli.md) 定位，本轮复验并延伸到其他用例）：**测试的等待预算短于本机原生进程检查耗时**。`inspectProcess` 实测 1516/1585/1561 ms、`inspectProcessTree` 1732/1846/1607 ms；而这两条用 `for (let i = 0; i < 100; i++)` + 10 ms 轮询等待 `dispatch.accepted`，预算只有 1 s，测试因此在**发送前**就发起取消，被正确记为 `cancelled`（`worker.mjs` 中 `cancel_requested && submission === 'not_sent'`）。本轮用 14 个进程制造 CPU 饥荒后单独运行第 236 行用例，得到 `error.code = process_tree_unconfirmed`、`submission = not_sent`、2662 ms：adapter 启动 fake app-server 后无法在预算内确认进程树已静止，于是正确 fail-closed。两处都是环境预算问题，不是取消语义缺陷，也不是断言错误。

修法（只改测试的等待预算，不改任何断言）：把该文件中断言 `succeeded` 的成功路径观察窗口统一改为具名常量 `FIXTURE_OBSERVATION_TIMEOUT_MS = 30_000`（fixture 本身在几十毫秒内完成，该值只是安全上限）；两条取消用例改用 `CANCELLATION_OBSERVATION_TIMEOUT_MS = 10_000` 并把等待 `dispatch.accepted` 的轮询上限从 100 提到 1_000（同 10 s）。预期超时的用例（如 approval 系列）保持原预算不变，因为那里的窗口长度本身就是被测行为。复验：该文件单独运行 37/37 通过、0 skip；完整 `npm test` 473/473、退出码 0。

中途的弯路已纠正：一开始按“注释掉失败的测试”把这两条改成 `{ skip: ... }`，并把原因写成“观察结束与取消请求之间的竞态”。读了 [本地 CLI 的实测记录](2026-10-06-local-cli.md) 后确认这个理由不成立（把等待上限放宽到覆盖一次进程检查后 6/6 次都得到 `indeterminate`，不存在随机落点），于是取消 skip、恢复真实断言并修正预算。

## 已安装包的真实任务派发

用 `/tmp` 前缀下全局安装的包，在临时状态目录（`UAGENTS_AUTO_CHECKIN=0`，不碰真实状态与签到注册）派发一次只读分析任务：

- task: `af72d4dd-cee3-460d-8a66-d82eed8fc1d6`，target `agy`，route `agy/gemini-3.8-flash-medium`
- 中间状态：`starting/not_sent` → `starting/may_have_been_sent` → `succeeded/sent`
- `model_resolved = gemini-3.8-flash-medium`，`model_reported = gemini-3.8-flash-medium`，`model_verified = true`
- 返回文本：`UAGENTS_PACKAGE_E2E_OK 11`

这条证明了安装包能真实派发到原生 CLI、持久化状态并可查询结果，而不只是发现类命令可用。

## opencode 与 pi 作为宿主

第一次尝试用内置路由 `commandcode-goat/deepseek/deepseek-v4-flash` 派发给 opencode，任务以 `failed / native_error / details.native_error_name = provider.no-route` 结束（task `6027754d-df50-4d0a-9d4e-6dcd413b0ad9`）。原因是本机 opencode（v2.0.21）自己的模型目录里没有 `commandcode-goat/*`（`opencode models` 列出 583 条，provider 是 agentrouter / deepseek / google / nvidia / openai / opencode-go / opencode / openrouter / sf）。uAgents 把这两条内置路由标成 `usable: false`、`discovered: false` 正是在报告这件事：路由被声明，但本机原生目录里不存在。改用本机真实存在的 `opencode-go/deepseek-v4-flash` 后可以派发。

第二次尝试时 opencode 的权限层拒绝了命令执行（非交互运行无法向用户申请权限），任务停在 `waiting_user`。请求里显式加 `execution.native_args: ["--auto"]`（opencode 自己的原生选项）后执行成功：

- task `4c74bc1f-86fa-434a-9948-f95cd436d46e` → opencode 返回 `HOST_OPENCODE_OK 8` 和 `uagents targets` 的原始 JSON。

pi 侧两条路径都验证了：

- pi 直接执行 `node <pkg>/bin/uagents.mjs targets` 并把原始 stdout 回报（退出码 0）。
- 整链 pi → `uagents submit` → opencode → `uagents targets`：pi 执行 submit 得到 task `3d060295-c020-478e-ad2e-2f5ae536c9c3`，该任务让 opencode 运行 `uagents targets`，最终回答 `PI_CHAIN_OPENCODE_OK 8`。

## OpenCode V2 完成状态观察（本次未修）

上面两条 opencode 任务都在拿到完整回答后停在 `indeterminate` / `native_completion_unconfirmed`（对 `4c74bc1f` 调用 `reconcile` 后仍是 `indeterminate`、`native = accepted`）。`docs/current/agents.md` 记录 V2 文本同 Attempt 恢复是已实测的，所以这里要么是环境差异（本机 opencode v2.0.21）、要么是那之后引入的回退；本次只做打包，没有调查。需要时应当作独立任务处理。

## 便捷命令（`run` / `skills install`）

`run` = `submit` + 等待终态 + `result`，返回与 `result` 完全相同的载荷；`--no-wait` 只登记。它每次生成新 UUID，因此一条便捷命令不可能被幂等合并到旧任务。等待循环在四种情况退出：终态、`waiting_user`、本地 Worker 无法启动（`run_not_started`）或超时（`run_wait_timeout`）；后三种都返回最后持久化的状态并追加 warning，不猜结果、不重发 Prompt。退出码 0 仅当最后状态为 `succeeded`（`--no-wait` 时为已登记）。`--timeout-ms` 只约束本地等待；native 进程由请求里的 `observation_timeout_ms` 停掉（默认 120000），所以 `run` 另有 `--observation-timeout-ms <ms>`（1000–1200000）与 `--execution-timeout-ms <ms>`（1000–86400000，仅对能强制该预算的目标有效，其余目标 `unsupported_capability` 拒绝）。未显式给 `--timeout-ms` 时，本地等待取 `max(900000, observation + 60000)`，避免刚放宽 native 截止时间却被本地等待提前打断。

本机真实链路（不是替身适配器）：

```powershell
uagents run agy --model definitely-not-a-model --workspace <tmp> --prompt-file prompt.txt --state-dir <tmp>/state
```

返回 `status: "failed"`、`error.code: "native_preflight_failed"`、`submission: "not_sent"`、`response.text: ""`，退出码 1。这条同时验证了：真实 detached worker 的启动、等待循环的终态判定、失败任务不被写成成功、以及未发送时没有花任何额度。

`skills install` 写入 `<dir>/agent-dispatch`（内容与包内 `skills/agent-dispatch` 逐字节相同的 `SKILL.md` 与 11 个 references）；`--dry-run` 不落盘；目标已存在且未加 `--force` 时返回 `request_conflict` 且 `submission: not_sent`；`--force` 会先删除旧目录再复制，避免升级后残留已删除的文件；相对 `--dir` 返回 `invalid_request`。以上均在本机以真实命令执行过。

完整 `npm test` 现在退出码为 0（473/473，0 skip）；两条 Codex app-server 取消用例按上文的方式恢复了真实断言与可用预算，没有跳过任何用例。

## 历史查询（`list --target/--has-response`、`sessions`、MCP `uagents_list_sessions`）

新增的是只读本地查询，不发 Prompt、不联系 Provider、不改写任何任务状态：

- `list` 增加 `--target <t> ...`（可重复，按 registry 校验）与 `--has-response`（只看已持久化的非空 `response.txt`）。response 存在任务目录而不是 SQLite 里，因此过滤在分页之后发生；`next_cursor` 改为指向**最后一个被扫描的行**而不是最后一个返回的行，这样过滤掉的行不会被跳过——测试里用 `--has-response --limit 2` 翻完 3 条命中任务，无重复无遗漏。
- `sessions` 用一条 SQL 按“任务的最新 attempt 的最新 native session”聚合（与单任务 `status()` 的口径一致），每行给出 `target`、`native_session_id`、`task_count`、`first_task_id`/`latest_task_id`、`latest_status`、`started_at_ms`（最早成员的创建时间）/`updated_at_ms`（**最新成员的更新时间**，即会话的最后活动）、`lineage`（首条任务的 `continue`/`fork` 与来源 task，从该任务的 `payload.json.session` 读取，因为解析后的会话绑定不在 `decision_json` 里）与最多 20 条按时间正序的 `tasks` 窗口（超出时 `tasks_truncated=true`）。没有 native session 的未派发任务不进入任何会话行。排序与游标用 `(updated_at_ms, native_session_id, target)` 三键，因为分组键包含 target。
- MCP 侧 `uagents_list_tasks` 增加 `target`/`has_response` 输入，并新增 `uagents_list_sessions`，保证只有 MCP 入口的宿主也能读历史；工具数从 20 变 21。

证据：

- `tests/cli-history.test.mjs` 5/5：过滤与游标语义、会话分组（同一 `native_session_id` 的两条任务聚合为一行、`fork` 行的 `lineage` 指向来源 task）、`--target` 过滤、按会话分页、未知 target 返回 `invalid_target`、坏 cursor 返回 `invalid_request`、`describe` 选项列表。测试用可控适配器自己指定 native session ID 与 response 文本，并让两条任务共享同一 session，因此断言的是真实聚合而不是造出来的行。
- 本机真实状态目录（既有任务，非测试构造）：`list` 返回任务并带 `next_cursor`；`list --target agy` 只返回 agy；`list --has-response` 只返回有回答的那一条；`sessions --limit 5` 返回 3 条真实会话（opencode 的 `ses_f453656e…` `task_count=1`/`succeeded`，workbuddy 两条 `failed`），未派发任务不在其中。
- `npm --prefix plugins/uagents/mcp/unified test`：28/28（含新增的 MCP 转发断言与 21 工具清单断言）。
- 完整 `npm test`：489/489、0 失败、0 skip；`npm run test:pack`：157 文件、required 20 项通过；MCP 子包 28/28。
- 打包 tarball 真实安装后 `scripts/verify-installed-package.mjs` 通过（含新增的 `run` native 截止时间参数断言）。

已知边界（未修，已写入 CLI 与 MCP 文档）：看不到原生 CLI 自己的历史；只有共用同一状态目录的入口互相可见；`sessions` 的 `lineage` 描述的是该会话首条任务如何分支，续接/分叉本身仍需要新 UUID 的 `submit`，不是查询动作。

## 检视发现的 4 个 P2 修正

外部检视在“1ac20c1 + 本轮未提交修改”上报告了 4 条 P2。逐条复现后确认全部成立（无一条误报），已修：

1. **`skills install --force` 可删除自身源文件**。`installSkill` 先 `rmSync(destination)` 再 `cpSync(source, destination)`；当 `--dir` 指向包自身的 `skills` 目录时 `destination === source`，源先被删掉再复制失败。复现（临时副本）：`before 12 files → threw ENOENT → after 0 files`。修法：写盘前用 realpath 比较，源与目标重合、或互为祖先时直接 `invalid_request`，不做任何删除；`--dry-run` 同样被拒。复验：三种重叠形态均返回 `invalid_request`，源目录 12 个文件完好。
2. **适配器加载失败后任务永久 `registered`**。`runRegisteredTask` 中 `adapterFor(...)`/`supervisorFactory(...)` 在 `runTask` 之外，抛错时无人记录；而 worker 子进程是 `detached` + `stdio: 'ignore'`，`api.mjs` 只监听 spawn 的 `'error'` 事件，所以失败完全不可见。复现（只有 `bin/src/scripts` 的副本）：`runRegisteredTask threw unsupported_capability` → `after status: registered | submission: not_sent | error: null`。修法：捕获后先转 `queued` 再走 `recordLeaseWait` 同款可恢复错误路径，`error.code = worker_start_failed`（消息里带上我方错误码与原因），任务保持 `queued`/`not_sent` 以便 `resume` 重试；同时 `run` 的等待循环遇到 `worker_launch_failed`/`worker_start_failed` 立即返回并附 warning `run_not_started`，不再空等 15 分钟。复验（同一副本，真实 detached worker）：1.1 秒返回、退出码 1、`status queued`、`submission not_sent`、`error.code worker_start_failed`、`warnings ['run_not_started']`；随后 `resume` 仍能重试并再次记录同一原因。
3. **会话 `updated_at_ms` 实为创建时间**。分组查询用了 `max(created_at_ms)`，成员后续运行/完成不会更新会话时间，排序也不会把刚结束的老会话上浮；同一载荷里成员 `updated_at_ms: 999` 而会话 `100` 自相矛盾。修法：改用 `max(updated_at_ms)`，排序与游标同步。复验：`started 100 | updated 999 | member updated 999`，且该会话排在首位。
4. **会话分页可能漏项**。分组键是 `(target, native_session_id)`，但 `ORDER BY`/`HAVING` 只比较 `(时间, native_session_id)`；跨目标同名会话且时间相同时，游标会跳过整组。修法：排序、`HAVING`、游标统一为 `(updated_at_ms, native_session_id, target)` 三键。复验：`limit 1` 逐页翻完 3 组，`opencode/shared-id` 不再丢失（修前它从未返回）。

测试补充：`tests/cli-convenience.test.mjs` 新增“拒绝与自身源重叠的 `--dir`”（含 `--dry-run` 与“目标在源内部”两种形态，并校验源目录完整）；`tests/cli-history.test.mjs` 新增“会话按最新成员活动排序”与“跨目标同名会话分页不漏项”；`tests/package-distribution.test.mjs` 的 core-only 用例新增真实 `run trae` 断言（`worker_start_failed` + `run_not_started`）。

## 第二轮检视发现的 3 个 P2 修正

外部检视第二轮报了 3 条 P2，逐条复现后全部成立，已修。

1. **重复 Worker 的启动失败会覆盖正在执行的任务状态**。`recordWorkerStartFailure` 写盘前不看活跃租约，而健康 Worker 在拿到共享资源前一直持有 `task:<taskId>` 租约（`worker.mjs` 等待循环）。复现（`.local/p2/repro1.mjs`）：让健康 Worker 因 target 槽位被占而停在资源等待，再由一个加载失败的重复 Worker 写盘——`persisted during healthy wait -> status queued | submission not_sent | error worker_start_failed`，而健康 Worker 随后照常派发并 `succeeded`。调用方（`run` 的等待循环）把该错误读成“Worker 从未启动”，结论是错的。修法：把该写入搬进 `TaskService.recordWorkerStartFailure`，在**同一事务内**先查 `task:<taskId>` 活跃租约，有主则原样返回当前状态、不写事件。复验：`error null`、事件里没有任何 `error` 载荷，健康 Worker 仍然 `succeeded`；租约释放后同一失败会被正常记录并保持 `queued`/`not_sent` 可恢复（core-only 副本的真实 `run trae` 用例仍能记录 `worker_start_failed`，证明不是把功能禁掉）。另在 `run` 的等待循环上加了一道保险：只有尝试尚未被 claim（`attempt.fencing_token` 为空）才允许得出 `run_not_started`。
2. **stdin 多字节字符被拆块时乱码**。`readStdin` 逐块 `chunk.toString()`，跨块的 UTF-8 字符各自变成替换字符。复现（`.local/p2/repro2.mjs`，逐字节分块）：`检视修改文件` → `������������������`（15 个 U+FFFD）。修法：改用 `node:string_decoder` 的有状态解码（`decoder.write` 循环 + `decoder.end()`），字符串块直通，1 MiB 上限在解码后仍逐块检查。复验：`run --prompt-stdin` 与 `submit --request-stdin` 两条路径都字节一致回读。
3. **观察期限的说明与持久目标行为不符**。`--observation-timeout-ms` 的描述和文档声称“到点目标进程会被停掉”，但那只适用于每任务一个进程的 transport（`agy-process.mjs:44` / `cli-process.mjs:156` 用它当杀进程定时器）。OpenCode V2 走 `observeDurableExecution`，到期只返回 `timed_out: true` → `indeterminate`，**不终止**原生进程，它可能继续运行并继续改文件；真正终止进程树的是 `execution_timeout_ms` 的 guardian（`execution_timeout` / `execution_timeout_termination_unconfirmed`）。行为本身早有用例锁定（`tests/durable-cli-execution.test.mjs` 的 “generic observation timeout never terminates the durable native process” 断言超时后 `process_state === 'running'`），所以这是纯文案缺陷：已改 `describe` 描述、`docs/reference/cli.md`（分开讲“观察期限”与“执行期限”）、包内 `AGENTS.md`/`README.md`/`SKILL.md`，并加了一条 describe 文案回归断言防止两种后果再被合并成一句。

## 真实下发验证（agy / gemini-3.8-flash-medium）

不是回放、不是 mock：3 次真实下发到 agy CLI，任务内容是真实修一个文件并写一份话题讨论（keyset 游标三键全序），产出由外部脚本独立判定。

- **第 1 次（`run`，默认截止时间）**：`status indeterminate`、`submission sent`、`response.txt` 0 字节、`error.code = deadline_remote_state_unknown`，创建到结束 122 秒。但工作区里文件**确实已被修改**（`paginate.mjs` 修好、`paginate.test.mjs` 3 测试通过、`NOTES.md` 13 行）。根因不是文本恢复：`transports/agy-process.mjs:44` 用 `request.timeout_ms`（= `observation_timeout_ms`，默认 120000）当杀进程定时器，而 `run --timeout-ms` 只管 CLI 等待，`run` 当时没有任何参数能放宽 native 截止时间。这是本轮 `run` 的真实缺陷，已修。
- **第 2 次（`submit --request`，`observation_timeout_ms: 600000`）**：165 秒后 `succeeded`，`model_verified true`，native 回复完整，`usage.total_tokens 144964`。
- **第 3 次（修好后的 `run --observation-timeout-ms 600000`）**：**195 秒、退出码 0、`succeeded`、无 warning**，`usage.total_tokens 168724`——同一个任务在旧默认下会在 120 秒被杀。

独立验证（同一份对抗脚本分别跑修前/修后，只看公开 API，不读 agent 自己的测试）：修前 `walked 3/5`、`ORDER OK false`（丢 2 行）；修后 `walked 5/5`、顺序与 `(updated_at_ms, native_session_id, target)` 全序完全一致、`no mutation true`、首页/尾页游标语义正确。新命令也在真实状态上验证：`sessions` 返回 2 个真实 agy 会话且按最后活动倒序，`list --has-response` 只返回有回复文本的那条。

另有 3 次未下发的尝试（`invalid_workspace` 相对 state dir、`model_unavailable` 无 approved default、`native_preflight_failed` 因为 `--model agy/xxx` 被二次加前缀成 `agy/agy/xxx`），全部 `submission: not_sent`，未消耗额度、未发出 Prompt。

## 未验证

- 豆包工作与 TRAE 的真实任务；`models trae` 只验证了缺失组件时的错误路径，没有在完整安装上运行。
- `.github/workflows/ci.yml` 在 GitHub 上的真实运行；本机只运行了它调用的两个命令。
- 非 Windows 平台上的任何行为。
