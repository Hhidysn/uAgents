# Explicit Candidate Adopt 验证

日期：2026-09-11。

## Provider-free fixture

自动化 fixture 创建一个 base Git repo 和 implementation Council，然后让 selected candidate 修改 tracked `base.txt` 并新建 untracked `nested/new.txt`。

`council-adopt` 将这两个变化应用到显式 destination workspace，并验证：

- tracked 内容正确改变；
- untracked 文件正确复制；
- destination `HEAD` 仍等于 base HEAD；
- destination branch 不变；
- candidate worktree 不被修改；
- 第二次重复 adopt 返回 `request_conflict`。

另一个 fixture 在 destination 预先创建与 candidate 同名 untracked 文件，验证 adopt 在应用 tracked patch 前即返回 `request_conflict`，destination tracked 文件保持原值。

## CLI / MCP

CLI discovery 暴露 `council-adopt <council-id> --member <member-id> --workspace <dir> [--state-dir <dir>]`，effect 为 `local_state_change`。

Unified MCP `tools/list` 暴露 `uagents_council_adopt`。shared Council 经 CLI/MCP 调用均明确返回 `unsupported_capability`。

## Provider

本功能验证不发送任何 provider prompt。

## 真实 candidate 的零-provider adopt

复用了此前真实 WorkBuddy + OpenCode implementation Council 的持久 worktree：

```text
council_id = 8ce9f171-f3c6-4a87-9fc4-18c80614381f
member_id  = workbuddy-implementation
base_head  = 31e9907171ad24a03ddc7489fe53cb68d29cf9ad
```

从同一 source repo/base commit 创建新的 detached destination，然后执行 `council-adopt`。结果：

```text
applied.tracked_patch_bytes = 0
applied.untracked_files      = workbuddy-result.txt (15 bytes)
destination HEAD             = 31e9907171ad24a03ddc7489fe53cb68d29cf9ad
destination status           = ?? workbuddy-result.txt
file content                 = WB-WT-33146F15
opencode-result.txt           = absent
```

因此这次验证直接证明 adopt 可以处理真实 Agent 留下的 untracked candidate 文件，并且不会把另一个 Council member 的文件带入 destination。新增 provider 调用为 0。

## 最终门禁

```text
Council + CLI targeted   24/24
Unified MCP targeted      7/7

Core                    295/295
Doubao MCP               11/11
TRAE MCP                  9/9
Unified MCP               7/7
Total                   322/322
```

全量回归第一次在既有 `OpenCode recovery discovers a delayed session` 上遇到一次 10 秒墙钟超时；该 durable 文件隔离重跑 `4/4`，随后完整 `npm test` 重跑全绿。Adopt/runtime 代码没有为该时序测试做特殊修改。
