# uAgents 受管 Agent 生命周期可执行实施计划

日期：2026-09-05
设计基线：`docs/superpowers/specs/2026-09-04-uagents-managed-agent-lifecycle-design.md`
目标：所有启用 Agent 自动发现并缓存入口；Doubao/TRAE 在 `submit` 时自动启动专用实例
状态：可执行，必须按 Gate 顺序推进

## 1. 实施约束

- 复用现有 UnifiedRuntime、Worker、SQLite WAL、lease、checkpoint、Adapter 和 CLI/MCP envelope，不重写 Runtime。
- Host 状态固定在 `%LOCALAPPDATA%\uAgents\host-v1`，独立于任务 `--state-dir`。
- `probe` 只读且不启动；`submit` 自动准备；首次登录通过原任务恢复。
- Supervisor 不接收 Prompt。Prompt 首次进入目标进程或 UI 前必须持久化 `possibly_sent`。
- `may_have_been_sent` 或 `sent` 后禁止重新 dispatch。
- CLI Agent 继承调用环境；桌面应用和 gateway 只得到最小环境。
- 不新增 npm/native 依赖。Windows 发现和进程检查使用系统 PowerShell，由固定脚本输出 JSON。
- 不自动安装、登录、批准、购买或接管日常窗口。
- 每个 Gate 先写失败测试，再写最小实现；通过该 Gate 验收后独立提交。
- 当前工作树已有其他修改。每次提交只暂存本 Gate 明确列出的文件。

## 2. 最小文件布局

新增文件控制在以下范围：

```text
plugins/uagents/src/host/
  host-store.mjs
  agent-locator.mjs
  target-supervisor.mjs
  doubao-launcher.mjs
  trae-launcher.mjs
plugins/uagents/scripts/windows-host.ps1
tests/
  host-store.test.mjs
  agent-locator.test.mjs
  target-supervisor.test.mjs
tests/live/
  managed-launch-spike.mjs
```

不建立接口目录、通用 factory、daemon、Windows Service、动态插件系统或单独 PortBroker/ProcessAttestor 类。端口选择和进程检查作为 `target-supervisor.mjs` 的内部函数；目标差异只放两个 launcher。

## 3. Gate 0：冻结基线并验证真实启动参数

### 任务 0.1：记录现有状态

只读执行：

```powershell
git status --short
node --version
npm test
```

记录现有未提交文件；不得通过重置或格式化清理它们。

### 任务 0.2：添加受控 live spike

新增：

- `tests/live/managed-launch-spike.mjs`
- `docs/verification/2026-09-05-managed-launch-spike.md`

Spike 必须由 `UAGENTS_LIVE_TEST=1` 开启，只执行以下动作：

1. 找到 Doubao Work、TRAE CN 和 TRAE SOLO CN 候选。
2. 读取路径、FileVersion、ProductName 和 Authenticode 结论；不读取应用 Profile。
3. 为每个目标创建专用临时 Profile 和空闲 loopback 端口。
4. 通过 `spawn(executable, args)` 启动，不使用 shell。
5. 验证实际接受的 Profile/CDP 参数、listener PID、CDP surface 和 gateway compatibility。
6. 不输入 Prompt、不发送消息、不登录。
7. 只终止本次持有的 ChildProcess；精确清理本次临时 Profile。

证据文档必须写明支持的产品变体、实际启动参数、ready/login surface、端口行为和失败原因。任何目标不能证明专用 Profile 隔离时，停止该目标的后续 Gate。

Gate 0 验收：

```powershell
npm test
$env:UAGENTS_LIVE_TEST='1'
node tests/live/managed-launch-spike.mjs
```

建议提交：`test: verify managed desktop launch contracts`

## 4. Gate 1：先修复现有发送边界和错误诊断

修改：

- `plugins/uagents/src/protocol/errors.mjs`
- `plugins/uagents/src/adapters/doubao/adapter.mjs`
- `plugins/uagents/src/adapters/trae/adapter.mjs`
- `plugins/uagents/mcp/doubao/src/cdp.mjs`
- `tests/desktop-adapters.test.mjs`
- `tests/runtime-crash.test.mjs`
- 必要的 Doubao fixture 测试

先增加失败测试：

1. `probe doubao` 对普通 `Error{code:cdp_unavailable}` 返回 `target_not_ready`，并在 `details.cause_code` 保存 `cdp_unavailable`。
2. `probe trae` 对 gateway 连接错误返回 `target_not_ready/gateway_unavailable`，不得返回 `internal_error`。
3. Doubao 在 Prompt 写入失败前已经完成 `possibly_sent` checkpoint。
4. checkpoint 写入失败时不得执行 Prompt insertion。

