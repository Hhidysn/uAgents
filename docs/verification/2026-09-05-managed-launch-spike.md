# 受管桌面启动 Spike 证据（Gate 0.2）

日期：2026-09-05
执行方式：`UAGENTS_LIVE_TEST=1 node tests/live/managed-launch-spike.mjs`
Spike 版本：1（`tests/live/managed-launch-spike.mjs`，evidence JSON 由脚本直接输出）
结论：**Doubao、Trae CN、TRAE SOLO CN 三个目标的专用 Profile + CDP 启动契约全部证实**，Gate 4/5 可以推进。

## 1. 环境与约束

- Windows 11，PowerShell 5.1（windows-host.ps1 只读动作），Node v24.13.0。
- Spike 通过真实 Agent Locator + 隔离临时 LOCALAPPDATA 的 HostStore 解析安装（不污染真实 Host DB）。
- 每个目标使用本次运行创建的专用临时 Profile 目录与随机空闲 loopback 端口。
- `spawn(executable, args)` 直接启动，无 shell；未写入任何 Prompt、未发送消息、未登录。
- 清理只针对本次持有的 ChildProcess 与所有权证据匹配的 listener；临时目录尽力删除。

## 2. 安装身份（全部 Authenticode Valid）

| 目标 | Canonical path | ProductName | Publisher | FileVersion |
| --- | --- | --- | --- | --- |
| doubao | `C:\Users\24590\AppData\Local\DoubaoWork\Application\DoubaoWork.exe` | DoubaoWork Launcher | Beijing Chuntian Zhiyun Technology Co., Ltd. | 2.27.8 |
| trae | `C:\Users\24590\AppData\Local\Programs\Trae CN\Trae CN.exe` | Trae CN | Beijing Yinli Catapult Technology Co., Ltd. | 2.3.77497 |
| trae-solo-cn | `C:\Users\24590\AppData\Local\Programs\TRAE SOLO CN\TRAE SOLO CN.exe` | TRAE SOLO CN | Beijing Yinli Catapult Technology Co., Ltd. | 2.3.79943 |

Doubao 的卸载注册表 DisplayName 为本地化"豆包"，ASCII 模式匹配不可用；发现依赖 known_locations + DisplayIcon 线索（manifest 已按此配置）。

## 3. 实际启动参数与结果

三者统一使用：

```text
--user-data-dir=<run>\profiles\<target>
--remote-debugging-port=<随机空闲端口>
```

| 目标 | CDP ready | Browser | Profile 填充 | listener PID 归属 |
| --- | --- | --- | --- | --- |
| doubao | 2568 ms | Chrome/147.0.7727.149 | 是 | 20740 = `Application\app\DoubaoWork.exe` |
| trae | 8997 ms | Chrome/142.0.7444.235 | 是 | 18696 = 启动 exe 本身 |
| trae-solo-cn | 5073 ms | Chrome/142.0.7444.235 | 是 | 37728 = 启动 exe 本身 |

### 3.1 Doubao 表面

- `/json/list` 含 `doubaowork://doubaowork-chat/chat`（type=page）——与设计 §10 的预期 scheme 一致，chat surface 分类依据成立。
- **关键发现（所有权证据）**：CDP 监听进程不是启动器子进程。spawn 的 PID 9608 是 `Application\DoubaoWork.exe`（launcher），它派生 `Application\app\DoubaoWork.exe`（PID 20740）持有端口。因此 Supervisor 的所有权校验必须按"已验证安装目录树前缀 + PID + 启动时间"联合判定，不能要求 listener exe 与启动 exe 完全一致。TRAE 两个变体则 listener = 启动 exe 本身。统一规则：`executable_path` 位于已验证安装目录内即可。

### 3.2 TRAE gateway（bundled v0.6.0）

- gateway 以最小环境启动（`AUTO_START_TRAE=0`、`BACKGROUND_MAX_RETRIES=0`、strict CDP port），303 ms 后 `/api/status` 200。
- status 关键字段：`cdpReachable:true`、`traeRunning:true`、`mockBridge:false`、`traeVersion:"1.107.1"`。
- **fresh Profile 的 surface.kind = "setup"**（`vscode-file://.../setup/setup.html`）——这就是 §11 步骤 8 的"登录或初始化 surface"，Gate 5 的 `waiting_user/preflight_login` 检测信号（ready 判定 = surface 不再是 setup）。
- gateway 自报 `compatibility:"degraded"`（"This TraeCN version/platform is not verified; generic DOM fallbacks remain best-effort"，adapter `traecn-unknown`）。判定：gateway 功能可用（连接、状态、surface 检测全部工作），degraded 是版本指纹未列入白名单的诚实告警，**不是** Gate 0 的"兼容性验证失败"。按计划继续 TRAE 实施，Gateway 版本白名单补齐作为后续项记录。
- status body 无 token/secret 泄漏。

## 4. 端口行为

- 端口由 `allocateFreePort()`（bind 0 后关闭）分配，启动前经 `inspect-listener` 复核空闲。
- 三个目标启动后 `inspect-listener` 均返回 listening + 正确的 OwningProcess 与 exe 路径（windows-host.ps1 的 inspect-listener/inspect-process 是可靠证据源）。
- 未知进程占用端口的拒绝路径由 `tests/target-supervisor.test.mjs` 用例 6 覆盖（port_identity_mismatch）。

## 5. 失败与残留

- 唯一残留：临时 run 根目录删除报 EPERM（被终止进程的 Profile 句柄短暂未释放）。`.local/` 已 gitignore，不影响仓库；后续 ensure 路径使用固定 Host root，不存在此问题。
- 无其他失败；无目标触发停止条件（专用 Profile 隔离全部证实）。

## 6. 对后续 Gate 的实施修正

1. Supervisor `verifyOwnership` 改为安装目录树前缀匹配（§3.1）。
2. Doubao launcher 的 ready 判定 = CDP up + `doubaowork://doubaowork-chat/chat` 页面存在；CDP up 但无 chat 页（超时窗口内）→ `waiting_user/preflight_login`。
3. TRAE launcher 的 ready 判定 = gateway `/api/status` 的 surface.kind 离开 "setup"；仍为 setup → `waiting_user/preflight_login`。
4. Doubao 的 `process_started_at_ms` 应记录 listener 进程（app 子目录 exe）的启动时间，而非 launcher PID。
5. Gateway 版本兼容白名单待补（traeVersion 1.107.1 / adapter traecn-unknown / compatibility degraded）。

## 7. Gate 0 验收记录

```powershell
npm test          # 全量通过（含新增 host-store / agent-locator / target-supervisor）
$env:UAGENTS_LIVE_TEST='1'
node tests/live/managed-launch-spike.mjs   # ok:true，三个目标全部 trusted + launched + cleaned
```
