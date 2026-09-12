# Dynamic Model Discovery 设计

日期：2026-09-12。

## 目标

让 `models <target>` / `uagents_list_models` 同时展示两类事实：

1. uAgents registry 当前明确允许哪些 route；
2. 本机 native Agent 当前能发现哪些 model label / route。

动态发现只增加本机证据，不改变模型 admission policy。发现到的新模型不会自动进入 allowlist，发现失败也不会删除静态 route。

## 第一版范围

- OpenCode：调用本机 `opencode models <configured-provider-family> --pure`，不传 native `--refresh`，读取本机 catalog 输出。
- WorkBuddy：读取本机 `codebuddy.js --help` 中 `--model` 的 `Currently supported` 列表。
- agy / Doubao / TRAE 暂不增加新的 native model discovery mapping。
- 不发送 prompt，不自动登录，不改配置，不自动选择新模型。

## 输出语义

`models <target>` 继续返回数组，以保留现有调用形状；每个 configured row 增加：

- `configured`: 是否来自 uAgents registry；
- `admission_allowed`: uAgents policy 是否允许提交该 route；
- `discovered`: `true|false|null`，本机 discovery 是否看见；失败/不支持时为 `null`；
- `usable`: `true|false|null`，只表示 configured route 与当前本机 catalog 是否相交，不证明 provider 可用；
- `provider_availability:"unconfirmed"`；
- `discovery.status/method/error_code`。

native discovery 看见但 registry 未批准的模型也作为 row 返回，但固定：

```text
configured=false
admission_allowed=false
usable=false
```

因此 discovery 永远不能扩大 policy allowlist。

## WorkBuddy backend-default

WorkBuddy 的公开 uAgents contract 仍是 `model:"default" -> route_id:"workbuddy-default"`。Native help 中的 `auto` 只作为 backend-default 存在的本机 discovery evidence；其余 concrete model label 仅展示，不自动变成可提交 route。

## Failure semantics

CLI 缺失、native discovery 命令失败或输出无法解析时：

- configured route 仍返回；
- `discovered=null`；
- `usable=null`；
- `discovery.status="failed"` 并保存结构化 `error_code`；
- submit admission 仍由 registry/policy 决定。

## 明确不做

- 不把 catalog presence 当作账号认证、额度或在线可用性证明；
- 不调用 provider prompt；
- 不使用 OpenCode `models --refresh`；
- 不自动修改 registry；
- 不自动切换 route；
- 不把 WorkBuddy concrete labels 猜成 uAgents approved routes。
