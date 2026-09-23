# Codex app-server 审批接入设计草案

> 历史方案，已由 2026-09-24 的简化接入取代。当前 uAgents 不再代理 Codex 原生审批；以下内容仅保留当时的设计与验证背景。

日期：2026-09-24。范围：Windows/Astra 显式 app-server 预览。命令执行及文件改动审批的传输、持久等待和本地 CLI 显式决定已有 fixture 原型；真实 Astra 和安装缓存已验证命令审批的拒绝链路。真实同意、更广的审批类型及可信宿主授权来源尚未验证。未知 server request 仍返回 `native_interaction_required`，Task 保持不确定。

## 已确认的接口和运行时约束

- 原生 server request 带 JSON-RPC `id`，命令执行、文件改动、权限请求的参数均包含 `threadId`、`turnId`、`itemId`；命令审批还有可选 `approvalId`，用于同一 item 的多个 callback。响应必须写回**发出该请求的同一 stdio 连接**。
- 命令及文件改动响应有 `accept`、`decline`、`cancel` 等决定；命令还有作用于本会话或策略的扩展决定。第一阶段仅接 `accept`、`decline`、`cancel`，不添加持久策略。`item/permissions/requestApproval` 的响应不是同一决策形状，须单独设计，不能套用命令响应。
- Worker 现在等待 `adapter.dispatch` 完成才进入 `observe`。现有 `waiting_user` 路径只用于尚未发送 Prompt 的登录预检，进入此态后 Worker 退出。审批发生在已接受 Turn 中；Worker 和 app-server 连接必须继续存活，保留任务租约、进程身份及 workspace guard。
- `task.waiting_user` 事件会净化到阶段信息，不适合存放需审核的原始命令、路径和权限内容。原生请求的完整内容应写入 Task 私有文件；状态/API 只读出有界的审核摘要，不能在通用事件里泄漏敏感参数。

## 建议实现顺序

1. **持久化请求与身份。** 在发出任何响应前，验证请求的 Thread/Turn 匹配已接受的 native binding，且 `itemId`、JSON-RPC `id`、`approvalId`（如有）在本进程内唯一。写 Task 私有请求文件及带内容哈希的 `approval.requested` 事件；事件绑定 task、attempt、原生进程记录、Thread、Turn、Item、callback ID、请求方法和截止时间。异常或身份不匹配时停止并保持不确定。
2. **活体等待。** 传输通过回调让 Worker 将 Task 置为 `waiting_user`，但 `dispatch` 继续持有同一 stdio 连接、心跳和 guard。状态返回审核所需的请求 ID、方法、有限摘要及剩余时间。取消请求可触发原生 Turn interrupt，但只有同一 Turn 的终态可确认取消。
3. **显式决定。** 新的本地 CLI 决定命令必须指定 Task ID、审批请求 ID 和 `accept|decline|cancel`。TaskService 在事务中核对尚待处理、原生身份和唯一决定，并持久化 `approval.decided`。运行中的 Worker 读到决定后，先写 `approval.response_maybe_sent` 检查点，再向**原连接**的 JSON-RPC `id` 回写响应；确认本地写入后记录 `approval.responded`，Task 回到 `running`，继续等待原生终态。重复的相同决定只返回原状态，冲突决定拒绝。MCP 可先提供只读待审状态；写决定须有可信用户授权来源，不由 Agent 自行推断同意。
4. **失联和超时。** Worker/连接丢失时，原请求的 JSON-RPC 响应不能在新进程补发；从已接受 Turn 做只读 reconcile。若历史不能证明终态，Task 保持 `indeterminate`，保留审批记录，不重发 Prompt。超时不自动同意；首阶段可向仍存活的原连接回写 `decline` 并继续观察，无法确认回写或终态则保持不确定。
5. **扩展原生请求种类。** 命令和文件改动两类通过后，再单独处理权限 profile 请求、会话级决定和网络/执行策略修订；每种响应以生成的原生 Schema 校验。未知 server request 一律失败关闭，不返回默认批准。

## 验收门槛

- stdio fixture 逐项覆盖同一 Thread/Turn 的 `accept`、`decline`、`cancel`，重复/冲突决定，错误 Item/Turn、并发请求、超时、Worker 崩溃前后、响应写入失败，以及取消与审批竞态。任何路径最多一个 `turn/start`，未明确授权不得有 `accept` 响应。
- `waiting_user` 全程保留心跳及 workspace guard；Task `resume` 只读恢复已发 Turn，不创建第二次发送。进程和文件身份检查失败时不处理决定。
- 真实 CLI 用最小无副作用命令触发至少一次审批，分别验证明确同意和拒绝的原生结果。再从安装缓存入口验收。只有完成这些证据后，预览 capability 才声明可处理审批。

## 仍需确认的产品决定

审批决定入口应由宿主提供可信的用户授权来源。仅靠可由 Agent 自行调用的 MCP 写工具，无法在协议层证明决定确实来自用户；在该边界明确前，不开放 MCP `accept`。CLI 可以先实现明确的本地操作，但文档必须要求使用者核对完整命令或文件变更内容，不将 Task 提交指令当作后续审批授权。