最小实现：

- 只允许白名单 target transport code 进入 `cause_code`，其他普通错误仍归一化为 `internal_error`。
- 将 Doubao `publish({submission:'may_have_been_sent'})` 移到第一次 Prompt-bearing DOM mutation 之前并等待完成。
- 不改变 Enter 后的 conversation identity 验证。

Gate 1 验收：

```powershell
node --test tests/desktop-adapters.test.mjs tests/runtime-crash.test.mjs
npm --prefix plugins/uagents/mcp/doubao test
npm --prefix plugins/uagents/mcp/trae test
```

建议提交：`fix: preserve desktop preflight errors and send boundary`

## 5. Gate 2：Host Store 和 Agent Locator

### 任务 2.1：Host Store

新增：

- `plugins/uagents/src/host/host-store.mjs`
- `tests/host-store.test.mjs`

修改：

- `plugins/uagents/src/runtime/leases.mjs`

`host-store.mjs` 内直接包含 Host schema，不再创建单独 schema 文件。表仅包含：

```text
metadata
installations
managed_instances
leases
```

复用并导出当前 lease 的最小通用操作，使 Task DB 与 Host DB 都使用 epoch、fencing token、heartbeat 和原子接管。Host Store 解析固定用户目录，不接受 `--state-dir` 覆盖。

测试：

- 两个不同 Task DB 得到同一个 Host root。
- SQLite WAL 和 schema version 正确。
- 安装记录 upsert/read/invalidate。
- 实例记录 upsert/read/mark-stale。
- 过期 lease 可接管，旧 fencing token 不能更新或释放新 lease。
- Host DB 行和结构化日志拒绝 Prompt/secret 字段。

### 任务 2.2：Windows Locator

新增：

- `plugins/uagents/src/host/agent-locator.mjs`
- `plugins/uagents/scripts/windows-host.ps1`
- `tests/agent-locator.test.mjs`

固定 PowerShell 脚本只支持四种动作并输出 JSON：

```text
discover-installations
verify-installation
inspect-process
inspect-listener
```

发现顺序：显式绝对路径、有效缓存、App Paths、HKCU/HKLM 卸载项、Target Manifest 已知目录、PATH。禁止全盘搜索和快捷方式遍历。

确定性排序：最近成功且仍兼容、Manifest 产品优先级、FileVersion、canonical path。桌面 EXE 验证 Authenticode/Publisher/ProductName；小型 CLI 入口额外记录 SHA-256。缓存命中每次检查 path/size/mtime，变化时完整复验。

先用注入的 PowerShell runner 编写 fixture 测试，不依赖开发机注册表。覆盖缓存命中、应用升级、错误 Publisher、假同名文件、多候选排序和路径消失。

Gate 2 验收：

```powershell
node --test tests/host-store.test.mjs tests/agent-locator.test.mjs tests/workspace-locks.test.mjs
```

建议提交：`feat: add per-user host store and agent discovery`

## 6. Gate 3：Target Supervisor 与任务恢复

新增：

- `plugins/uagents/src/host/target-supervisor.mjs`
- `tests/target-supervisor.test.mjs`

修改：

- `plugins/uagents/src/runtime/api.mjs`
- `plugins/uagents/src/runtime/worker.mjs`
- `plugins/uagents/src/runtime/worker-factory.mjs`
- `plugins/uagents/src/runtime/state-machine.mjs`
- `plugins/uagents/src/runtime/task-service.mjs`
- `plugins/uagents/src/adapters/contract.mjs`
- `plugins/uagents/src/adapters/cli-base.mjs`
- `plugins/uagents/src/transports/cli-process.mjs`
- `plugins/uagents/src/transports/agy-process.mjs`
- `tests/runtime-state-machine.test.mjs`
- `tests/unified-cli-adapters.test.mjs`
- `tests/runtime-crash.test.mjs`

### 任务 3.1：Supervisor 核心

实现三个公共方法：

```text
inspect(target)
ensure(target)
stop(target)
```

`ensure` 返回 installation、可选 managed instance、Host lease 和 lifecycle 摘要。Worker 在 `starting` 后、`adapter.prepare` 前调用。桌面任务在 dispatch/observe 全周期续租，并在 finally 释放；CLI 目标只解析并缓存入口，不持有桌面实例租约。

固定首选端口和小型受控备用段写在 target launcher 常量中。端口属于未知进程时返回 `port_identity_mismatch`，不得连接或终止。

### 任务 3.2：CLI Agent 接入缓存入口

