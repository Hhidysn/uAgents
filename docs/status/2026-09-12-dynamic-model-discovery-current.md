# Dynamic Model Discovery 当前状态

日期：2026-09-12。本文是当前源码模型发现能力的权威状态入口。

## 当前行为

```text
uagents models <target>
uagents_list_models
```

不再只返回静态 allowlist。对于 WorkBuddy/OpenCode，它会把 registry route 与本机 native model discovery 合并，同时保持 registry 为最终 admission 权威。

返回 row 的核心字段：

```text
configured
admission_allowed
discovered
usable
provider_availability
discovery.status
discovery.method
```

`provider_availability` 当前固定为 `unconfirmed`：本机 catalog/help 不能证明账号、额度、provider 在线状态，也不能代替真实任务执行。

## OpenCode

当前使用本机：

```text
opencode models <configured-provider-family> --pure
```

不传 `--refresh`。当前机器对 `commandcode-goat` 实际发现：

```text
commandcode-goat/deepseek/deepseek-v4-flash   configured=true
commandcode-goat/z-ai/glm-5.3-flash          configured=true
commandcode-goat/deepseek/deepseek-v4-pro    configured=false
commandcode-goat/z-ai/glm-5.3                 configured=false
```

后两条只是本机 catalog evidence，uAgents 不允许因此直接提交。

## WorkBuddy

当前通过本机 `codebuddy.js --help` 的 `--model` 描述读取 supported labels。当前机器发现 `auto` 加 14 个 concrete model labels。

uAgents contract 仍然只允许：

```text
model=default
route_id=workbuddy-default
```

`auto` 仅用于证明 backend-default native selection 存在；其他 concrete labels 会显示为 `configured=false`，不会自动成为 route。

## 失败与兼容

Dynamic discovery 失败不会破坏旧静态行为：configured rows 仍返回，`discovered/usable=null`，并附结构化 discovery error。现有 submit policy 未接入 dynamic discovery gate，因此 allow/deny 仍只由 registry/policy 决定。

agy、Doubao、TRAE 当前没有新增 native dynamic discovery；它们继续使用既有模型 contract。

## Provider 边界

本功能只执行本机 no-prompt CLI metadata/catalog 命令。本轮没有发送 WorkBuddy/OpenCode prompt，没有执行 provider-billable E2E，也没有启用 OpenCode native `--refresh`。

详细设计见 [Dynamic Model Discovery 设计](../superpowers/specs/2026-09-12-dynamic-model-discovery-design.md)，验证证据见 [Dynamic Model Discovery 验证](../verification/2026-09-12-dynamic-model-discovery.md)。

## 当前验证

```text
Model Discovery + CLI targeted   20/20
Unified MCP targeted             10/10

Core                            308/308
Doubao MCP                       11/11
TRAE MCP                          9/9
Unified MCP                      10/10
Total                           338/338
```

Skill validator、Plugin validator 与 `git diff --check` 均已通过。
