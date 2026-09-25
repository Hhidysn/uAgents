# 当前模型与路由

对有原生模型选择接口的 target，显式模型 ID 会作为数据传给 CLI 或网关，由目标判定是否存在及可用。内置和用户登记的 route 用于配置默认值、
已验证的附件能力及记录；原生发现到的新模型无需先登记。Dynamic discovery 不会写回 registry，也不会自行选择默认模型。
用户在配置中禁用的具体路线仍不可用；uAgents 继续校验请求格式、target 能力和附件映射。

```text
uagents models <target>
uagents models <target> --refresh
```

常见字段：

```text
configured
selector
default
admission_allowed
discovered
usable
provider_availability
discovery.status
discovery.method
discovery.source
discovery.observed_at_ms
discovery.expires_at_ms
discovery.age_ms
discovery.stale
```

`provider_availability` 当前保持 `unconfirmed`；本机 help/catalog 不能证明登录、额度或 Provider 在线状态。
`selector` 是 Task 请求的 `model` 值；`default=true` 表示该 target 当前 `model="default"` 解析到的路线。
原生发现行有可直接提交的 `selector`。没有可靠目录的 target 也可以提交具体原生 ID，但列表只能显示已配置路线；
未知模型可能在原生执行时失败，uAgents 不会自动换模型重试。新模型只开放 text + workspace，附件须另行验证。

## 默认模型与单次覆盖

在 JSON 配置中为 target 选定已登记的路线，例如：

```json
{
  "defaults": {
    "claudeCode": "claudeCode/deepseek-v4-pro[1m]",
    "codex": "gpt-5.6-luna"
  }
}
```

CLI 使用 `--config <绝对路径>`，或在 CLI/MCP 进程环境中设置 `UAGENTS_CONFIG=<绝对路径>`。
`uagents config validate --config <绝对路径>` 会验证路线和默认值。每个 Task 可以省略 `model` 或写
`"model":"default"` 使用该 target 默认值；本次 Task 写入 `"model":"gpt-6-astra"` 等具体 `selector`
则只覆盖这一次。没有已配置默认值的 target 会在提交前返回 `model_unavailable`。内置的 WorkBuddy、Doubao、TRAE
默认值仍指向其 backend-default 路线；Codex、Claude Code、agy、DSH 和 OpenCode 不擅自猜测默认模型。
uAgents 的默认值是明确路线，和 Agent 自己设置中的“默认”不必相同。最终 `model_resolved`、`route_id` 和配置版本写入 Task；
配置变更不会改变已登记 Task，同 UUID 使用不同有效路线会按现有幂等规则拒绝。

若要将新模型设为默认值，在配置中登记其路线。例如 WorkBuddy：

```json
{
  "routes": {
    "workbuddy/glm-5.3-flash": {
      "target": "workbuddy",
      "model": "glm-5.3-flash",
      "provider": "workbuddy",
      "route_id": "workbuddy/glm-5.3-flash"
    }
  },
  "defaults": { "workbuddy": "workbuddy/glm-5.3-flash" }
}
```

新路线的 `selector` 必须以 `<target>/` 开头，`provider` / `route_id` 要与该 target 的 native 模型身份对应；
OpenCode 的 `route_id` 必须是 `provider/model`。新路线不会自动获得 file/image 附件能力。TRAE 路线也可以用作默认值，
`model` 填网关模型选择器显示的原始名称。用户登记只表示定义默认/别名，不表示 Provider 已验证；真实调用失败时不自动切换模型。

## 缓存与刷新

WorkBuddy、OpenCode、agy 的 native catalog 使用 per-user HostStore 缓存：

- TTL：10 分钟；
- 普通 `models <target>`：缓存未过期时直接复用；
- `--refresh`：绕过 model catalog cache，立即重新执行 native discovery；
- 已验证的 native executable identity 变化时使用新的 cache key，不复用旧安装的 catalog；
- native refresh 失败但同一 executable identity 有旧 snapshot 时，返回 stale snapshot，并在
  `discovery.refresh_error` 中记录刷新失败；此时 `usable=null`；
- discovery cache 只保存 native evidence，`admission_allowed` 每次读取都用当前 registry/policy 重新计算；
- submit 不依赖 model discovery cache；模型存在性和账户可用性由原生 target 执行时确认。

