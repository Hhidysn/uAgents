# 下一阶段功能交接：Universal Attachment Input

日期：2026-09-09

本文是下一次开发对话的启动入口。目标不是继续扩 durable/fencing 防御，而是在当前稳定 Runtime 上补齐
**文件附件、图片/多模态和 target-specific input mapping**。

## 当前代码基线

- 功能源码基线：`04e3317 refactor: centralize sensitive field rules`。
- 前一轮架构收敛：`d40446a refactor: centralize path containment checks`。
- 真实 OpenCode provider E2E 文档：`50ae9bc docs: record real OpenCode E2E verification`。
- 最近完整本地门禁：Core `266/266` + MCP `11/9/2` = **288/288**。
- 工作树在开始本轮文档整理前为 clean。
- 当前仓库 tracked plugin 文件：121。
- 已安装 cache `0.2.0-alpha.1+codex.20260907011733` 和 `C:\Users\24590\plugins\uagents` 仍是
  2026-09-07 发布候选，不包含后续 cleanup 新增的 `src/path-containment.mjs`、`src/sensitive-fields.mjs`。
  新功能开发必须以仓库源码为准，不能直接从旧 cache 反推当前实现。

## 附件能力真值

### Schema

当前请求 Schema 只有：

```json
{
  "inputs": [
    { "type": "file", "path": "relative/path.ext" }
  ]
}
```

约束：

- `inputs[].type` 只能是 `file`；没有 `image`。
- `path` 必须是 workspace 内的安全相对路径。
- 当前没有 blob/base64/file-id/URL/任意外部绝对路径 ingestion。
- 输入注册时会做 realpath/范围检查、size + SHA-256 snapshot；dispatch 前会验证 snapshot 未变化。

### Target 真值

| Target | Registry `files` | 真实 native file mapping | 图片 | 说明 |
| --- | ---: | ---: | ---: | --- |
| OpenCode | true | **已实现** | false | `request.inputs` → `--file <absolute-path>`；已有真实 provider file-input E2E |
| agy | true | **未实现** | false | transport 不读取 `request.inputs`；只把 workspace 加到工作目录/`--add-dir`，Agent 可自行用文件工具读取 |
| WorkBuddy | true | **未实现** | false | transport 不读取 `request.inputs`；只提供 workspace + prompt |
| Doubao | false | 未实现 | false | CDP message path 当前只有文本 |
| TRAE | false | 未实现 | false | gateway input path 当前只有文本；输出文件能力是另一条链路 |

因此，agy/WorkBuddy 当前 `files:true` 应理解为**声明式输入可注册 + workspace 文件可见**，不能当作
“uAgents 已把附件明确交给 native subagent”。这是下一阶段首先要修正的 capability honesty 问题。

## 推荐功能目标

### Phase A：Universal Attachment contract

先设计最小统一附件模型，保持现有 `type=file + path` 向后兼容。至少需要明确：

- attachment kind：普通文件 / 图片；
- MIME 或可验证媒体类型；
- byte size 上限；
- SHA-256 与 immutable snapshot 证据；
- workspace-relative input 与未来 ingestion input 的关系；
- task control DB 只保存非敏感 metadata，附件 bytes 不进入 SQLite；
- target capability 必须区分“workspace readable”和“native attachment mapped”。

不要在这一阶段顺手加入新的权限沙箱；uAgents 仍是 scheduling/protocol/orchestration layer，下游目标保留原生权限策略。

### Phase B：补实 agy / WorkBuddy file input

对两个 CLI 分别确认其真实原生附件接口：

1. 哪些 CLI flag / stream-json message field 可以显式附带文件；
2. dispatcher-owned 参数与 caller-controlled 参数边界；
3. 文件 identity 是否能从 native event/result 验证；
4. 如果目标没有可靠附件 API，则在实现前收紧 Registry 的 `inputs.files`，不要把 workspace 可读性冒充 native attachment。

验收必须证明 transport 实际消费 `request.inputs`，不能只证明模型在 workspace 里“碰巧能读到文件”。

### Phase C：图片输入

Schema 增加图片类型前先确定：

