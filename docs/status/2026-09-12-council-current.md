# Council 当前状态

日期：2026-09-12。本文是 Council 当前能力的权威状态入口；早期按功能拆分的 Council status 文档保留为历史阶段快照。

## 当前闭环

```text
council-submit
  -> council-status / council-result
  -> council-diff
  -> council-validate
  -> council-adopt
  -> council-cleanup
```

Council 仍是普通 uAgents Task 之上的薄 orchestration：每个 member 都走现有 Task / Attempt / Worker / native session / result / artifact 管线，不存在第二套执行引擎。

CLI：

```text
schema council
council-submit (--request <file> | --request-stdin)
council-status <council-id>
council-result <council-id>
council-diff <council-id>
council-validate <council-id> (--member <member-id> | --all) --validation <file>
council-adopt <council-id> --member <member-id> --workspace <absolute-dir>
council-cleanup <council-id> (--member <member-id> | --all) [--force]
```

Unified MCP 使用同名 `uagents_council_*` tools。

## Execution model

- 默认：`mode:"analysis"` + `workspace_strategy:"shared"`，permission 默认 `advisory-read-only`。
- 并行改代码：`mode:"implementation"` + `workspace_strategy:"git-worktree"`，permission 默认 `native`。
- implementation Council 必须显式给 Git workspace。
- 每个 member 从 source committed `HEAD` 创建独立 branch/worktree；source workspace 的 dirty tracked/untracked 内容不会隐式复制。
- `council_id + member_id` 确定性派生成员 Task UUID，完全相同 Council 重提复用原 Task/worktree。
- `fanout` 表示不等待前一个 member 完成才注册后一个；global / target concurrency limit 仍生效。

## Compare / validate / adopt

`council-diff` 是纯本地只读比较：返回 response/usage/artifacts、tracked file status/unified patch、untracked 文件 metadata，以及小型 UTF-8 新文件正文。

`council-validate` 在 selected candidate 的 effective worktree workspace 中执行显式 argv validation，不经过 shell。非零退出码是 `failed` evidence，不是 API error；timeout 与启动错误也会结构化记录。latest validation 包含 command、duration、exit/signal、outcome 与有界 stdout/stderr，并会出现在 status/result/diff 中。第一版 `--all` 顺序运行，不自动 test discovery 或 winner selection。

`council-adopt` 只接受明确指定的 `succeeded` member。它把候选相对 Council `base_head` 的 binary tracked patch 与 Git-visible untracked 普通文件应用到显式 destination workspace。destination `HEAD` 必须仍等于 `base_head`；操作不会 switch branch、commit、merge、cherry-pick 或选择 winner。

## Cleanup

`council-cleanup` 是显式生命周期操作，只删除选中的 member worktree 和其 `uagents/council/...` dedicated branch；Council manifest、Task、result 与 verification evidence 保留。

默认只清理 `HEAD == base_head` 且 worktree clean 的候选。dirty 或有独立 commits 的候选必须显式 `--force`。`--all` 会先整体 preflight，任何一个 member 不满足条件时不会先删除其他 member。非终态 Task 不允许 cleanup。

清理后的 `council-status` / `council-result` 仍可读历史，并带 persisted cleanup evidence；`council-diff` 会标记 worktree 已移除，`council-adopt` 不再能从已清理候选采纳内容。

## 明确不做

- 不自动投票或选择 winner；
- 不自动 synthesis；
- 不自动 commit / merge / cherry-pick；
- 不后台 cleanup / GC；
- 不绕过原有 workspace / target / global concurrency 规则。

## Provider 边界

`council-submit` 可能发送 provider-billable prompt；`status`、`result`、`diff`、`validate`、`adopt`、`cleanup` 都是本地操作，不调用模型。

真实 provider 证据见：

- [First-class Council 实机 E2E](../verification/2026-09-11-real-first-class-council-e2e.md)
- [Implementation Worktree 实机 E2E](../verification/2026-09-11-real-council-worktree-implementation-e2e.md)

provider-free diff/validation/adopt/cleanup 证据分别保存在对应 verification 文档。

## Source of truth

调用方不要从本文猜参数；使用：

```text
uagents describe <command>
uagents schema council
uagents schema council-validation
MCP tools/list
```

Core parser/runtime 仍是最终 admission 与行为权威。

## 当前验证

```text
Council + CLI targeted   31/31
Unified MCP targeted      8/8

Core                    302/302
Doubao MCP               11/11
TRAE MCP                  9/9
Unified MCP               8/8
Total                   330/330
```

Candidate Validation 的 fixture、真实既有 candidate validation、文档收口与 Cleanup 验证均为 provider-free；没有发送新的 Agent prompt。
