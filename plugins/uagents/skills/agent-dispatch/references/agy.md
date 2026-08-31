# agy：原生权限预览

本机验证基线：agy 1.1.22、Node 24.13.0、Windows。CLI 由 PATH 发现，插件不内置 CLI、登录凭据或本机安装路径。无 npm 运行依赖。

## 权限与工作目录

用户已明确不要求强制只读。脚本使用默认原生 Agent，保留 `--sandbox` 终端限制，不加 `--dangerously-skip-permissions`，不生成空工具自定义 Agent。implementation 通过单次 `--mode accept-edits` 允许文件创建和修改；命令等工具仍受原生权限约束。analysis 继承原生模式。`init.tools` 可以包含写文件等工具；握手校验指定模型、原生会话 ID 和进程 cwd，记录 permission_mode 及请求的文件修改模式。

每个任务使用 `<state-dir>/<request_id>/workspace`。worker 通过 `--add-dir` 显式加入目录，并在提示词前附绝对路径和预期产物。仅设置进程 cwd 不足：首个真实任务曾被 agy 写到其自有 scratch 目录。当前会检查 expected_outputs 的实际位置；它是事后验收，不是限制 Agent 访问范围的安全沙箱。原生项目/登录/缓存及账户历史仍由 agy 管理，插件不修改其配置。

## 请求与命令

请求 JSON 仅支持以下字段；未知字段会拒绝，不能默默忽略权限要求：

```json
{
  "request_id": "9de3b16c-f16f-44a0-8c5a-a436a35d6d4f",
  "target": "agy",
  "model": "gemini-3.1-pro-low",
  "mode": "implementation",
  "permission_policy": "native",
  "expected_outputs": ["index.html"],
  "prompt": "在指定任务目录创建 index.html：中文待办页面，内嵌 CSS/JS，可新增任务和切换完成状态。只修改此文件，不安装依赖，不委派其他 agent。",
  "timeout_ms": 120000
}
```

示例模型不是自动默认值。实际使用前核对目标和当前可用模型；每次有意的新任务生成新的 UUID。请求正文不要放进命令行参数，避免 Windows 命令行转义和长度问题。默认 permission_policy 为 native；其他值会拒绝。纯文本使用 mode=analysis，expected_outputs 可省略；它不强制只读。

implementation 必须列出 1–16 个相对产物路径，用 `/` 分隔，不允许绝对路径、`..`、Windows 特殊文件名或数据流。文件必须实际位于任务 workspace 内、非空且不超过 10 MiB；结果记录路径、字节数及 SHA-256。原生成功但文件缺失或解析到目录外时返回 failed / expected_output_validation_failed，保留原生答案供核对，不自动复制答案中声称的外部文件。

下列路径占位应替换为实际绝对路径：

```powershell
node "<skill目录>/scripts/agent-call.mjs" capabilities
node "<skill目录>/scripts/agent-call.mjs" submit --request "<请求JSON路径>" --state-dir "<状态目录>"
node "<skill目录>/scripts/agent-call.mjs" status --id "<request_id>" --state-dir "<状态目录>"
node "<skill目录>/scripts/agent-call.mjs" result --id "<request_id>" --state-dir "<状态目录>"
node "<skill目录>/scripts/agent-call.mjs" cancel --id "<request_id>" --state-dir "<状态目录>"
```

仅检查环境时，把动词换成 `probe`，并从请求 JSON 去掉 `prompt`。probe 不发送 user 消息；其成功只表示预检通过。

正常 submit 自带预检，不需要先 probe 一遍。先写明任务范围与产物路径；生成文件不会自动合并进调用方项目。Codex 验收后再按用户授权整合。

## 状态和失败处理

| 返回 | 含义与处理 |
| --- | --- |
| `starting` / `preflight` | worker 启动或正在核对 CLI；尚未发送提示词 |
| `running` | 已记录发送意图，可能已发出；不要重复提交 |
| `succeeded` | 本次运行有匹配的原生结果；probe 的范围仍仅为 preflight_only |
| `blocked` | 模型/会话/工作目录身份不符，或发送前出现工具事件；核对目标配置 |
| `failed` | 明确失败；查看是否 not_sent，仍不自动重试 |
| `needs_user` | 原生请求需要处理或权限被拒绝；不要自动批准 |
| `cancelled` | 确认发送前停止，或原生返回明确取消结果 |
| `unknown` | 发送后断线、超时/取消未确认、结果不匹配或心跳过期；需人工核对原生会话 |

同一 UUID 和相同有效输入返回已有任务，不重复发送；输入不同返回 `request_conflict`。已有登记不完整时也不启动替代任务。不要通过换 UUID 绕过未知状态。

当前只验证短工具调用退出后的后台存活；未验证关闭 Codex、注销 Windows、重启或系统休眠。15 秒未见 worker 心跳时，查询按未知处理；这不是自动判断远端停止。取消不按保存的 PID 批量杀进程。

## 数据与限制

必要答案保存为 `result.json`，状态保存标识、摘要和错误码；worker 读取后删除自己的短期 `inbox.json`。外部调用方创建的原请求 JSON 不会被自动删除；登记/启动异常也可能留下 inbox。只在任务已经核对结束后处理这些文件。

本版无自动清理、保留期或容量管理，状态目录按本机用户权限使用，不面向不可信本机进程或多用户隔离。插件自身不记录完整原生事件日志，CLI 的账户历史、缓存与其自身记录政策另行适用。

本版支持专用目录内产出文件，不支持直接指定现有项目、硬性 owned_paths 限制、图像输入/生成的专门适配、续接、跨供应商回退或远端取消确认。文件路径验收通过不代表视觉质量或交互正确，必须另行检查。历史预检和后续真实运行分别记录在仓库验证报告中。

依据：[Headless CLI](https://antigravity.google/docs/cli/headless/)、[权限规则](https://antigravity.google/docs/cli/permissions/)、[自定义 Agent](https://antigravity.google/docs/subagents)。具体调用字段同时以当前 `agy --help` 为准。
