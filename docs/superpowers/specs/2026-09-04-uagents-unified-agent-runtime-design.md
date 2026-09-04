# uAgents 统一 Agent 调用工具设计

日期：2026-09-04
状态：已通过多模型复核并按裁决修订，可进入实施
目标版本：`0.2.0-alpha.1`

复核记录：2026-09-04 使用网页端 GPT-5.6 Sol High、独立 GPT-5.6 Sol Max 和 OpenCode DeepSeek V4 Flash 进行只读架构复核；OpenCode GLM-5.3 Flash 该轮远端状态未知，未将其视为支持或反对证据。裁决按本地代码证据而非多数票作出。

## 1. 目标与边界

uAgents 将从“多条目标专用调用路线”重写为“统一 Agent 调用工具”。它向 Codex Skill、命令行和 MCP 客户端提供同一套请求、能力、任务状态、结果、错误和产物协议，同时允许每个 Agent 保留不同能力。

首版目标：

- 以一个共享 Core 同时支持 CLI 和统一 MCP Server。
- 统一调用 agy、WorkBuddy、OpenCode、豆包工作和 TRAE CN。
- 在调用时选择目标和模型，不静默切换 Provider 或付费路线。
- 区分请求模型、解析路线、原生报告模型和经过验证的模型身份。
- 保留持久任务、幂等、发送后状态未知、产物验证和桌面应用身份检查等已有安全特性。

非目标：

- 不把所有 Agent 伪装成拥有相同的模型、文件、取消、会话或多模态能力。
- 首版不建立常驻 daemon；使用本机 SQLite WAL 作为控制面事务存储，Prompt、大文本和产物仍使用受控文件目录。
- 首版不支持自动按任务选模型或自动 fallback。
- 不通过普通 `submit` 自动安装工具、登录账号、启动应用、批准操作或购买额度。
- 不保留旧 CLI 和目标专用 MCP 接口的兼容性。新实现验收后直接删除旧入口。

## 2. 总体架构

采用模块化单体，CLI 和 MCP 调用同一 Node.js Core：

```text
CLI ─┐
     ├→ Protocol → Policy → Registry → Runtime → Adapter
MCP ─┘                                        ├─ agy
                                               ├─ workbuddy
                                               ├─ opencode
                                               ├─ doubao
                                               └─ trae
```

建议目录：

```text
plugins/uagents/
├─ src/
│  ├─ protocol/       请求、结果、事件、错误 Schema
│  ├─ registry/       Target、Model、Capability 注册表
│  ├─ policy/         模型、权限、额度和 fallback 决策
│  ├─ runtime/        submit/status/result/cancel/reconcile
│  ├─ store/          任务、事件、心跳和会话状态
│  ├─ artifacts/      输入输出文件验证
│  ├─ transports/     CLI、CDP 和 TRAE gateway 等运输实现
│  └─ adapters/
│     ├─ agy/
│     ├─ workbuddy/
│     ├─ opencode/
│     ├─ doubao/
│     └─ trae/
├─ bin/
│  └─ uagents.mjs
├─ mcp/
│  └─ unified/
└─ skills/
   └─ agent-dispatch/
```

Core 使用 Node.js ESM `.mjs` 和 JSON Schema，不新增 TypeScript 编译链。CLI 和 MCP 是薄入口，不包含独立业务逻辑。

控制面对象从首版起分为三层：

```text
Task（用户逻辑请求与幂等边界）
└─ Attempt（一次真实执行，具有独立 attempt_id）
   └─ Native Session（原生 process/session/conversation/task 身份）
```

一个 `request_id` 对应一个 Task。首版默认一个 Task 只创建一个 Attempt；只有后续显式、可证明安全的重试协议才能增加 Attempt，`may_have_been_sent` 或 `indeterminate` 绝不自动产生新 Attempt。

## 3. 统一请求协议

协议版本从 `1.0` 开始。未知字段默认拒绝，不支持的 Capability 在启动 Worker 前拒绝。

