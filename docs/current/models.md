# 当前模型与路由

模型 admission 由当前 policy 决定：静态 registry route 是主要来源，agy 另外保留显式
`gemini-*` pattern admission。Dynamic discovery 只补充本机 native evidence，不会把发现到的模型写回 registry，
也不会替提交选择默认模型。

```text
uagents models <target>
uagents models <target> --refresh
```

常见字段：

```text
configured
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

它作为静态 configured route 保存，但 agy 仍没有 default model；提交必须显式指定模型。

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

`gpt-5.6-luna` 已通过本机 Codex CLI 原生请求及安装版 uAgents `submit` / `result` 的真实模型调用，见 [2026-09-20 验证记录](../verification/2026-09-20-codex-luna-installed-e2e.md)。Codex CLI v1 当前没有可靠的 no-prompt native model catalog，`models codex` 展示 configured-only route；没有自动 default，提交仍需显式传入模型。`probe codex --model gpt-5.6-luna` 和 `probe codex --model gpt-6-astra` 都是 version-only，本身不能证明 Provider 当前可用。Native JSONL 没有可信模型自报字段，故 Luna 真实调用成功时 `model_verified=false` 仍为准确的模型身份记录。

## OpenCode

当前批准路线包括：

```text
commandcode-goat/deepseek/deepseek-v4-flash
commandcode-goat/z-ai/glm-5.3-flash
```

本机 `opencode models <provider> --pure` 发现到的其它模型只作为 discovery evidence。

## 其它 target

Codex/DSH 当前只展示 configured route。Doubao/TRAE 继续使用 backend/default contract，没有可靠 native catalog 时不猜模型。
这四类 configured-only target 不创建 native catalog cache。
