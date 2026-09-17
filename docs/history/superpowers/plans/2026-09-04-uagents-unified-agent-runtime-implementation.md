# uAgents 统一 Agent Runtime 可执行实施方案

日期：2026-09-04  
设计基线：`docs/superpowers/specs/2026-09-04-uagents-unified-agent-runtime-design.md`  
目标版本：`0.2.0-alpha.1`  
状态：可执行，按 Gate 顺序实施

## 1. 实施原则

- 采用模块化单体：本地优先 CLI 与一个可选 stdio MCP 共用同一 Core。
- SQLite WAL 只保存控制面；Prompt、大文本、输入快照和产物放任务目录。
- Task、Attempt、Native Session 分离；一个新 Task 首版只建立一个 Attempt。
- 所有外部发送之前必须完成 `possibly_sent` 持久化 checkpoint。
- `may_have_been_sent`/`indeterminate` 禁止自动重发。
- 每次调用始终保存 `model_requested`、`model_resolved`、`model_reported`、`model_verified`，并保存 route、resolution 和 assurance 证据。
- 不保留旧 CLI/MCP 兼容层；只有新实现全量验收后才删除旧入口。
- 现有未提交修改属于用户。实施前记录 `git status --short`；不得覆盖、重置或顺手格式化不相关文件。
- 普通测试不访问 Provider、不读取凭据、不消耗模型额度。Live smoke 必须由 `UAGENTS_LIVE_TEST=1` 显式开启。

## 2. 完成交付物

```text
plugins/uagents/
├─ bin/uagents.mjs
├─ src/
│  ├─ protocol/
│  ├─ registry/
│  ├─ policy/
│  ├─ runtime/
│  ├─ store/
│  ├─ artifacts/
│  ├─ transports/
│  └─ adapters/{fake,agy,workbuddy,opencode,doubao,trae}/
├─ mcp/unified/{package.json,package-lock.json,src,dist,test}/
└─ skills/agent-dispatch/
tests/
├─ protocol.test.mjs
├─ registry-policy.test.mjs
├─ sqlite-store.test.mjs
├─ runtime-state-machine.test.mjs
├─ runtime-crash.test.mjs
├─ workspace-locks.test.mjs
├─ adapter-contract.test.mjs
├─ unified-cli.test.mjs
└─ plugin-package.test.mjs
```

文件名允许在实现中做小幅调整，但模块职责、公共行为和验收命令不得漂移。任何调整都要先更新本计划的对应任务。

## 3. Gate 0：基线、路线对齐和 SQLite 决策

### 任务 0.1：冻结工作区与测试基线

检查：

```powershell
git status --short
node --version
npm test
```

把测试输出、Node 版本和已存在的修改列表写入新的 `docs/verification/2026-09-04-unified-runtime-baseline.md`。不得修改现有脏文件来“清理”基线。

验收：`npm test` 的结果可重复；若有基线失败，文档逐项记录，后续提交不得掩盖。

### 任务 0.2：对齐 OpenCode route ID

修改：

- `plugins/uagents/skills/agent-dispatch/scripts/store.mjs`
- `plugins/uagents/skills/agent-dispatch/scripts/agent-call.mjs`
- `plugins/uagents/skills/agent-dispatch/references/opencode-council.md`
- 相关测试 fixture

唯一内置路线：

```text
commandcode-goat/deepseek/deepseek-v4-flash
commandcode-goat/z-ai/glm-5.3-flash
```

增加测试，拒绝旧 `opencode-go/deepseek-v4-flash` 和 `opencode-go/glm-5.2`。不增加 fallback。

### 任务 0.3：SQLite Windows/Node spike

新增：

- `scripts/sqlite-spike.mjs`
- `docs/verification/2026-09-04-sqlite-windows-spike.md`

验证 Node 22 与 24 下：WAL、busy timeout、事务回滚、32 进程并发唯一插入、进程强杀后恢复、中文/空格路径、打包后的加载方式。优先评估 `node:sqlite`；若目标 Node 22 版本需要不可接受的实验参数或行为不满足测试，再评估一个维护中且许可证兼容的 SQLite 依赖。不得为了省事降低 Node 22 支持或跳过干净安装验证。

Gate 0 决策必须在验证文档写明：选择、精确最低 Node 版本、是否需要依赖、许可证、Windows 安装/打包代价和否决其他候选的原因。

Gate 0 验收：

```powershell
npm test
node scripts/sqlite-spike.mjs
rg "opencode-go/|glm-5\.2" plugins/uagents tests
```

最后一个命令除迁移说明/否定测试外不得命中运行时代码。

建议提交：`test: freeze runtime baseline and sqlite decision`

