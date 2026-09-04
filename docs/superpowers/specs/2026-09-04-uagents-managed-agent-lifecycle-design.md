# uAgents 受管 Agent 生命周期设计

日期：2026-09-04
状态：已确认，待实施计划

## 1. 背景

uAgents 已提供统一请求、结果、幂等、发送 checkpoint、模型证据、CLI 主入口和 MCP 兼容入口。OpenCode 与 WorkBuddy 可以由任务 Worker 启动，但入口发现没有持久缓存；Doubao Work 只连接预先启动的 CDP；TRAE CN 只连接预先启动的 gateway。用户必须手工准备桌面目标，这不符合“统一 Agent Runtime”应负责目标发现、启动和复用的定位。

现有任务租约存放在调用方指定的 Task DB。两个不同 `--state-dir` 可以各自取得租约并同时控制同一桌面窗口。当前状态机也缺少首次登录发生在发送前时的可恢复路径。Doubao 当前在 Prompt 写入输入框之后才持久化发送不确定性 checkpoint，无法证明首次 Prompt-bearing UI mutation 之前已经保存保守状态。

本设计经当前主模型先行提案，再由 DeepSeek V4 Flash、GLM-5.3 Flash 和独立 Sol Max 只读评审。综合结论依据现有代码边界、安全不变量和实施成本裁决，不按多数票决定。

## 2. 目标

- 自动发现、验证并缓存 agy、WorkBuddy、OpenCode、Doubao Work 和 TRAE CN 的本机入口。
- `submit` 自动准备目标；正常调用不要求用户预先启动桌面应用或 gateway。
- uAgents 只管理专用隔离 Doubao/TRAE 实例，不接管用户日常窗口。
- 首次登录允许用户在专用窗口完成，随后原任务可恢复，后续调用自动启动和复用。
- 保持 CLI 主入口、MCP 可选兼容、统一 Core、UUID 幂等和保守发送语义。
- 跨 Task DB 统一管理每个 Windows 用户的桌面实例、端口和生命周期租约。
- 不读取、复制、缓存或输出 Provider 凭据、Cookie、Token、认证文件内容或完整环境变量。

## 3. 非目标

- 不自动安装 Agent、登录账户、同意条款、批准命令、购买额度或更换 Provider。
- 不在 v1 安装常驻 Windows Service 或常驻 uAgents daemon。
- 不扫描整个磁盘寻找应用。
- 不连接、导航、聚焦、关闭或终止未被 uAgents 证明拥有的进程和窗口。
- 不把 Profile 内容纳入 uAgents 数据模型、备份、日志或结果。
- 不为各 Adapter 分别实现缓存、端口、进程和启动锁。

## 4. 方案选择

采用现有 Core 内的统一生命周期层：

```text
CLI / optional MCP
        |
UnifiedRuntime
        |
Task Worker ---------------- Task DB（允许 --state-dir）
        |
TargetSupervisor
  |-- AgentLocator
  |-- TrustVerifier
  |-- InstallationCache
  |-- PortBroker
  |-- ProcessAttestor
  |-- TargetLauncher
  `-- Reconciler
        |
Host Control Plane --------- %LOCALAPPDATA%\uAgents\host-v1
```

不采用以下方案：

- 常驻 daemon：v1 不承担服务安装、IPC 鉴权、常驻版本漂移和额外单点故障。
- Adapter 自管生命周期：会复制启动锁、路径信任、端口、PID 和错误处理，并混淆准备与发送边界。

## 5. 双控制面

### 5.1 Task Control Plane

现有 Task DB 继续保存：

- Task、Attempt 和 Native Session。
- 请求哈希、UUID 幂等和策略决策。
- `model_requested`、`model_resolved`、`model_reported`、`model_verified` 和 `route_id`。
- `submission`、任务状态、响应、usage 和 artifacts。

调用方仍可显式指定 `--state-dir`。

### 5.2 Host Control Plane

Host DB 固定在：

```text
%LOCALAPPDATA%\uAgents\host-v1\control.db
```

它在同一 Windows 用户的所有 CLI、MCP 和 Task DB 之间共享。它保存安装、受管实例、Host lease 和实例事件，不保存 Prompt、任务响应或 Provider 凭据。

Host DB 使用 SQLite WAL、事务、lease epoch、fencing token 和 heartbeat。v1 不增加 Windows native mutex；只有压力测试证明 SQLite 跨进程租约不足时才重新评估 native 依赖。

## 6. 组件与接口

```text
locator.inspect(target)
  只读检查缓存和当前安装候选，不启动、不写缓存。

locator.resolve(target, { refresh })
  发现、验证并缓存一个可信安装；歧义时失败。