```json
{
  "schema_version": "1.0",
  "request_id": "UUID",
  "target": "agy",
  "model": "gemini-3.1-pro-low",
  "mode": "implementation",
  "prompt": "完成指定任务",
  "workspace": "F:\\documents\\software\\example",
  "inputs": [
    {
      "type": "file",
      "path": "requirements.md"
    }
  ],
  "expected_outputs": [
    {
      "path": "src/result.ts",
      "type": "file",
      "required": true,
      "max_bytes": 10485760
    }
  ],
  "execution": {
    "observation_timeout_ms": 600000,
    "effort": "high",
    "permission": "native"
  },
  "policy": {
    "fallback": "none",
    "max_cost_usd": null
  }
}
```

`workspace` 使用调用方提供的绝对路径。调用方不提供时，Runtime 才在状态根目录下创建任务 workspace。Prompt 仅通过 JSON 请求文件、stdin 或 MCP 参数传递，不放入命令行参数。

`observation_timeout_ms` 只限制本地 Worker 等待和观察时间，不宣称能够终止远端执行。只有 Adapter 的 Capability 明确提供原生执行截止能力时，才允许单独的 `execution_timeout_ms`。`policy.max_cost_usd` 保留协议扩展位，但首版所有非 `null` 值都在发送前返回 `unsupported_capability`，不得依据模型名称、Token 或外部价格表推测可执行费用上限。

## 4. 统一结果与模型身份

每次任务结果必须包含：

- `model_requested`：调用方原始传入的模型或 `default`。
- `model_resolved`：uAgents 在提交前解析得到的具体规范模型；后端默认模型无法解析时为 `null`，不把运输路线别名冒充具体模型。
- `model_reported`：底层 Agent 在本次运行中报告的模型；无可靠元数据时为 `null`。
- `model_verified`：本次运行是否获得足够证据证明报告身份与解析路线一致。
- `route_id`：Adapter 实际使用的完整 Provider/Model 运输路线；它与规范模型名 `model_resolved` 分开记录。

完整结果：

```json
{
  "schema_version": "1.0",
  "task_id": "UUID",
  "request_id": "UUID",
  "target": "agy",
  "status": "succeeded",
  "model_requested": "default",
  "model_resolved": "gemini-3.1-pro-low",
  "model_reported": "gemini-3.1-pro-low",
  "model_verified": true,
  "provider": "agy",
  "route_id": "agy/gemini-3.1-pro-low",
  "model_resolution": {
    "kind": "exact",
    "registry_version": "sha256:..."
  },
  "model_verification": {
    "status": "verified",
    "assurance": "runtime_self_report",
    "match": true,
    "method": "runtime_handshake",
    "evidence_ref": "event:17"
  },
  "native": {
    "session_id": "native-session-id",
    "task_id": null,
    "status": "success"
  },
  "response": {
    "text": "任务已经完成"
  },
  "artifacts": [
    {
      "path": "src/result.ts",
      "type": "file",
      "size_bytes": 1830,
      "sha256": "sha256",
      "verified": true
    }
  ],
  "usage": {
    "input_tokens": null,
    "output_tokens": null,
    "cost_usd": null,
    "reported_by": null
  },
  "warnings": [],
  "error": null,
  "created_at": "RFC3339 timestamp",
  "started_at": "RFC3339 timestamp",
  "finished_at": "RFC3339 timestamp"
}
```

四个模型字段在所有任务记录和结果中始终存在，允许值为 `null` 的字段不得省略。`model_resolution.kind` 取 `exact`、`alias` 或 `backend_default`；`model_verification.status` 取 `verified`、`unverified`、`mismatch`、`not_supported` 或 `unknown`；`assurance` 取 `none`、`runtime_self_report`、`transport_attested` 或 `provider_attested`；`match` 取 `true`、`false` 或 `null`。`model_verified=true` 只表示已达到该 Target 在 Descriptor 中声明并由 Policy 接受的保证级别，不暗示一定是 Provider 级证明。证据通过脱敏事件引用保存。未知 usage 值使用 `null`，不使用 `0` 伪装零消耗，也不根据模型名称推测价格。

## 5. Capability 协议

每个 Adapter 必须返回可验证的静态 Target Descriptor。不支持的能力明确声明，不用空实现伪装成功。安装、连接、登录和当前可执行性属于动态 Health Snapshot，不写入静态 Descriptor。

