# 候选 CLI 调用契约

日期：2026-09-03。状态：仅完成本机入口、版本与帮助检查；没有向这些候选 CLI 发送模型提示词，也没有读取登录文件、凭据或余额。

## 结论

下一批候选按当前优先级为 Claude Code、Grok、Pi。三者都具备非交互入口和结构化输出选项，可以继续做适配器设计；在完成真实小任务、会话归属、权限映射、错误解析和产物验收前，不加入 `agent-dispatch` 的生产 target。

| CLI | 本机版本 | 已观察到的非交互/结构化入口 | 当前结论 |
| --- | --- | --- | --- |
| Claude Code | `2.1.251` | `-p/--print`；`--output-format json|stream-json`；`--input-format text|stream-json` | 第一接入候选 |
| Grok | `0.2.118` | `-p/--single` 或 `--prompt-file`；`--output-format json|streaming-json|streaming-messages-json` | 可做独立文本意见路线，但模型与额度必须显式确认 |
| Pi | `0.84.1` | `-p/--print`；`--mode text|json|rpc` | 先解决安全的 prompt 传输和事件协议，再决定是否接入 |

Claude 与 Pi 当前由 npm PowerShell shim 发现，Grok 为用户目录下的原生可执行文件。正式适配器不能硬编码本机用户名；Windows 上应定位原生可执行文件或 JS 入口并用参数数组启动，不用 `cmd`/PowerShell 拼接 prompt。

本机未发现独立 `gemini`、`cursor-agent` 或 `traecli`。`trae-cn` 仍只是 IDE 启动器，不改成 headless Agent；Gemini 任务目前继续由 agy 承担。

## Claude Code 候选形状

无提示词检查：

```powershell
claude --version
claude --help
```

帮助信息表明，新的单轮文本任务可围绕以下参数组合设计：

```text
claude -p
  --input-format text
  --output-format stream-json
  --verbose
  --session-id <新UUID>
  --no-session-persistence
```

- prompt 候选运输方式是标准输入，不放进 shell 命令字符串。
- analysis 可研究 `--permission-mode plan`、`--restricted` 或显式 `--tools`；三者语义不同，未实测前不能写成强制只读保证。
- implementation 候选映射为 `--permission-mode acceptEdits`，并用 `--add-dir <任务workspace>` 提供任务目录；仍需做预期产物的事后验收。
- 不加 `--dangerously-skip-permissions`、`--allow-dangerously-skip-permissions` 或自动 fallback；不使用 `--continue`/`--resume` 代替新任务。
- `json`/`stream-json` 的 init、session、终态、错误和权限拒绝事件仍需通过真实小任务建立解析契约。

Claude Code 还提供原生 `--bg`、`agents`、`logs`、`stop` 和 `rm`。这些命令只算待验证的生命周期候选；在证明后台结果可归属、停止可确认前，不能替换现有 uAgents worker，也不能把“后台已启动”当作完成。

## Grok 候选形状

无提示词检查：

```powershell
grok --version
grok --help
```

帮助信息给出的候选参数如下：

```text
grok
  --prompt-file <任务专用prompt文件>
  --cwd <任务workspace>
  --output-format streaming-json
  --session-id <新UUID>
  --model <显式模型ID>
  --no-subagents
  --no-memory
```

- `--prompt-file` 可避免把完整 prompt 放入命令行；它与单轮模式的准确组合需要真实验证。
- analysis 的 `--permission-mode plan`、`--tools`/`--deny` 与 `--disable-web-search` 需要按任务目标映射；implementation 可候选 `acceptEdits`，但不得使用 `--always-approve` 或 `bypassPermissions`。
- 每次新任务用新的显式 session UUID，不用 `--continue`/`--resume`；是否需要 `--verbatim` 要通过 prompt 回显/行为测试决定。
- 先确认可用模型、账户路线和额度，再建立 allowlist。失败时不自动切换到另一个模型或付费来源。
- 解析器需要验证 session、最终消息、错误事件、进程退出和工具审批，不能只取最后一行文本。

## Pi 候选形状

无提示词检查：

```powershell
pi --version
pi --help
```

帮助信息给出的候选参数如下：

```text
pi --print
  --mode json
  --provider <显式provider>
  --model <显式model>
  --session-id <新ID>
  --session-dir <插件外任务状态目录>
  --no-extensions
  --no-skills
  --no-prompt-templates
  --no-context-files
```

- analysis 可用 `--no-tools`，或只启用 `read,grep,find,ls`；这能限制内置工具，但仍需核对扩展关闭、目录访问和真实事件行为。
- implementation 必须显式决定工具 allowlist 与项目批准方式，不能默认传 `--approve`，也不能把默认工具集当作用户授权。
- 帮助页展示的位置参数示例会把 prompt 放进 argv；正式适配器应先验证 stdin、`rpc` 或任务专用输入文件方案，避免 shell 拼接和长命令行泄露。
- 不传 `--api-key`，不调用会打印 token/key 的 `pi auth` 子命令，不读取认证文件。
- `json` 与 `rpc` 哪个能稳定提供 session、最终消息、错误和工具审批事件，仍需用最小真实任务选择。

## 接入门槛

每个候选独立完成以下证据后，才添加 reference、target allowlist、适配器和测试：

1. 固定版本的无提示词 probe，以及一个用户授权的最小真实文本任务。
2. prompt 不经过 shell 字符串；显式 cwd、模型、会话 ID 和插件外状态目录。
3. analysis/implementation 的权限映射与拒绝状态，且不绕过全部审批。
4. 结构化输出的会话归属、唯一终态、错误/截断/非零退出解析。
5. implementation 的任务目录、预期产物、大小和摘要验收。
6. 超时、取消和 worker 失联后的 `unknown` 语义；不通过换 UUID 自动重发。

本记录描述可继续验证的调用形状，不等于登录、额度、模型可用性或生产接入已经通过。