supervisor.inspect(target)
  只读检查受管实例和 endpoint，不启动。

supervisor.ensure(target, context)
  获取 Host lease，解析安装，复用或启动受管实例，等待 ready 或返回 waiting_user。

supervisor.stop(target)
  只停止所有权证据完整匹配的受管实例。

runtime.resume(taskId)
  按 waiting phase 恢复发送前登录流程，或 reconcile 已发送的原生任务。
```

Supervisor 不接收 Prompt。Adapter 接收已经验证的 installation/instance context，只负责目标协议的 prepare、dispatch、observe、cancel 和 reconcile。

## 7. 安装发现与信任验证

### 7.1 候选顺序

1. 用户显式配置的绝对路径。
2. Host DB 中上次成功使用的缓存路径。
3. Windows App Paths。
4. HKCU/HKLM 卸载注册表。
5. Target Manifest 声明的厂商安装目录。
6. PATH。
7. 开始菜单快捷方式解析出的最终目标。

不进行无限制递归磁盘扫描。显式路径只提高候选优先级，不能绕过验证。

### 7.2 Target Manifest

每个目标在代码中声明：

```text
target
artifact_kind
accepted_product_names
accepted_publishers
accepted_executable_names
known_install_locations
path_commands
version_probe
launch_recipe
profile_strategy
readiness_probe
```

Launch recipe 是受版本控制的代码，不从缓存加载任意命令或参数。

### 7.3 按目标验证

- Doubao/TRAE 桌面 EXE：canonical path、local fixed volume、reparse/UNC 策略、Authenticode、Publisher、ProductName、FileVersion。
- WorkBuddy：`codebuddy.js` 必须位于经过验证的 WorkBuddy 安装树。
- OpenCode/npm CLI：验证真实入口、包结构和无发送 `--version`；不强制要求 Authenticode。
- agy：依据实际 CLI 包结构和版本协议验证。
- 快捷方式：解析最终目标后执行同一目标验证。

默认使用 Publisher/Product 白名单。TOFU 不进入 v1；未来只可作为显式用户确认后的兼容策略。

### 7.4 缓存失效

缓存不是信任来源。每次 `ensure` 必须检查路径、canonical identity、size 和 mtime；有变化则重新验证签名、产品身份和 SHA-256。路径消失、更新或验证失败时废弃缓存并重新发现。多个有效候选无法按 Target Manifest 的确定性优先级选择时，返回 `installation_ambiguous`。

## 8. Host 数据模型

### 8.1 installations

```text
installation_id
target
canonical_path
discovery_source
artifact_kind
product_name
publisher
file_version
sha256
size
mtime
verifier_version
status
verified_at_ms
last_success_at_ms
```

### 8.2 managed_instances

```text
instance_id
target
installation_id
generation
state
profile_path
process_id
process_started_at_ms
listener_process_id
cdp_port
gateway_port
launch_fingerprint
identity_summary_json
started_by_uagents
created_at_ms
last_seen_at_ms
```

`profile_path` 是 opaque 应用数据位置。uAgents 只创建和传递路径，不读取、索引、复制或输出目录内容。

### 8.3 host_leases

资源键至少包括：

```text
instance:doubao
instance:trae
gateway:trae
```

两个不同 Task DB 的 Worker 必须竞争同一 Host lease。

### 8.4 instance_events

只记录发现、验证、启动、ready、登录等待、崩溃、身份变化和停止等脱敏事件。不得记录 Prompt、完整命令行、环境转储和 secret value。

## 9. 通用生命周期

```text
Task 注册并创建 Attempt
  -> Worker: starting
  -> 获取 Task leases
  -> 获取 Host instance lease
  -> supervisor.ensure()
       -> ready: adapter.prepare()
       -> login/setup: waiting_user + submission=not_sent
       -> failed: structured error + submission=not_sent
  -> adapter.dispatch()
  -> possibly_sent checkpoint
  -> native accepted
  -> observe/reconcile
```

启动应用或 gateway 不改变任务发送语义，始终保持 `submission=not_sent`。Prompt 第一次进入目标进程或 UI 之前必须已经持久化 `possibly_sent`。

v1 不自动关闭正常运行的受管实例。后续 `ensure` 可以复用；显式 `stop` 只操作所有权证据完整的实例。陈旧记录由后续 inspect/ensure 标记和收敛。

## 10. Doubao 流程

专用 Profile：

```text
%LOCALAPPDATA%\uAgents\host-v1\profiles\doubao\<generation>\
```

流程：

1. 定位并验证 Doubao Work 安装。
2. 检查已有受管实例的 PID、启动时间、路径、签名、监听进程、端口和 Profile generation。
3. 无可复用实例时，从目标首选端口和受控备用端口段选择空闲端口。
4. 使用参数数组、最小环境、专用 Profile 和 loopback CDP 启动；禁止 shell 拼接。
5. 验证 listener 属于受管进程树，CDP 页面使用预期 `doubaowork://` scheme，并与 generation 一致。
6. 登录或初始化 surface 返回 `waiting_user/preflight_login`，不发送 Prompt。
7. 显式 `resume` 后重新验证同一受管实例。
8. 建立空白会话。
9. 在 Prompt 首次写入输入框之前持久化 `possibly_sent`。
10. 输入并发送；确认 conversation identity 后记录 `accepted`。