```json
{
  "target": "opencode",
  "display_name": "OpenCode",
  "transport": "cli",
  "modes": ["analysis"],
  "models": {
    "selection": "explicit",
    "discovery": "configured",
    "default": null
  },
  "inputs": {
    "text": true,
    "files": false,
    "images": false
  },
  "outputs": {
    "text": true,
    "files": false,
    "images": false
  },
  "lifecycle": {
    "status": true,
    "cancel": "local-request",
    "resume": false
  },
  "permissions": {
    "native": true,
    "read_only_enforced": false,
    "workspace_write_enforced": false,
    "full_access": false
  },
  "model_identity": {
    "reported": false,
    "verification": "unsupported"
  }
}
```

取消能力使用 `unsupported`、`local-request` 或 `native-confirmed`，以区分本地 Worker 终止与远端任务确认停止。

动态探测统一返回：

```json
{
  "availability": "available",
  "source": "native_probe",
  "observed_at": "RFC3339 timestamp",
  "expires_at": "RFC3339 timestamp",
  "details": {}
}
```

`availability` 取 `available`、`unavailable` 或 `unknown`。只有新鲜且权威的 `unavailable` 才能提前拒绝；缓存的 `available` 不是本次执行保证。Capability 校验执行两次：先做 Target 静态校验，再在模型解析后做路线级校验。

## 6. Registry 和模型发现

Effective Registry 由三层构成：

```text
内置描述 + 用户配置 + 运行时发现 = Effective Registry
```

优先级：

```text
用户禁用或限制 > 内置安全限制 > 运行时发现 > Adapter 默认值
```

用户配置可以收紧能力，不能把 Adapter 明确不支持的能力强行开启。每个模型记录 Target、规范模型 ID、route ID、Provider、显示名、启用状态、解析类型、身份验证能力、额度类别和是否需要显式 opt-in。动态可用性单独记录为带来源和 TTL 的 Health Snapshot。

模型发现不在每次调用时遍历全部模型：

- `list_models(refresh=false)` 优先返回有效缓存。
- 缓存无效或用户显式刷新时，调用 Adapter 的 `discoverModels()`。
- `submit` 只检查本次选中的模型。
- CLI 安装和版本状态默认缓存 10 分钟，模型目录默认缓存 30 分钟。
- 登录状态不长期缓存，额度状态不缓存为可靠事实。

`model: "default"` 按以下顺序解析：

1. 用户配置中的 `default_model`。
2. 内置 Registry 中经过批准的默认模型。
3. Adapter 能提供且身份明确的原生默认路线。
4. 无可用默认时返回 `model_required`。

WorkBuddy 允许选择受控路线 `workbuddy-default`，但它属于 `backend_default`：无法解析具体模型时 `model_resolved=null`；原生结果只报告 `auto` 时，`model_reported="auto"`、`model_verified=false`。

## 7. Policy Pipeline

每个请求按固定顺序决策：

```text
Schema 校验
  → Target 是否启用
  → Capability 校验
  → 模型解析
  → 模型 allowlist
  → 权限检查
  → 费用和额度策略
  → workspace 和输入检查
  → 登记任务
  → 调用 Adapter
```

Policy 仅返回允许决策或结构化拒绝，不调用 Agent。决策记录必须包含应用规则、解析模型、权限和 fallback 状态。

首版规则：

- 不允许未登记模型。
- 新模型必须通过受信内置 Registry 或用户配置加入。
- 付费或有限额度模型需要显式选择。
- 不从常用路线静默切换到付费路线。
- 首版 `fallback` 只支持 `none`。
- 不解析或记录 Provider 凭据内容；启动受信任的本机 Agent CLI 时继承父进程环境，保持原生 CLI 的订阅与 Provider 行为，无需在插件中维护 Key 名单。
- 探测失败不自动登录、安装、购买或更换 Provider。

Target 是实际执行后端，Model 是模型路线，Profile 是可选角色模板。首版保留 Profile 扩展位，不实现 Profile 管理。Profile 以后也不得自行提升权限、选择付费模型或开启 fallback。