CLI/MCP 不做后台刷新。只有显式调用 model listing 且缓存缺失/过期，或调用方要求 refresh 时才执行 native discovery。

## agy

agy 1.2.5 使用：

```text
agy models
```

作为 no-prompt native catalog。当前已真实验证的 concrete route：

```text
gemini-3.8-flash-medium
```

它作为内置 configured route 保存；agy 没有内置 default model，但可以在用户配置中指定。

其它被 native catalog 发现的模型，包括 Claude/GPT 标签，均可用返回的 `selector` 提交。

## WorkBuddy

内置路线：

```text
default
deepseek-v4.1-flash
```

`default` 是 backend-default 文本路线；`deepseek-v4.1-flash` 是显式 concrete route，并拥有已验证的 image capability。

本机其它 supported labels 会显示为 discovered-only，也可直接用于 text + workspace Task。

## DSH

当前内置路线：

```text
deepseek-official/deepseek-flash
```

DeepSeek Harness Web UI 的展示名不等于 SDK API model id。可传入其它明确的 `provider/model` SDK ID；
uAgents 不根据 UI label 自动转换，也没有原生目录可预先确认这些 ID。

## Codex CLI

当前内置路线：

```text
gpt-6-astra
gpt-5.6-luna
```

`gpt-5.6-luna` 已通过本机 Codex CLI 原生请求及安装版 uAgents `submit` / `result` 的真实模型调用，见 [2026-09-20 验证记录](../verification/2026-09-20-codex-luna-installed-e2e.md)。`gpt-6-astra` 已通过安装版 Windows app-server 显式预览路线的真实多轮续接、fork 及简化版普通任务调用，见 [app-server 验证记录](../verification/2026-09-23-codex-app-server-spike.md)。默认 `exec` 路线和显式 app-server 路线的能力范围见 [会话规则](sessions.md)。Codex CLI 当前没有可靠的 no-prompt native model catalog，`models codex` 展示 configured-only route；没有内置 default，未配置用户默认值时提交仍需显式传入模型。`probe codex --model gpt-5.6-luna` 和 `probe codex --model gpt-6-astra` 都是 version-only，本身不能证明 Provider 当前可用。原生事件没有可信模型自报字段，真实调用成功时 `model_verified=false` 仍为准确的模型身份记录。

## Claude Code CLI

当前内置显式路线：`claudeCode/deepseek-v4-pro[1m]`、`claudeCode/deepseek-v4-pro`、`claudeCode/deepseek-v4-flash`，以及 `claude-sonnet-4-6`。前面三个对应本机 Claude Code 用户设置中的 DeepSeek 网关模型；CLI 将 `[1M]` 规范化为 `[1m]`，uAgents 使用规范化的小写形式。`claude-sonnet-4-6` 是先前单独验证的 CLI 模型 ID，不能仅凭其名称或 CLI 自报断定实际上游 Provider。

uAgents 将解析后的模型 ID 传给 Claude Code `--model`，并核对 stream JSON 的 `init.model`；`model_verified=true` 只表示 CLI 自报与请求相符。`models claudeCode` 为 configured-only，不自动枚举网关/账号模型目录，也不提供内置默认模型；用户可以配置默认路线。`probe claudeCode --model claudeCode/deepseek-v4-pro[1m]` 为 version-only。当前机器的原生 CLI 与 uAgents Task 验证见 [记录](../verification/2026-09-25-claude-code-cli.md)。

## OpenCode

当前内置路线包括：

```text
commandcode-goat/deepseek/deepseek-v4-flash
commandcode-goat/z-ai/glm-5.3-flash
```

本机 `opencode models <provider> --pure` 发现到的其它模型可直接按 `provider/model` 传入。当前目录范围由已配置路线涉及的 provider 决定；
不在列表中的 provider/model 也可以显式提交，最终由 OpenCode 校验。

## 其它 target

Codex、Claude Code 和 DSH 当前只展示 configured route；没有原生目录，不推断其完整模型列表。Doubao 继续使用 backend/default contract。
TRAE 网关提供 `GET /api/models`：列出当前界面模型选择器中的名称；Task 可显式传入该名称，网关会在发送任务前切换模型。
TRAE 的 backend default 仍沿用当前界面模型，不从列表猜一个默认值。模型列表需要专用受管实例已完成原生设置/登录并显示工作台；已打开的个人窗口不会被复用。当前没有逐 Task 可核对的模型自报。