端口由未知进程占用时返回 `port_identity_mismatch`；不得连接或终止该进程。

## 11. TRAE 流程

受管路径：

```text
%LOCALAPPDATA%\uAgents\host-v1\profiles\trae\<generation>\
%LOCALAPPDATA%\uAgents\host-v1\gateway\trae\
%LOCALAPPDATA%\uAgents\host-v1\secrets\trae-gateway-token
```

流程：

1. 验证 bundled gateway 与当前插件版本匹配。
2. 生成随机本地 capability token，存入当前用户 ACL 保护的文件；Host DB 只保存引用。
3. 使用 loopback、strict CDP port、禁用自动批准、禁用后台重试的最小环境启动 gateway。
4. 验证 gateway instance nonce，拒绝同端口的其他本地服务。
5. 定位并验证兼容的 TRAE CN 产品变体。
6. 使用专用 Profile 和受控 CDP 端口启动桌面实例。
7. 验证 workbench surface、进程树、端口、产品身份和 Profile generation。
8. 登录或初始化 surface 返回 `waiting_user/preflight_login`。
9. `resume` 后重新验证实例。
10. 在向 gateway POST 之前持久化 `possibly_sent`，继续使用 request UUID 作为原生幂等键。
11. gateway 返回稳定 task ID 后记录 `accepted`。

Gateway 崩溃且已有 native task ID 时，可以使用同一持久目录重启 gateway，但只允许查询该 task ID；不得重新发送 Prompt。

## 12. waiting_user 与 resume

增加受约束状态迁移：

```text
starting -> waiting_user
waiting_user -> queued
```

发送前登录恢复只有同时满足以下条件才允许 `waiting_user -> queued`：

- `submission=not_sent`。
- 没有 native identity。
- interaction phase 是 `preflight_login`。
- 用户显式调用 `resume`。
- 原请求哈希、有效请求哈希和输入快照没有变化。

相同 UUID 再次 `submit` 仍只返回 duplicate，不隐式恢复。

原生授权等待具有 native identity，且可能已经发送。此时 `resume` 只 reconcile 同一 identity，不重新 dispatch。结果协议必须暴露 waiting phase，避免两种恢复路径混淆。

## 13. 崩溃和所有权规则

- 发送前启动失败或应用崩溃：同一 Attempt 可在显式 resume 时重新 ensure。
- `possibly_sent` 后应用崩溃：进入 `indeterminate`，禁止自动重启并重新提交。
- PID 单独不是所有权证据。PID、启动时间、canonical path、产品签名、端口、监听者和 generation 必须联合匹配。
- 只允许终止当前持有的 ChildProcess，或完整 attestation 匹配的持久受管实例。
- 用户日常窗口即使产品签名正确，也因为 Profile/generation 不匹配而不得接管。
- CDP WebSocket URL 必须保持相同 loopback host/port。
- Supervisor 不得接受或持久化 Prompt。

## 14. 环境和秘密边界

- OpenCode、agy、WorkBuddy 等受信任 CLI 继续继承调用终端环境，以支持任意 Provider 环境变量而不维护 Key 名单。
- Doubao、TRAE 和 gateway 使用最小环境，不继承无关 Provider 变量。
- Gateway capability token 是本机 IPC secret，不是 Provider 凭据；不得进入 DB 明文、日志、结果或命令行。
- Windows v1 使用当前用户 ACL 文件保护 gateway token。若 ACL 无法被验证，gateway 不启动。
- Profile 内认证数据由目标应用拥有和保护；uAgents 不读取、复制、输出或备份。

## 15. CLI、MCP 与能力协议

新增 CLI：

```text
uagents ensure <target> [--refresh]
uagents resume <task-id>
uagents stop <target>
```

- `probe`：只读，不启动、不更新缓存。
- `ensure`：发现、验证、缓存并启动，不发送 Prompt。
- `submit`：自动 ensure。
- `resume`：按 waiting phase 选择发送前恢复或同 identity reconcile。
- `stop`：只停止受证明拥有的实例。

统一 MCP 增加对应兼容工具，调用同一 Core 和 Host DB。本地 Codex 继续默认使用 CLI。