## 8. Adapter 契约

```ts
interface AgentAdapter {
  descriptor(): TargetDescriptor;
  discoverModels(context: DiscoveryContext): Promise<ModelCatalog>;
  probe(request: ProbeRequest, context: AdapterContext): Promise<ProbeResult>;
  prepare(request: EffectiveRequest, context: AdapterContext): Promise<PreparedSubmission>;
  dispatch(prepared: PreparedSubmission, context: DispatchContext): Promise<NativeSubmission>;
  observe(handle: NativeHandle, context: ObserveContext): AsyncIterable<NativeEvent>;
  cancel?(handle: NativeHandle, context: AdapterContext): Promise<NativeCancelResult>;
  reconcile?(handle: NativeHandle, context: AdapterContext): Promise<NativeSnapshot>;
}
```

Adapter 不生成统一 task ID，不直接改写统一状态，不运行 Policy，不自动换模型，不决定产物是否验收成功，也不保存凭据。

`prepare()` 必须无不可逆外部副作用。`DispatchContext` 提供 `attempt_id`、`AbortSignal` 和持久化 `checkpoint()`；Adapter 必须在发送 stdin、Enter、HTTP/CDP submit 等不可逆动作前 `await checkpoint("possibly_sent")`，在原生确认接收后立即 `await checkpoint("accepted", { handle, evidence })`。能够传递原生幂等键的 Adapter 必须使用 `attempt_id` 或 `request_id`。Core 只在 SQLite 事务提交后确认 checkpoint 完成。

`observe()` 必须定义 deadline、是否可重入、原生 cursor/event ID、去重规则、polling 退避，以及流正常结束但没有终态事件时如何进入 `indeterminate`。普通 `status` 默认只读；需要访问原生目标的行为通过显式 `reconcile` 执行。

首版能力基线：

| 能力 | agy | WorkBuddy | OpenCode | 豆包工作 | TRAE CN |
| --- | --- | --- | --- | --- | --- |
| Transport | CLI/RPC | CLI | CLI | CDP | 本地网关/CDP |
| 模型选择 | 显式 Gemini slug | `default` | DPF/GLM 显式 | `default` | `default` |
| 模型身份 | 握手可验证 | 通常只有 `auto` | 当前不回显 | 不支持 | 不支持 |
| Analysis | 是 | 是 | 是 | 是 | 是 |
| Implementation | 是 | 是 | 否 | 否 | 是 |
| 文件产物 | 是 | 是 | 否 | 否 | 是 |
| 图片输入 | 否 | 否 | 否 | 否 | 否 |
| Cancel | 本地请求 | 本地请求 | 本地请求 | 不支持 | 不支持 |
| Resume | 否 | 否 | 否 | 否 | 否 |

agy 作为参考 Adapter，保留原生初始化握手、模型、cwd、conversation ID、权限拒绝和最终结果核验。WorkBuddy 保留内嵌 CLI 定位、stdin、session ID、`acceptEdits` 和后台子任务终态检查。OpenCode 首版只开放 `commandcode-goat/deepseek/deepseek-v4-flash` 和 `commandcode-goat/z-ai/glm-5.3-flash` 的 analysis，不使用 `--auto`，不静默换路线。仓库、安装包、Registry 和 fixture 必须引用同一组 route ID。

豆包和 TRAE 从独立 MCP 重构为普通 Adapter。豆包保留应用身份、专属空白会话、跨进程窗口锁、UUID 幂等和边界后回复判定。TRAE 保留受信上游版本与哈希、Windows 补丁、端口隔离、workspace、原生任务 ID、积分不足识别和零自动审批。

## 9. Runtime 和持久化

Runtime API：

```text
submit(request)
status(taskId)
result(taskId)
cancel(taskId)
list(filter)
reconcile(taskId)
```

首版使用“短命入口 + 后台 Worker”，不建立 daemon。CLI 或 MCP 在 SQLite 事务中登记 Task 和首个 Attempt，再启动独立 Worker，然后快速返回。入口退出不终止已登记 Worker。

默认状态根目录：