- agy、WorkBuddy、OpenCode 的 prepare/probe 从 supervisor context 取得已验证入口。
- `cli-process.mjs` 和 `agy-process.mjs` 不再自行搜索 PATH，但保留注入 test driver。
- 每个任务仍启动独立 CLI 进程，环境继承规则不变。

### 任务 3.3：waiting_user 和恢复

增加：

```text
starting -> waiting_user
waiting_user -> queued
```

Task waiting event 保存脱敏 `interaction.phase` 和 lifecycle 摘要。`TaskService.submit` 在同 UUID、同 effective hash、`submission=not_sent`、无 native identity、phase=`preflight_login` 时原子恢复同一 Attempt，并返回 `duplicate=true,resumed=true`；`UnifiedRuntime.submit` 仅在新任务或 `resumed=true` 时启动 Worker。

显式 `resume(taskId)`：

- 发送前登录等待：同一 Attempt 回 queued。
- 已有 native identity：只调用 reconcile。
- 其他状态：`resume_not_allowed/not_sent`。

恢复后的 Worker 在任何 Prompt mutation 前重新验证输入快照。

测试：

- 2–4 个进程、两个 task state root 同时 ensure，只产生一个 managed instance。
- 未发送登录等待可以显式 resume 或同 UUID submit 恢复。
- 同 UUID 内容变化仍是 `request_conflict`。
- 有 native identity 的 waiting task不 dispatch。
- Host lease 过期后旧 Worker 被 fencing。
- `may_have_been_sent` 后 supervisor 不再启动或重发目标。

Gate 3 验收：

```powershell
node --test tests/target-supervisor.test.mjs tests/runtime-state-machine.test.mjs tests/runtime-crash.test.mjs tests/unified-cli-adapters.test.mjs
```

建议提交：`feat: supervise agent startup and resume preflight tasks`

## 7. Gate 4：Doubao 自动启动

新增：

- `plugins/uagents/src/host/doubao-launcher.mjs`

修改：

- `plugins/uagents/src/host/target-supervisor.mjs`
- `plugins/uagents/src/adapters/doubao/adapter.mjs`
- `plugins/uagents/mcp/doubao/src/cdp.mjs`
- `tests/desktop-adapters.test.mjs`
- `tests/target-supervisor.test.mjs`
- Doubao MCP fixture 测试

只使用 Gate 0 证明有效的启动参数。Launcher：

1. 解析可信安装和稳定专用 Profile。
2. 检查缓存 PID、启动时间、canonical path，并抽查 listener PID。
3. 无可信实例时使用最小环境启动并等待 CDP。
4. 分类 chat、login/setup 和错误 surface。
5. login/setup 返回 `waiting_user/preflight_login`。
6. ready 后把实际 port 交给 Doubao Adapter；Bridge 不再只读取进程环境端口。

测试必须同时放置一个模拟“日常窗口”，证明 launcher 不连接、不导航、不关闭它。`stop` 只允许操作本次 ChildProcess 或匹配 PID/启动时间/path 的记录。

Gate 4 验收：

```powershell
node --test tests/target-supervisor.test.mjs tests/desktop-adapters.test.mjs
npm --prefix plugins/uagents/mcp/doubao test
```

完成自动化测试后，由用户确认是否执行一次真实 Doubao 测试消息。

建议提交：`feat: auto-start managed doubao work instances`

## 8. Gate 5：TRAE 与 gateway 自动启动

新增：

- `plugins/uagents/src/host/trae-launcher.mjs`

修改：

- `plugins/uagents/src/host/target-supervisor.mjs`
- `plugins/uagents/src/adapters/trae/adapter.mjs`
- `plugins/uagents/mcp/trae/src/client.mjs`
- `plugins/uagents/mcp/trae/scripts/start-gateway.mjs`
- `plugins/uagents/mcp/trae/scripts/build.mjs`
- `tests/desktop-adapters.test.mjs`
- `tests/target-supervisor.test.mjs`
- TRAE MCP fixture 测试

Launcher：

1. 为 gateway 生成随机 capability token，保存到 Host secrets 文件；DB 只保存路径。
2. 尽力设置当前用户 ACL；失败时记录脱敏 warning，不输出 token。
3. 使用最小环境启动 bundled gateway，保留 `AUTO_START_TRAE=0`，由 Supervisor 启动应用。
4. Build patch 让 `/api/status` 返回启动时注入的 instance nonce；Client 必须核对。
5. 使用 Gate 0 证明兼容的 TRAE 产品和参数启动专用 Profile/CDP。
6. ready 后把实际 gateway endpoint 和内存 token 交给 Adapter。
7. gateway 崩溃且已有 native task ID 时，只允许重启 gateway并查询原 task ID。