## 4. Gate 1：Protocol、Registry 与 Policy

### 任务 1.1：协议和稳定错误

新增：

- `plugins/uagents/src/protocol/schema.mjs`
- `plugins/uagents/src/protocol/errors.mjs`
- `plugins/uagents/src/protocol/envelope.mjs`
- `plugins/uagents/src/protocol/canonical-json.mjs`
- `tests/protocol.test.mjs`

实现严格 Schema 1.0：拒绝未知字段，限制字符串/数组/事件大小；生成稳定 error envelope；所有四个模型字段即使为 `null` 也不得省略。实现确定性 canonical JSON，不依赖普通 `JSON.stringify` 的调用方字段顺序。

### 任务 1.2：静态 Registry 与动态 Health

新增：

- `plugins/uagents/src/registry/builtins.mjs`
- `plugins/uagents/src/registry/registry.mjs`
- `plugins/uagents/src/registry/health-cache.mjs`
- `tests/registry-policy.test.mjs`

Descriptor 只含静态能力；Health Snapshot 使用 `available|unavailable|unknown`、source、observed_at、expires_at。实现“用户只能收紧”的合并逻辑、route ID、Provider、默认模型解析和缓存 TTL。

### 任务 1.3：Policy Pipeline

新增：

- `plugins/uagents/src/policy/evaluate.mjs`
- `plugins/uagents/src/policy/permissions.mjs`
- `plugins/uagents/src/policy/models.mjs`

按设计顺序实现两阶段 Capability 校验。首版 `fallback !== "none"`、非空 `max_cost_usd`、未经能力证明的 `workspace-write/enforced-read-only` 都必须在启动 Worker 前返回 `unsupported_capability/not_sent`。Policy 是纯函数，不启动进程、不探测 Provider。

Gate 1 验收：

```powershell
node --test tests/protocol.test.mjs tests/registry-policy.test.mjs
```

建议提交：`feat: add unified protocol registry and policy`

## 5. Gate 2：SQLite Store 与 Runtime 内核

### 任务 2.1：数据库、迁移与目录

新增：

- `plugins/uagents/src/store/database.mjs`
- `plugins/uagents/src/store/schema.mjs`
- `plugins/uagents/src/store/task-files.mjs`
- `plugins/uagents/src/store/redaction.mjs`
- `tests/sqlite-store.test.mjs`

最小表：

```text
tasks(task_id, request_id, raw_hash, effective_hash, status,
      native_outcome, objective_verdict, cancel_requested,
      model_requested, model_resolved, model_reported, model_verified,
      provider, route_id, resolution_json, verification_json,
      store_schema_version, core_version, created_at, updated_at)
attempts(attempt_id, task_id, ordinal, status, submission,
         adapter_version, native_cli_version, created_at, started_at, finished_at)
native_sessions(id, attempt_id, target, native_session_id, native_task_id,
                native_status, evidence_ref)
events(id, task_id, attempt_id, sequence, type, payload_json, created_at)
leases(resource_key, owner_nonce, epoch, fencing_token, expires_at)
idempotency(request_id, raw_hash, effective_hash, task_id)
```

具体列可扩展，但唯一约束、外键和索引必须覆盖：request UUID 唯一、Attempt ordinal 唯一、每 Task 事件 sequence 唯一、原生身份可查询、lease 原子接管。

数据库放 `%LOCALAPPDATA%\uAgents\v1\control.db`。载荷目录按 UUID 创建；临时文件必须与目标同目录。所有数据库连接启用 foreign keys、WAL 和有界 busy timeout。

### 任务 2.2：状态机

新增：

- `plugins/uagents/src/runtime/state-machine.mjs`
- `tests/runtime-state-machine.test.mjs`

将转换表写成数据并穷举测试。确认终态只有 `succeeded|failed|cancelled`；`waiting_user` 可恢复；`indeterminate` 只能基于相同 Native Session 的更强证据细化，不能触发 dispatch。取消意图与主状态分离。

### 任务 2.3：Task/Attempt、幂等与输入冻结

新增：

- `plugins/uagents/src/runtime/task-service.mjs`
- `plugins/uagents/src/runtime/effective-request.mjs`
- `plugins/uagents/src/runtime/checkpoints.mjs`

在一个事务中完成 effective request、幂等登记、Task 和 Attempt 创建。保存输入文件大小/hash，Worker 在 `possibly_sent` 前复核；变化则 `input_changed/not_sent`。同 UUID 同 hash 返回同一 Task/Attempt；异 hash 返回 `request_conflict/not_sent`。

### 任务 2.4：lease、fencing 与 workspace key

新增：