```text
%LOCALAPPDATA%\uAgents\v1\
├─ control.db
├─ control.db-wal
├─ control.db-shm
└─ tasks\
```

任务目录：

```text
tasks/<request-id>/
├─ request.json
├─ payload.json
├─ decision.json
├─ artifacts.json
├─ response.txt
└─ workspace/
```

SQLite 控制面至少包含 `tasks`、`attempts`、`native_sessions`、`events`、`leases` 和 `idempotency`。状态转换、事件 sequence、幂等登记、checkpoint、lease 与 fencing token 必须在事务中更新。Prompt、大响应和产物不进入数据库；`request.json` 不保存完整 Prompt，`payload.json` 保存任务载荷并限制为当前用户访问。文件写入使用与目标同目录的临时文件和原子 rename，并针对 Windows `EBUSY`/`EPERM` 做有界重试。

每个 Task 必须记录 `store_schema_version`、Core build、Adapter version 和可获得的原生 CLI/应用版本。不兼容版本只允许只读，不得隐式 reconcile 或接管。

幂等同时保存 `raw_request_hash` 与 `effective_request_hash`。后者使用确定性 canonical JSON，覆盖解析后的模型、route ID、Registry/Policy/Adapter 版本、规范化 workspace identity、Prompt、expected outputs、execution/policy，以及每个显式输入文件的大小和 SHA-256。发送前重新核对输入摘要；改变则以 `input_changed/not_sent` 结束。相同 `request_id` 和相同 effective hash 返回原任务，不同则返回 `request_conflict`。

## 10. 状态机、并发、取消和恢复

统一状态：

```text
registered → queued → starting → running
running → waiting_user → running
running → succeeded | failed | cancelled
registered | queued | starting → cancelled
starting | running | waiting_user → indeterminate
indeterminate → running | waiting_user | succeeded | failed | cancelled
```

`succeeded`、`failed` 和 `cancelled` 是确认终态，终态不倒退。`waiting_user` 是可恢复状态。`indeterminate` 表示请求可能已经发送但缺少可靠当前状态：禁止重新 dispatch，只允许使用匹配同一 Native Session 且证据等级更高的观察结果细化状态。`cancel_requested` 是独立控制意图和事件，不是主生命周期状态。Adapter 只产生原生事件，Runtime 独占统一状态转换权。

原生执行结果与目标验收结果分开记录为 `native_outcome` 和 `objective_verdict`。原生成功但缺失必需产物时，Task 终态仍为 `failed/output_verification_failed`，同时保留 `native_outcome="succeeded"`，不得改写原生事实。

默认并发：

| Target | 默认上限 |
| --- | ---: |
| agy | 2 |
| OpenCode | 2 |
| WorkBuddy | 1 |
| 豆包工作 | 1 |
| TRAE CN | 1 |

锁按 `global → target → workspace` 的固定顺序获取并反向释放。lease 包含 owner nonce、epoch/fencing token 和到期时间；过期 lease 被接管后，旧 Worker 的 fencing token 不得继续提交状态。workspace key 必须处理大小写、Unicode、junction/reparse point、SUBST/UNC 和祖先/后代重叠。

只有 Capability 有可验证的 `enforced-read-only` 时，同一 workspace 的任务才可使用共享读锁。`native` 和 `advisory-read-only` 仍可能写文件，按 workspace 写者处理。并发槽不足时进入 `queued`；排队 Worker 维持独立心跳。首版不实现文件级 owned paths 冲突推断。

`cancel` 事务化记录取消意图。尚未发送时可直接确认 `cancelled`；发送后只停止本地 Worker但无法确认远端状态时进入 `indeterminate`，不写为 `cancelled`。

普通 `status` 和 `list` 是 SQLite 只读查询，不隐式访问原生目标或争抢写权。每次 MCP/CLI 启动可以进行只读陈旧检测；只有显式 `reconcile` 才能取得 lease 并查询原生状态。Worker 心跳新鲜时不得接管；Worker 消失且 Adapter 支持原生查询时，可以用新的 fencing token 恢复观察；无法查询时进入 `indeterminate`。PID 存在不能单独证明任务健康。

