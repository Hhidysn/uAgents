# WorkBuddy：内嵌 CLI

只在选定 WorkBuddy 时读取。Windows 实测 2.132.0；通过现有 GUI 安装中的 codebuddy.js 调用，不复制登录态或安装独立 CLI。

## 路线与入口

- target 为 workbuddy，model 必须显式写 workbuddy-default。脚本省略 --model，沿用本机现有路线；真实 init 本次报告 auto，没有证明具体底层模型或免费额度。
- 自动寻找 Program Files / LocalAppData Programs 下的 WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy.js；自定义安装可用 UAGENTS_WORKBUDDY_CLI 指向该文件的绝对路径。
- 使用 Node 直接运行 JS，不调用 cmd/powershell 转发 prompt。不要读取登录文件或设置认证变量，不配置 fallback-model。
- implementation 单次传 --permission-mode acceptEdits；analysis 继承原生模式。不加 -y/bypassPermissions。命令/网络操作若被原生拒绝，记录并返回，不自动扩权。

## 请求与执行

复用本 Skill scripts/agent-call.mjs 的 submit/status/result/cancel，入口按 Skill 位置解析为绝对路径。请求示例：

```json
{
  "request_id": "替换为新UUID",
  "target": "workbuddy",
  "model": "workbuddy-default",
  "mode": "implementation",
  "expected_outputs": ["verification.txt"],
  "prompt": "在指定目录创建 verification.txt，内容为本次任务的验收摘要。只写该文件，不委派、不启动后台任务。",
  "timeout_ms": 180000
}
```

```powershell
node "<skill绝对目录>/scripts/agent-call.mjs" capabilities --target workbuddy
node "<skill绝对目录>/scripts/agent-call.mjs" submit --request "<请求JSON绝对路径>" --state-dir "<插件外绝对目录>"
node "<skill绝对目录>/scripts/agent-call.mjs" status --id "<request_id>" --state-dir "<同一状态目录>"
node "<skill绝对目录>/scripts/agent-call.mjs" result --id "<request_id>" --state-dir "<同一状态目录>"
```

纯文本任务改 mode=analysis，expected_outputs 可省略。implementation 必须列出 1–16 个相对文件路径，用 / 分隔，不允许 ..、绝对路径或 Windows 特殊文件名；每个文件非空且不超过 10 MiB。文件检查不提供硬性路径隔离，结果还需按任务要求验收。

## 回收与限制

使用 -p + stream-json + --verbose、显式 --session-id 和 stdin 输入；不续接最近会话。WorkBuddy 的原生 session UUID 在本适配器中有意等于本地 request_id，字段职责仍不同。输入可能在 init 前已发送；会话 ID 和 cwd 是事后核对，身份异常按 unknown，不假装请求未发出。

需要 init、匹配 session 的唯一 result、subtype=success、is_error=false、非空答案、退出 0，且无待完成后台任务，才算成功。permission_denials 导致 needs_user；错误事件、截断或混合会话不会因零退出而变成成功。

每任务一个现有 Node worker 维持流，提交工具可先退出。已核对原生 --bg/ps/logs/stop，但 Windows 实测 --bg 返回成功后 logs 找不到该会话、专属日志为空；该次完成状态未知，未自动重发。因此本版不用它承担正式结果回收，也不启动常驻 HTTP 服务。

本版是单轮任务，单次最多 6 个 agentic turns；设置公开变量 CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS=1，禁用模型派生的后台工作。不是限制文件读写权限。不承诺 GUI 中的腾讯连接器在 CLI 中全部可用。

取消、超时、worker 失联：缺少原生远端停止确认时返回 unknown，保留 ID，不自动重提。同 UUID 相同有效请求返回已有任务；修改请求需新 UUID，但不能借此绕过尚未核清的 unknown。

probe 仅运行 --version，成功范围为 version_only，不能据此确认登录或余额。状态/结果保存在插件外；临时 inbox 读取后删除，调用方请求文件和原生账户历史遵循各自保留方式，无自动清理。

依据：本机安装包附带 docs/cn/cli/headless.md、cli-reference.md、daemon.md 与当前 --help；这些是能力文档，真实验收证据见仓库验证报告。
