# TRAE CN：本地 Solo 任务

只在选择 TRAE CN 时读取。该路线通过回环 CDP 驱动用户已登录的 TRAE CN IDE Solo，消耗当前 TRAE CN 账户可用额度；不保证每日免费额度，也不改用企业 `traecli`、TRAE Work 或其他计费来源。

## 显式准备

插件不会自动启动、结束或重启 TRAE。先完全退出未带 CDP 的 TRAE CN，再以专用端口启动。当前 Windows 版本不要传 `--remote-debugging-address`，它会被 TRAE 1.107.1 主进程当作未知参数。已验证的启动参数是：

```powershell
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = "$env:LOCALAPPDATA\Programs\Trae CN\Trae CN.exe"
$psi.UseShellExecute = $true
[void]$psi.ArgumentList.Add('--remote-debugging-port=9223')
[void]$psi.ArgumentList.Add('--reuse-window')
[void]$psi.ArgumentList.Add((Resolve-Path 'C:\path\to\project').Path)
[System.Diagnostics.Process]::Start($psi)
```

工作区参数改为当前任务的绝对目录。首开目录出现“是否信任此文件夹”时，由用户在 TRAE 窗口中决定；桥接器不代替用户接受信任。

另开一个终端，在已安装插件的根目录显式启动网关并保持运行：

```powershell
$env:UAGENTS_TRAE_CDP_PORT = '9223'
node .\mcp\trae\scripts\start-gateway.mjs
```

网关只绑定 `127.0.0.1`，严格连接指定 CDP 端口，不扫描或误连豆包等其他 Electron 应用。它不会自动启动 TRAE，不启用 mock，不自动审批对话，也不在模型错误后重放任务。状态、审计和任务历史写在插件目录外的 `PLUGIN_DATA` 或 `%USERPROFILE%\.uagents\trae-cn`；可用绝对路径环境变量 `UAGENTS_TRAE_STATE_DIR` 覆盖。MCP 自身只保存请求摘要，但上游网关的任务历史会保存任务文本与结果，因此只传任务必需内容。

## 调用步骤

1. 调用 `trae_probe`。只有 TRAE 进程、CDP、workbench 页面身份全部匹配才返回 `available`；它不发送提示词，也不保证账户仍有额度。
2. 为每个有意的新任务生成 UUID。调用 `trae_submit`，传 `request_id`、任务必需的 `prompt`、绝对 `workspace` 和可选 `timeout_ms`。同一 UUID 与相同输入只返回已有记录；同 UUID 改输入会拒绝。
3. 用同一 UUID 调用 `trae_status`。`running` 有界查询；`needs_user` 让用户在 TRAE 窗口处理审批后再查；`failed` 保留原生错误；`unknown` 不重发。
4. 终态用 `trae_result` 取结果。Windows 当前使用未验证适配器，可能返回带 Solo 面板 UI 文本的整块响应，仍需按原任务标准检查内容和产物。

当前只公开 `trae_probe`、`trae_submit`、`trae_status`、`trae_result`。没有 `cancel` 或审批决定工具：上游取消会在停止生成失败时仍标记 cancelled，不能作为可靠确认；审批在 TRAE 窗口由用户处理。

TRAE 模型返回“积分不足”时直接报告失败。不要自动换 UUID、切换模型、打开 TRAE Work 或改走付费路线。