Task、Attempt 和 Native Session 从首版开始分离。首版可以全部声明 `resumable=false`，但结果仍保存原生 session ID。后台 Worker 的孤儿检测和 lease 回收必须在没有 daemon 的条件下通过显式 reconcile 和入口维护完成，且绝不触发自动重发。

## 11. 统一 CLI 和 MCP

CLI：

```text
uagents targets
uagents capabilities <target>
uagents models <target> [--refresh]
uagents probe <target> [--model <id>]
uagents submit --request <file>
uagents status <task-id>
uagents result <task-id>
uagents cancel <task-id>
uagents list
uagents reconcile <task-id>
uagents config validate
uagents cleanup --dry-run
```

机器可读输出默认为 JSON，表格输出通过 `--format table` 显式请求。

MCP：

```text
uagents_list_targets
uagents_get_capabilities
uagents_list_models
uagents_probe
uagents_submit
uagents_status
uagents_result
uagents_cancel
uagents_list_tasks
uagents_reconcile
```

MCP 使用统一 envelope：

```json
{
  "ok": true,
  "data": {},
  "error": null,
  "warnings": []
}
```

`uagents_submit` 只保证任务已登记并返回建议轮询时间，不阻塞等待完整 Agent 结果。`uagents_status` 只读；`uagents_reconcile` 明确表示允许访问原生目标并刷新状态。任务列表必须分页且设置硬上限。MCP 首版不暴露 cleanup、安装、登录、Provider 配置和任意 `target_action`。

## 12. 错误协议

所有非成功结果使用稳定错误码，至少包含：

- `authentication_required`
- `quota_exhausted`
- `model_required`
- `model_unavailable`
- `unsupported_capability`
- `permission_required`
- `target_not_ready`
- `worker_launch_unconfirmed`
- `submission_unknown`
- `input_changed`
- `lease_conflict`
- `incompatible_store_version`
- `native_session_mismatch`
- `output_verification_failed`
- `request_conflict`
- `cancel_unsupported`

错误记录必须包含发送语义：

- `not_sent`：有证据证明请求未发送。
- `sent`：原生 Agent 已确认接收。
- `may_have_been_sent`：连接中断或证据不足，禁止自动重放。

错误 envelope 还必须包含稳定 `code`、`category`、`retryable`、`schema_version` 和发送语义。原生错误、stdout/stderr 与事件在落库和返回前统一脱敏。`retryable=true` 只表示协议上允许调用方显式创建新请求，不代表 Runtime 会自动重试。

## 13. 安全边界

信任划分：uAgents Core 是受信代码；内置 Adapter 是受信实现，但其原生结果仍需验证；Agent 输出、网页内容和输入文件是不可信数据。Agent 输出中的新指令不构成新授权。

权限级别：

- `native`：继承目标原生权限。
- `advisory-read-only`：仅提示词约束，必须声明非强制。
- `enforced-read-only`：由操作系统、容器或原生沙箱强制。
- `workspace-write`：只有 Adapter/OS 沙箱能够强制限制写入解析后 workspace 时才允许声明。
- `full-access`：仅用户明确授权时允许。

不把提示词中的“请勿修改”声明为强制只读，也不把写后路径检查宣传为沙箱。首版没有 OS 或原生强制证据的 Adapter 只开放 `native` 和 `advisory-read-only`；`workspace-write` 与 `enforced-read-only` 必须在 Worker 启动前拒绝。

路径检查包括规范绝对路径、workspace 归属、`..`、Windows 设备路径和保留名、symlink/junction/reparse point。写后再次解析真实路径，产物越界时不得标记成功。产物完成后复制到任务目录的不可变捕获区，再记录 realpath、文件 identity、捕获时间、大小和 SHA-256；验证对捕获副本执行。该机制用于验收和检测误操作，不防御拥有同一用户权限的恶意进程。

Windows 上不能用 POSIX `0o600` 作为 NTFS DACL 已正确限制的证据。安装和首次启动必须检查状态根目录 ACL；无法证明仅当前用户可访问时记录显式安全警告，而不是宣称已经隔离。