- `plugins/uagents/src/runtime/leases.mjs`
- `plugins/uagents/src/runtime/workspace-key.mjs`
- `tests/workspace-locks.test.mjs`

获取顺序固定为 global→target→workspace。workspace identity 规范化并检测祖先/后代重叠。每次有状态写入都校验 fencing token。覆盖大小写、Unicode、junction、SUBST/UNC 和 PID 复用测试；环境不支持的路径类型可显式 skip，但不得假装通过。

### 任务 2.5：Worker、发送 checkpoint 与崩溃恢复

新增：

- `plugins/uagents/src/runtime/worker.mjs`
- `plugins/uagents/src/runtime/worker-entry.mjs`
- `plugins/uagents/src/runtime/reconcile.mjs`
- `plugins/uagents/src/adapters/fake/adapter.mjs`
- `tests/runtime-crash.test.mjs`

Fake Adapter 提供逐点故障注入：prepare 前后、possibly_sent 事务前后、外部发送后、accepted 前后、原生终态前后。32 进程并发同 UUID 只能产生一个 Attempt。Worker 被强杀后，旧 fencing token 不能写状态；`status` 纯读；`reconcile` 显式接管且绝不重发。

Gate 2 验收：

```powershell
node --test tests/sqlite-store.test.mjs tests/runtime-state-machine.test.mjs tests/runtime-crash.test.mjs tests/workspace-locks.test.mjs
```

建议提交：`feat: add sqlite runtime attempts leases and checkpoints`

## 6. Gate 3：产物与 Adapter Contract

### 任务 3.1：输入与产物验证

新增：

- `plugins/uagents/src/artifacts/inputs.mjs`
- `plugins/uagents/src/artifacts/capture.mjs`
- `plugins/uagents/src/artifacts/verify.mjs`
- `tests/artifacts.test.mjs`

产物先稳定化并复制到任务捕获目录，再对捕获副本记录 realpath、file identity、observed_at、size 和 SHA-256。junction 越界、超限、缺失或捕获期间变化都不能通过。明确这是验收，不是 OS 沙箱。

### 任务 3.2：公共 Adapter Contract Suite

新增：

- `plugins/uagents/src/adapters/contract.mjs`
- `tests/adapter-contract.test.mjs`
- `tests/fixtures/adapters/`

Contract 覆盖 descriptor、无副作用 probe/prepare、possibly_sent 屏障、accepted/native identity、模型四字段、事件去重、等待用户、取消、indeterminate、错误脱敏和产物边界。

Gate 3 验收：

```powershell
node --test tests/artifacts.test.mjs tests/adapter-contract.test.mjs
```

建议提交：`test: add artifact and adapter contracts`

## 7. Gate 4：迁移 CLI Adapter 与统一 CLI

### 任务 4.1：agy 参考 Adapter

迁移旧 `worker.mjs`/`cli-adapters.mjs` 的 agy 逻辑到：

- `plugins/uagents/src/adapters/agy/adapter.mjs`
- `plugins/uagents/src/transports/agy-cli.mjs`

保留初始化握手、请求/报告模型匹配、cwd、conversation ID、权限拒绝、1 MiB 限制和最终结果核验。不可逆 stdin 发送必须发生在 checkpoint 后。

### 任务 4.2：WorkBuddy 和 OpenCode

新增：

- `plugins/uagents/src/adapters/workbuddy/adapter.mjs`
- `plugins/uagents/src/adapters/opencode/adapter.mjs`
- 对应 transport

WorkBuddy `workbuddy-default` 不冒充具体模型；OpenCode 只允许两条 Command Code route、analysis、独立 session、无 `--auto`、无 fallback，`model_reported=null`、`model_verified=false`。

### 任务 4.3：统一 CLI

新增：

- `plugins/uagents/bin/uagents.mjs`
- `plugins/uagents/src/cli/main.mjs`
- `tests/unified-cli.test.mjs`

实现设计中的全部命令。JSON 为默认输出；`status/list` 只读；`reconcile` 显式访问原生目标。`submit` 支持互斥的 `--request FILE` 与 `--request-stdin`，stdin 最大 1 MiB，Prompt 和 JSON 不进入进程参数。自动化测试使用 fixture，真实 E2E 只使用用户已授权的常规路线。

Gate 4 验收：

```powershell
node --test tests/adapter-contract.test.mjs tests/unified-cli.test.mjs tests/cli-adapters.test.mjs
```

建议提交：`feat: migrate cli adapters and add unified cli`

## 8. Gate 5：迁移豆包与 TRAE

新增普通 Adapter 和内部 transport，复用现有已验证代码，不重新实现协议：