- 接受的 MIME/格式白名单；
- 文件字节上限；
- 是否限制像素尺寸/解码后尺寸；
- snapshot/hash 仍沿用统一附件链路；
- target 不支持时必须 capability fail-closed；
- 每个 target 单独做 mapping，不自动把图片退化为 prompt 中的路径字符串。

初始 target 建议优先 OpenCode（如果当前 CLI 原生接口可验证支持图片），然后再评估 agy/WorkBuddy；
Doubao/TRAE 必须先确认其真实消息附件协议，不应猜 DOM/gateway 字段。

### Phase D：attachment ingestion

当前要求文件预先存在于 workspace。完整附件体验最终还需要一个 ingestion layer，把调用方提供的文件复制/物化为
task-owned immutable input，再进入统一 snapshot 流程。需要决定是否支持：

- 本机绝对路径；
- 已连接文件引用/file-id；
- 内存/blob 输入；
- URL（默认不建议与第一版一起做，涉及下载、内容类型和网络安全边界）。

## 其他仍未实现的功能

附件之外，当前主要缺口仍有：

1. 真正的 multi-turn/session continuation；durable recovery 目前只恢复观察，不会自动 `--session` / `--continue` 或重发 prompt。
2. provider/native cancel acknowledgement；本地 observer cancel 或 OpenCode process-tree timeout 不冒充远端已取消。
3. 非 Windows OpenCode verified execution timeout，以及其他 target 的 execution timeout。
4. agy / WorkBuddy 的 `execution.native_args` 安全映射。
5. `policy.max_cost_usd` 的真实成本控制。
6. WorkBuddy/Doubao/TRAE 等目标更强的 model identity evidence 与真实消息 E2E。
7. TRAE gateway 版本白名单、状态保留/清理策略和发布工程收尾。

## 不要重新打开的已完成问题

除非新证据证明有 bug，不要因为“更安全”重新堆叠以下机制：

- `possibly_sent` 后禁止 prompt replay；
- PID + start time + executable ownership；
- root death + descendants quiescent 才释放 workspace guard；
- unknown process evidence 保守保持 guard；
- same Attempt 已有 native process row 时禁止 fresh spawn；
- redundant timeout guardians + fenced timeout claim；
- internal control-plane JSON corruption fail-closed；
- host supervisor construction fail-fast；
- centralized path containment / sensitive-field vocabulary。

## 新功能实现原则

- provider-free tests 默认；真实 provider/billable E2E 需要用户明确授权。
- 不自动添加 `--auto`、`--pure` 或其他改变 native permission 行为的参数。
- `mode=analysis|implementation` 是任务意图，不是 uAgents 权限门槛。
- `execution.permission` 只保留 Schema 兼容元数据。
- attachment mapping 必须 target-specific；不能因为两个 CLI 都支持“文件”就共享未经验证的 flags。
- capability 必须诚实：没有 transport mapping 就不要宣称 native attachment 已支持。

## 建议的新对话启动任务

新对话先做**只读设计核对 + 第一阶段实现计划**，然后直接进入实现：

1. 读取本文件、`docs/status/2026-09-06-current-status.md`、统一 protocol reference 和各 target reference。
2. 核对 OpenCode/agy/WorkBuddy 当前原生文件/图片接口；未知或版本相关事实先用本机 CLI help/probe/只读源码证据确认。
3. 设计 Universal Attachment contract，尽量兼容现有 `inputs: [{type:"file", path}]`。
4. 第一实现里程碑优先：
   - 修正 capability honesty；
   - 补实 agy/WorkBuddy file mapping，或明确收紧 unsupported；
   - 为 image input 建 Schema/snapshot 基础，但只对已验证 target 开 `images:true`。
5. 每个 target 必须有 provider-free contract test；真实图片/文件 provider E2E 单独请求授权。

### 可直接粘贴到新对话的开场

> 继续开发 `F:\documents\software\uAgents`。先读取 `docs/status/2026-09-09-next-feature-handoff.md`，以当前仓库源码为准，不以旧安装 cache 为准。下一阶段实现 Universal Attachment Input：先核实并补实 agy/WorkBuddy 的 file input mapping，设计兼容现有 file schema 的统一 attachment contract，再为 image input 建 schema/snapshot/target capability。保持 uAgents 为薄 orchestration 层，不新增权限沙箱，不默认添加 native permission flags；provider-billable E2E 先向我请求明确授权。