子进程使用环境变量 allowlist，不记录完整父进程环境。日志过滤 API Key、OAuth Header、Token、Cookie、私钥、CLI 登录文件内容、浏览器 Profile 和 MCP 认证参数。每个事件以及 stdout/stderr 设置大小上限，截断后显式记录 `truncated=true`。

统一 MCP 首版只使用 stdio。CDP/HTTP 运输只允许显式 loopback 地址，拒绝局域网和公网目标，验证应用身份，不提供任意 JavaScript/CDP eval。

## 14. 保留、清理与旧状态

新 Runtime 使用独立版本状态目录，不自动迁移或删除旧状态。清理仅通过显式 CLI 执行：

```text
uagents cleanup --older-than 30d --dry-run
uagents cleanup --task <id>
```

默认不自动删除任务。清理前列出任务、状态、文件数量、大小和用户产物情况。清理器永远不删除正式 workspace 中的产物。

## 15. 测试设计

测试分层：

1. Protocol：Schema、未知字段、版本、Capability 不匹配、统一 envelope。
2. Policy：target/model allowlist、`default` 解析、付费 opt-in、fallback 禁止、权限升级拒绝和缓存过期。
3. Runtime：SQLite 事务、Task/Attempt/Session、状态转换、UUID 幂等、发送 checkpoint、Worker 未确认、heartbeat、lease/fencing、取消不确定、reconcile、workspace 重叠锁和产物一致性。
4. Adapter Contract Suite：descriptor、probe 无正式发送、native handle、任务身份、不支持能力、错误映射和凭据脱敏。
5. Fixture：正常完成、权限拒绝、登录过期、额度不足、输出截断、会话混合、模型不匹配、连接中断和后台子任务未完成。
6. CLI/MCP 一致性：同一 Core 请求产生同一任务、状态、错误码、模型字段和产物摘要。
7. Windows：Node 22/24 SQLite WAL、中文、空格、长路径、大小写冲突、保留设备名、junction/reparse point、SUBST/UNC、detached Worker、ACL、lease 和同目录原子替换。

关键破坏性测试必须覆盖：32 个进程同时提交同一 UUID 只创建一个 Attempt；在 `possibly_sent` 前后、原生 ACK 前后逐点杀 Worker；旧 fencing token 无法写入；`waiting_user → running → succeeded`；`indeterminate` 只凭同一 Native Session 的更强证据收敛；输入登记后被修改则在发送前失败。

日常测试使用脱敏 fixture，不消耗模型额度。真实测试分为不发送提示词的 probe 和明确、低成本、可验证的最小 live smoke。Live smoke 只在 `UAGENTS_LIVE_TEST=1` 时执行，失败后不自动切换模型或目标。

## 16. 分阶段实施

### 阶段 0：冻结行为证据

- 对齐仓库、安装态、Registry 和 fixture 中的 OpenCode route ID，移除旧 `opencode-go/*` 基线。
- 在 Windows Node 22 和 24 上验证 SQLite WAL、并发事务、崩溃恢复和打包方式，记录驱动/内置模块选择与许可证。
- 记录五条路线的 Capability 基线。
- 保存脱敏原生事件 fixture。
- 固定当前测试结果。
- 标注可复用与应删除的旧代码。
- 核对当前未提交修改的归属，避免覆盖用户工作。

验收：OpenCode 路线无漂移；SQLite 技术选择有可重复的 Windows 证据；五个 target 均有能力基线和关键失败 fixture，现有测试基线可重复运行。

### 阶段 1：Protocol、Registry 和 Policy

建立 Schema、验证器、错误类型、Target/Model Registry、发现缓存和 Policy Pipeline。

验收：未知 target/model/capability 在 Worker 启动前拒绝，`default` 行为固定，Policy 不调用任何 Agent。

### 阶段 2：SQLite Store、Runtime 和 Fake Adapter

建立 SQLite WAL 控制面、受控载荷目录、Task/Attempt/Native Session、事件日志、lease/fencing、状态机、发送 checkpoint、Worker、取消和 reconcile，用 Fake Adapter 跑通完整生命周期。

