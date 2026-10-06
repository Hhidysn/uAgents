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
input_support.files.allowed / input_support.images.allowed
input_support.files.verification / input_support.images.verification
input_support.files.source / input_support.images.source
input_support.files.observed_on / input_support.images.observed_on
input_support.files.evidence_ref / input_support.images.evidence_ref
```

`provider_availability` 当前保持 `unconfirmed`；本机 help/catalog 不能证明登录、额度或 Provider 在线状态。
`selector` 是 Task 请求的 `model` 值；`default=true` 表示该 target 当前 `model="default"` 解析到的路线。
原生发现行有可直接提交的 `selector`。没有可靠目录的 target 也可以提交具体原生 ID，但列表只能显示已配置路线；
未知模型可能在原生执行时失败，uAgents 不会自动换模型重试。Codex、Claude Code、DSH 和 OpenCode 的新模型可使用已实现的原生附件映射，但具体模型能否接收仍未验证；其它 target 的新模型默认只开放 text + workspace。

`input_support` 逐路线展示 uAgents 当前是否允许提交原生附件。`allowed=true` 只说明目标传输和当前路由策略允许提交，
不保证 Provider/model 一定接受。`verification=model_response` 表示有该路线处理样例并回复的记录，
`native_delivery` 表示已核对原生会话中收到附件字节，`transport_mapping` 表示只有原生接口/映射证据，
`indeterminate` 表示真实 Task 尚未确认送达或结果；`native_rejection` 是原生拒绝记录。
`unmapped`、`route_restriction`、`target_restriction` 和 `model_unavailable` 均不可提交该类附件。
`observed_on` 是附件证据的日期，不是模型目录采集时间；目录采集时间仍见 `discovery.observed_at_ms`。
Claude Code 的 `input_support.files.formats` 列出当前映射接受的 PDF 与 UTF-8 文本类型。
证据记录来自仓库中的 `evidence_ref`；未测试过的具体模型不会因出现在目录里变成 `model_response`。

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
OpenCode 的 `route_id` 必须是 `provider/model`。Codex、Claude Code、DSH 和 OpenCode 的新路线沿用 target 已实现的原生附件映射；实际 Provider/model 是否接受由原生调用判定。WorkBuddy 的新路线不自动获得 file/image 附件能力。TRAE 路线也可以用作默认值，
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

## Codex 对话中的预选步骤

Codex 使用 uAgents Skill 准备新 Task 时，先调用 `models <target>` 获取 `selector`、`default`、`discovery` 和逐路线 `input_support` 证据；所需 mode 仍由 `capabilities <target>` 核对。这些查询不发送 Prompt；`models trae` 也不会为列模型启动窗口。

- 用户已写明具体模型：直接把该 ID 用作本次 Task 的 `model`，不因它缺席列表而换模型或要求重新选择；仍按 target 与附件能力校验。
- 用户要求“先选模型”：在对话中列出可提交的 selector、target 默认路线、来源及采集时间；若任务带文件或图片，也列出对应的 `input_support` 及证据日期，然后等待用户回复 `default`、列表项或其它具体 ID。`partial`、`stale`、`configured_only` 和采集时间缺失均须明示。
- 用户未指定且未要求选择：有已配置默认路线就说明后使用 `model="default"`；没有默认路线才请用户选择，不猜测一个默认模型。

这一步只决定一次 Task 的路由，不修改 target 默认配置。列表是候选证据，不证明登录、额度或 Provider 在线。Codex 对话流程位于[agent-dispatch Skill](../../plugins/uagents/skills/agent-dispatch/references/model-choice.md)；当前不是 Codex 应用内的原生模型弹窗。

## 目标模型来源

| Target | 内置 selector / 默认值 | 模型来源 |
| --- | --- | --- |
| agy | `gemini-3.8-flash-medium`；无内置 default | 原生 `agy models` |
| codex | `gpt-6-astra`、`gpt-5.6-luna`；无内置 default | configured-only |
| claudeCode | `claudeCode/deepseek-v4-pro[1m]`、`claudeCode/deepseek-v4-pro`、`claudeCode/deepseek-v4-flash`、`claude-sonnet-4-6`；无内置 default | configured-only |
| workbuddy | backend-default、`deepseek-v4.1-flash` | CLI help 的 supported labels |
| dsh | `deepseek-official/deepseek-flash`；无内置 default | configured-only |
| opencode | `opencode-go/deepseek-v4-flash`、`opencode-go/glm-5.3-flash`；保留 `commandcode-goat/deepseek/deepseek-v4-flash`、`commandcode-goat/z-ai/glm-5.3-flash` 兼容旧配置，无内置 default | 原生版本对应的 provider/model catalog |
| doubao | backend-default | 配置路线 |
| trae | backend-default | 已存在的受管窗口选择器，或个人配置缓存 |

Codex 的 exec 与 Windows/Astra app-server 能力见 [会话规则](sessions.md)。`probe` 只验证版本；没有可信原生模型自报时，即使 Task 成功，`model_verified=false` 仍是准确记录。

Claude Code 将模型 ID 传给 `--model`，以 stream JSON 的 `init.model` 核对。`[1M]` 规范化为 `[1m]`；模型自报相符只证明原生 CLI 身份，不凭名称推断实际上游 Provider。网关与账号目录不由 uAgents 枚举。

DSH 使用明确的 `provider/model` SDK ID，不根据 Web UI label 自动转换。OpenCode V1 使用 `models --pure`，V2 使用一次 `models`；均列出完整原生目录，不按内置供应商过滤；variant 使用 `provider/model#variant`。

TRAE 的显式 `model` 是界面选择器显示名，backend-default 保留当前界面模型。`models trae` 不启动新窗口；无受管实例时只读个人配置的 `solo_agent` 缓存，仅返回 `status=true`、`selectable=true` 的候选。此时 `discovery.status=partial`、`source=local_profile_cache`、`usable=null`；敏感配置不返回或保存，账户缓存不唯一时不使用。

实机调用、路由和模型证据见 [验证记录](../verification/README.md)。
