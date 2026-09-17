# 当前模型与路由

模型 admission 由静态 registry 决定。Dynamic discovery 只补充本机 native evidence，不会自动扩大 allowlist。

```text
uagents models <target>
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
```

`provider_availability` 当前保持 `unconfirmed`；本机 help/catalog 不能证明登录、额度或 Provider 在线状态。

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

## OpenCode

当前批准路线包括：

```text
commandcode-goat/deepseek/deepseek-v4-flash
commandcode-goat/z-ai/glm-5.3-flash
```

本机 `opencode models <provider> --pure` 发现到的其它模型只作为 discovery evidence。

## 其它 target

agy 使用显式静态路线；Doubao/TRAE 继续使用当前 backend/default contract，没有可靠 native catalog 时不猜模型。
