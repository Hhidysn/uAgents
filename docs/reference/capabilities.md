# Capability 语义

`uagents capabilities <target>` 返回当前 target 的静态能力。常见字段不要互相替代解释。

## Inputs

- `text`：可以发送文本任务。
- `files`：uAgents 有经过验证的 native file attachment mapping。
- `images`：uAgents 有经过验证的 native image mapping；某些 target 还会被 model-specific route policy 收紧。
- `workspace_readable`：Agent 可以通过自身 coding tools 使用初始化 workspace。它不等于 `files=true`。

## Modes

- `analysis`：允许分析型 Task。
- `implementation`：允许目标使用自身实现/编辑流程。

Mode 不是执行沙箱，也不是硬权限边界。

## Session

- `resume`：这里指 native session continuation mapping。
- `fork`：native session branch mapping。
- `lifecycle.resume`：同一个 uAgents Task 的受管生命周期恢复能力。

三者含义不同。

## Model routing

- `configured`：route 在当前 registry 中存在，可能来自内置路线或用户配置。
- `selector`：Task 请求中可使用的 `model` 值；原生发现行也会给出可直接提交的 selector。
- `default`：该 route 是否为 target 当前 `model="default"` 的解析结果。
- `admission_allowed`：当前 policy 可以把该 selector 交给原生 target；不证明模型在执行时仍可用。
- `discovered`：本机 Agent catalog/help 中发现了该模型证据。
- `usable`：新鲜的原生 discovery 中存在该模型；不表示 Provider 登录、额度或在线状态已经确认。没有目录证据时为 `null`。

## Cancellation

`local-request` 表示 uAgents 可以停止自己的本地观察或受控进程动作，但不应被理解为 Provider 已确认取消远端生成。