Doubao/TRAE capability 增加：

```json
{
  "lifecycle": {
    "managed": true,
    "auto_launch": true,
    "profile": "isolated",
    "ensure": true,
    "resume": true,
    "stop": true
  }
}
```

状态和结果增加：

```json
{
  "lifecycle": {
    "state": "ready",
    "installation_id": "opaque-id",
    "instance_id": "opaque-id",
    "profile_generation": 1,
    "started_by_uagents": true,
    "reused": false
  }
}
```

`native` 继续表示具体对话或任务身份，不使用 process instance ID 代替。请求 Schema v1.0 不增加 launch policy；提交本地目标时自动准备 transport 是默认行为，只读检查使用 `probe`。

## 16. 错误协议

规范化以下错误：

```text
installation_not_found
installation_ambiguous
installation_untrusted
installation_changed
launch_failed
launch_timeout
profile_locked
port_unavailable
port_identity_mismatch
managed_instance_identity_mismatch
target_login_required
gateway_launch_failed
gateway_identity_mismatch
resume_not_allowed
stop_not_owned
```

每个错误包含 `code`、`category`、`message`、`retryable`、`submission` 和必要的脱敏 `details.cause_code`。已知 bridge/client 错误必须转换为 `UAgentsError`，不得退化为 `internal_error`。发送前错误统一为 `submission=not_sent`。

## 17. 实施 Gate

### Gate 0：真实启动参数验证

- 证明当前 Doubao Work 接受并隔离专用 Profile/CDP 参数。
- 证明当前支持的 TRAE CN 产品变体及 workbench surface。
- 证明 bundled gateway 与这些变体的兼容性。
- 验证失败则停止对应 Target 实施，不猜测或固化参数。

### Gate 1：Host Control Plane

- Host DB、独立 schema migration、ACL、installation cache、Host lease 和 instance events。
- Windows Locator、Target Manifest 和 TrustVerifier。
- 已知错误的结构化转换。

### Gate 2：通用 Supervisor

- inspect、resolve、ensure、stop 和 reconcile。
- PortBroker、ProcessAttestor、Profile generation。
- ensure/resume/stop CLI 与 MCP。
- 发送前 waiting_user 与原 Attempt 恢复。

### Gate 3：Doubao

- 自动启动、首次登录、resume、复用和安全 stop。
- Prompt mutation 前 checkpoint。
- 端口劫持与逐点崩溃测试。

### Gate 4：TRAE

- Gateway token、nonce、自动启动和恢复查询。
- TRAE 专用实例启动与身份确认。
- 已发送任务不得重启重发。

### Gate 5：发布

- 更新 Skill、协议、状态和运维文档。
- 更新 cachebuster，验证插件，F 盘提交，同步 C 盘源目录并重新安装。
- 在新 Codex 对话中执行安装后真实 E2E。

## 18. 测试矩阵

- 有效缓存、缓存丢失、程序升级、签名变化和路径替换。
- UNC、junction/reparse point、错误 Publisher 和假同名程序。
- 端口被未知进程占用、PID 重用、进程树变化和假 CDP/gateway。
- 32 个进程、两个不同 Task DB 同时 ensure，同一目标只启动一个实例。
- 用户日常窗口同时运行时，不聚焦、不导航、不关闭、不接管。
- 冷启动未登录到 `waiting_user`，登录后原任务 resume。
- 后续冷启动自动复用已登录专用 Profile。
- 启动、CDP ready、Prompt mutation、checkpoint、Enter、POST 和 native ACK 的逐点故障注入。
- `possibly_sent` 后崩溃不重启重发。
- 相同 UUID 幂等、修改请求冲突、无效模型不启动目标。
- CLI/MCP 使用同一 Core、Host DB、错误和 lifecycle 字段。
- 日志、Task DB、Host DB、事件、结果和临时文件的凭据扫描。
- `stop` 无法终止非受管进程。
- 插件源目录与安装缓存 SHA-256 一致。
- Doubao、TRAE、OpenCode、WorkBuddy 和 agy 分别完成真实 E2E。

## 19. 验收标准

- 新任务可在目标未运行时自动发现并启动受管实例。
- 首次登录只要求一次用户操作，原任务可以恢复，后续冷启动无需手工准备应用。
- 不同 Task DB 不能并发控制同一桌面实例。
- 日常窗口和未知端口进程不受影响。
- 发送边界、UUID 幂等和 indeterminate 规则没有弱化。
- Provider 凭据和 Profile 内容不进入 uAgents 数据、日志和结果。
- 所有新错误保持可诊断且不退化为 `internal_error`。
- 安装后真实 E2E 覆盖每个启用 Target；未满足的 Target 不宣称可用。