验收：多进程幂等、冲突、非法状态、逐 checkpoint 崩溃、heartbeat、lease 接管、旧 Worker fencing、workspace 父子路径锁和输入变化测试通过。

### 阶段 3：agy 参考 Adapter 和统一 CLI

从旧 Worker 提取 agy 原生调用和解析逻辑，以它固定 Adapter 模板和 Contract Suite。建立统一 CLI。

验收：CLI 完成 targets/models/probe/submit/status/result/cancel/reconcile，模型四字段及扩展证据、握手、cwd、session ID 和产物捕获验证通过，并完成一次显式授权的最小 live smoke。

### 阶段 4：WorkBuddy 和 OpenCode Adapter

将旧共享条件分支拆成两个独立 Adapter。

验收：三个 CLI Adapter 通过同一 Contract Suite；OpenCode implementation 在启动前拒绝；WorkBuddy `auto` 不被写成具体模型；OpenCode 的未回显模型保持未验证。

### 阶段 5：豆包与 TRAE Adapter

把两个独立 MCP 中的业务逻辑下沉为 Adapter，并把 CDP 和 gateway 变成内部 Transport。

验收：两个 Adapter 通过 Contract Suite；probe 不发送任务；未启动应用结构化返回 `target_not_ready`；连接中断不重放；TRAE 积分不足映射为 `quota_exhausted`。

### 阶段 6：统一 MCP Server

建立一个 MCP Server，插件 manifest 仅声明该 Server 和统一工具面。

验收：CLI 和 MCP 共用 Core，相同 UUID 只建立一个 Task/Attempt，返回相同状态、错误码、模型字段和产物摘要，MCP submit 快速返回；status 只读，reconcile 显式访问原生目标。

### 阶段 7：删除旧入口

只有新 Core、五个 Adapter、CLI 和 MCP 全部验收后，才删除旧 `agent-call.mjs`、`worker.mjs`、`cli-adapters.mjs`、两个旧 MCP Server/store 外壳和旧 MCP 声明。已验证 CDP、TRAE gateway、解析器和第三方通知按新模块边界保留。

### 阶段 8：文档、安装和真实验收

更新 Plugin manifest、Skill、target references、Capability 表、配置、诊断、安全边界、版本和变更日志。执行确定性测试、干净复制安装、新 Codex 任务发现、五个 target 无额度 probe 和可用目标的最小 live smoke。

## 17. 提交边界

建议实施提交：

```text
1. test: freeze adapter fixtures and contracts
2. feat: add unified protocol registry and policy
3. feat: add sqlite runtime, attempts, leases and checkpoints
4. feat: migrate agy adapter and unified cli
5. feat: migrate workbuddy and opencode adapters
6. feat: migrate doubao and trae adapters
7. feat: expose unified mcp server
8. refactor: remove legacy agent-specific entrypoints
9. docs: document uagents unified protocol
```

每个提交必须独立通过对应测试，不将全部重写堆积为一个无法审查的提交。

## 18. 首版完成标准

- 五个 Adapter 全部通过统一 Contract Suite。
- CLI 和 MCP 对相同请求产生同一任务和同一结果。
- 所有任务结果都包含四个模型身份字段。
- 所有非成功结果都具有稳定错误码和发送语义。
- 状态机不存在非法倒退，`waiting_user` 可恢复，`indeterminate` 不触发重新发送。
- 同一 UUID 不会重复发送。
- 同一 workspace 及其父子重叠路径的潜在写任务默认独占。
- 远端可能已执行的任务不会被标记为安全重试。
- 普通测试不需要登录、模型额度或读取凭据内容。
- 五条现有路线的身份、幂等、权限、额度、应用归属和产物检查边界不因重构降级。

## 19. 后续版本候选

以下能力不进入 `0.2.0-alpha.1`：

- Agent Profile 管理和角色库。
- 自动模型选择和显式 fallback 图。
- 可靠 resume/fork 和通用多轮 Session。
- 图片、PDF 和其他多模态输入。
- 文件级 owned paths 并发锁。
- 常驻 daemon、远程数据库和大规模任务查询。
- 有严格 allowlist 和独立授权的管理型 target actions。

这些能力只在首版运行证据证明有必要时引入。