测试覆盖错误 nonce、错误 token、假 gateway、额度错误、登录等待、gateway-only 恢复和 `possibly_sent` 后禁止重发。

Gate 5 验收：

```powershell
node --test tests/target-supervisor.test.mjs tests/desktop-adapters.test.mjs
npm --prefix plugins/uagents/mcp/trae test
```

完成自动化测试后，由用户确认是否执行一次真实 TRAE 测试消息。

建议提交：`feat: auto-start managed trae and gateway instances`

## 9. Gate 6：公开协议、文档与发布

修改：

- `plugins/uagents/src/cli/main.mjs`
- `plugins/uagents/mcp/unified/src/server.mjs`
- `plugins/uagents/mcp/unified/test/server-smoke.test.mjs`
- `plugins/uagents/src/registry/builtins.mjs`
- `plugins/uagents/skills/agent-dispatch/SKILL.md`
- `plugins/uagents/skills/agent-dispatch/references/protocol.md`
- `plugins/uagents/skills/agent-dispatch/references/doubao-work.md`
- `plugins/uagents/skills/agent-dispatch/references/trae-cn.md`
- `plugins/uagents/.codex-plugin/plugin.json`
- `README.md`
- `docs/status/2026-09-02-current-progress.md`
- `tests/unified-cli.test.mjs`
- `tests/plugin-package.test.mjs`

新增 CLI：

```text
ensure <target> [--refresh]
resume <task-id>
stop <target>
```

统一 MCP 新增 `uagents_ensure`、`uagents_resume`、`uagents_stop`。所有入口调用同一 Runtime，不复制 lifecycle 分支。capabilities 和 status/result 暴露设计规定的 lifecycle 摘要；所有四个模型字段保持存在。

更新 Skill：本地 CLI 仍为默认；`submit` 可以自动启动目标；登录等待后使用同 UUID submit 或 resume；MCP 仅作兼容入口。

### 发布验证

```powershell
npm test
python C:\Users\24590\.codex\skills\.system\skill-creator\scripts\quick_validate.py plugins\uagents\skills\agent-dispatch
python C:\Users\24590\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py plugins\uagents
git diff --check
```

发布步骤：

1. 用 plugin-creator helper 更新 cachebuster。
2. 只暂存 Gate 6 明确列出的文件，不包含工作树中的既有修改。
3. 提交 F 盘开发仓库。
4. 通过 `git archive HEAD:plugins/uagents` 构建全新 C 盘暂存副本。
5. 验证暂存副本后，将旧 C 盘目录移动为备份，再原子替换。
6. `codex plugin add uagents@personal` 重新安装。
7. 比较 C 盘源与安装缓存逐文件 SHA-256。
8. 新 Codex 对话分别执行 OpenCode、Doubao、TRAE CLI-first E2E；agy/WorkBuddy 在其登录和额度可用时执行。

建议提交：`feat: expose and document managed agent lifecycle`

## 10. 全量验收

自动化要求：

- 所有原有测试继续通过。
- 新 Host Store、Locator、Supervisor、恢复和错误测试全部通过。
- 两个 Task DB 并发不能产生两个桌面实例。
- 日常窗口与未知端口进程保持不变。
- 发送前失败保持 `submission=not_sent`。
- `possibly_sent` 后的任何故障都不能触发新 dispatch。
- 相同 UUID 恢复不产生新 Attempt；请求变化仍冲突。
- Host DB、日志和结果不包含 Prompt、token 或环境转储。
- C 盘生效插件和安装缓存内容一致。

真实 E2E 报告必须逐目标记录：插件版本、UUID、三层状态、submission、native identity、四个模型字段、route_id、usage，以及是否自动启动/复用受管实例。未登录、无额度或启动参数未证实时标记 `BLOCKED`，不得宣称该 Target 可用。

## 11. 停止条件

遇到以下任一情况停止当前 Gate：

- Gate 0 无法证明专用 Profile/CDP 与用户日常窗口隔离。
- 安装身份无法通过 Target Manifest 确定验证。
- Host lease 无法阻止跨 Task DB 双启动。
- 首次登录恢复需要新 UUID 或新 Attempt。
- Prompt 可能在 `possibly_sent` 前进入目标进程。
- 已发送任务只能通过重新 dispatch 才能恢复。
- 实现需要读取或修改应用凭据、自动审批或安装新依赖。
- 目标文件与现有用户修改发生无法安全合并的冲突。

停止时保留脱敏证据，报告是否已启动应用、是否可能发送以及精确错误；不得自动换 UUID、模型、Provider 或目标。