- `plugins/uagents/src/adapters/doubao/adapter.mjs`
- `plugins/uagents/src/transports/doubao-cdp.mjs`
- `plugins/uagents/src/adapters/trae/adapter.mjs`
- `plugins/uagents/src/transports/trae-gateway.mjs`

豆包保留应用身份、空白会话、窗口归属和边界后回复判定。TRAE 保留固定上游哈希、端口隔离、workspace、原生 task ID、积分不足识别和零自动审批。没有 OS 沙箱证据时，两者不得声明 enforced-read-only/workspace-write。

Gate 5 验收：现有豆包/TRAE 单元与 server smoke 先保持通过，再将同一 fixture 接入公共 Contract Suite。

```powershell
npm --prefix plugins/uagents/mcp/doubao test
npm --prefix plugins/uagents/mcp/trae test
node --test tests/adapter-contract.test.mjs
```

建议提交：`feat: migrate doubao and trae adapters`

## 9. Gate 6：统一 stdio MCP

新增：

- `plugins/uagents/mcp/unified/package.json`
- `plugins/uagents/mcp/unified/src/server.mjs`
- `plugins/uagents/mcp/unified/scripts/build.mjs`
- `plugins/uagents/mcp/unified/test/server-smoke.test.mjs`

工具：targets、capabilities、models、probe、submit、status、result、cancel、list_tasks、reconcile。Server 只调用 Core；不得复制状态机、Policy 或 Adapter 分支。submit 快速返回；status 只读；list 有 cursor 和硬上限；reconcile 的描述明确会访问原生目标。MCP 是兼容入口，不承诺获得宿主未显式转发的环境变量。

Gate 6 验收：

```powershell
npm --prefix plugins/uagents/mcp/unified test
node --test tests/unified-cli.test.mjs tests/plugin-package.test.mjs
```

建议提交：`feat: expose unified stdio mcp server`

## 10. Gate 7：切流、删除旧入口和文档

只有 Gate 0–6 全部通过后：

- 更新 `.codex-plugin/plugin.json` 仅注册 unified MCP。
- 更新 `skills/agent-dispatch/SKILL.md` 与 target references：本地 Codex 默认使用 CLI，只有缺少本地 Shell 或用户明确要求时才使用 MCP。
- 删除旧 `agent-call.mjs`、`worker.mjs`、`cli-adapters.mjs` 和两个目标专用 MCP Server/store 外壳。
- 保留已迁移的 CDP、gateway、解析器、fixture、许可证和第三方通知。
- 更新 README、状态、协议、安装、诊断、权限和迁移文档。

删除前运行旧与新 fixture 等价性测试；删除后从干净复制目录执行安装和测试。不要删除 `%LOCALAPPDATA%` 下旧任务证据。

建议提交：

```text
refactor: remove legacy agent-specific entrypoints
docs: document unified agent runtime
```

## 11. 最终验收

```powershell
npm test
npm --prefix plugins/uagents/mcp/unified test
node scripts/verify-installed-plugin.mjs
git status --short
```

另外必须保存以下证据：

- Node 22/24 SQLite Windows spike。
- 32 进程同 UUID 的唯一 Attempt。
- 每个发送 checkpoint 的 kill-point 测试。
- waiting_user 恢复和 indeterminate 证据收敛测试。
- workspace 父子路径、大小写与 junction 冲突测试。
- 输入变化、产物捕获、越界与 hash 测试。
- CLI/MCP 同 UUID、同一状态目录返回同一 Task/Attempt。
- 本地 CLI → Worker → OpenCode 环境变量鉴权真实 E2E；MCP 环境隔离作为独立兼容性结果记录。
- 所有 Target 的模型四字段与 route/assurance fixture。
- 日志、数据库、错误和产物 manifest 的凭据扫描。
- 插件干净安装以及新 Codex 任务中的工具发现。

真实 smoke 仅在用户再次明确同意消耗对应路线后执行：

```powershell
$env:UAGENTS_LIVE_TEST='1'
npm run test:live
```

失败时不得自动切换模型、Provider、付费路线或新 UUID。

## 12. 停止条件

遇到以下任一情况立即停止当前 Gate，不继续堆代码：

- SQLite 在受支持 Node/Windows 组合上无法满足事务或干净安装要求。
- `possibly_sent` 无法在目标不可逆发送之前可靠持久化。
- 同 UUID 并发产生多个 Attempt。
- 旧 Worker 能越过 fencing token 写新状态。
- Adapter 只能通过读取/修改凭据或启用全自动审批完成。
- 现有未提交修改与计划文件发生无法安全合并的冲突。
- live smoke 需要登录、购买、权限批准或切换收费路线。

停止时保留证据，报告具体 Gate、失败命令、发送语义和是否可能已产生外部执行；不得自动重试。
