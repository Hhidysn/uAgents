# 当前模型与路由

模型 admission 由当前 policy 决定：内置 route 和用户显式登记的 route 是主要来源，agy 另外保留显式
`gemini-*` pattern admission。Dynamic discovery 只补充本机 native evidence，不会把发现到的模型写回 registry，
也不会自行选择默认模型。

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
发现但未登记的行没有 `selector`。有些 agy `gemini-*` 模型可由现有 pattern policy 直接指定，其它发现模型需用户显式登记。

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

对本机目录发现但尚未批准的模型，可明确登记 text + workspace 路线，再选为默认或按 Task 指定。例如 WorkBuddy：

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
OpenCode 的 `route_id` 必须是 `provider/model`。新路线不会自动获得 file/image 附件能力，不能用于只支持 backend
default 的桌面 target。用户登记只表示允许尝试，不表示 Provider 已验证；真实调用失败时不自动切换模型。

## 缓存与刷新

WorkBuddy、OpenCode、agy 的 native catalog 使用 per-user HostStore 缓存：

- TTL：10 分钟；
- 普通 `models <target>`：缓存未过期时直接复用；
- `--refresh`：绕过 model catalog cache，立即重新执行 native discovery；
- 已验证的 native executable identity 变化时使用新的 cache key，不复用旧安装的 catalog；
- native refresh 失败但同一 executable identity 有旧 snapshot 时，返回 stale snapshot，并在
  `discovery.refresh_error` 中记录刷新失败；此时 `usable=null`；
- discovery cache 只保存 native evidence，`admission_allowed` 每次读取都用当前 registry/policy 重新计算；
- submit 不读取 model discovery cache，缓存不能扩大准入。

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

其它被 native catalog 发现的 `gemini-*` 会按现有 pattern policy 得到
`admission_allowed=true`。例如 Claude/GPT 模型即使由 agy catalog 返回，也不会仅因为被发现就自动放行。

## WorkBuddy

批准路线：

```text
default
deepseek-v4.1-flash
```

`default` 是 backend-default 文本路线；`deepseek-v4.1-flash` 是显式 concrete route，并拥有已验证的 image capability。

本机其它 supported labels 可以显示为 discovered-only，但不会自动允许提交。

## DSH

当前批准路线：

```text
deepseek-official/deepseek-flash
```

DeepSeek Harness Web UI 的展示名不等于 SDK API model id。uAgents 使用已真实验证的 SDK route，不根据 UI label 自动转换或扩大 allowlist。

## Codex CLI

当前批准路线：

```text
gpt-6-astra
gpt-5.6-luna
```

`gpt-5.6-luna` 已通过本机 Codex CLI 原生请求及安装版 uAgents `submit` / `result` 的真实模型调用，见 [2026-09-20 验证记录](../verification/2026-09-20-codex-luna-installed-e2e.md)。`gpt-6-astra` 已通过安装版 Windows app-server 显式预览路线的真实多轮续接、fork 及简化版普通任务调用，见 [app-server 验证记录](../verification/2026-09-23-codex-app-server-spike.md)。默认 `exec` 路线和显式 app-server 路线的能力范围见 [会话规则](sessions.md)。Codex CLI 当前没有可靠的 no-prompt native model catalog，`models codex` 展示 configured-only route；没有内置 default，未配置用户默认值时提交仍需显式传入模型。`probe codex --model gpt-5.6-luna` 和 `probe codex --model gpt-6-astra` 都是 version-only，本身不能证明 Provider 当前可用。原生事件没有可信模型自报字段，真实调用成功时 `model_verified=false` 仍为准确的模型身份记录。

## Claude Code CLI

当前批准显式路线：`claudeCode/deepseek-v4-pro[1m]`、`claudeCode/deepseek-v4-pro`、`claudeCode/deepseek-v4-flash`，以及 `claude-sonnet-4-6`。前面三个对应本机 Claude Code 用户设置中的 DeepSeek 网关模型；CLI 将 `[1M]` 规范化为 `[1m]`，uAgents 使用规范化的小写形式。`claude-sonnet-4-6` 是先前单独验证的 CLI 模型 ID，不能仅凭其名称或 CLI 自报断定实际上游 Provider。

uAgents 将解析后的模型 ID 传给 Claude Code `--model`，并核对 stream JSON 的 `init.model`；`model_verified=true` 只表示 CLI 自报与请求相符。`models claudeCode` 为 configured-only，不自动枚举网关/账号模型目录，也不提供内置默认模型；用户可以配置默认路线。`probe claudeCode --model claudeCode/deepseek-v4-pro[1m]` 为 version-only。当前机器的原生 CLI 与 uAgents Task 验证见 [记录](../verification/2026-09-25-claude-code-cli.md)。

## OpenCode

当前批准路线包括：

```text
commandcode-goat/deepseek/deepseek-v4-flash
commandcode-goat/z-ai/glm-5.3-flash
```

本机 `opencode models <provider> --pure` 发现到的其它模型只作为 discovery evidence。

## 其它 target

Codex、Claude Code 和 DSH 当前只展示 configured route。Doubao/TRAE 继续使用 backend/default contract，没有可靠 native catalog 时不猜模型。
这些 configured-only target 不创建 native catalog cache。
