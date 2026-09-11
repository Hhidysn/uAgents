# Council Worktree Isolation 实机 implementation E2E

日期：2026-09-11

## 目标

验证 `mode=implementation + workspace_strategy=git-worktree` 在真实 WorkBuddy / OpenCode 调用中能够：

- 从同一个 committed source HEAD 创建两个独立 member worktree；
- 让两个普通 uAgents Task 在各自 worktree 内实际写文件；
- 保持 source repo 不变；
- 保持两个 member 的未提交修改互不可见；
- 由 `council-result` 聚合真实 response、usage 和 Git evidence；
- 不自动 commit / merge / reset / cleanup。

## Source workspace

临时 Git repo：

```text
.local/e2e/real-council-worktree-20260911/source-repo
```

基准提交：

```text
31e9907171ad24a03ddc7489fe53cb68d29cf9ad
```

Council：

```text
8ce9f171-f3c6-4a87-9fc4-18c80614381f
mode=implementation
workspace_strategy=git-worktree
permission=native
```

第一次 DevSpace bridge 调用 `council-submit` 没有得到执行结果；随后先执行只读 `council-status`，Core 明确返回 `task_not_found` / `submission=not_sent`，确认没有注册或 provider send 后，才安全地用同一个 Council UUID 重试。

## WorkBuddy member

```text
member_id: workbuddy-implementation
task_id: f05b364a-dd0f-8a5c-9214-017ab2cc1d97
status: succeeded
native session: f05b364a-dd0f-8a5c-9214-017ab2cc1d97
response: DONE WB-WT-33146F15
```

Git evidence：

```text
branch: uagents/council/8ce9f171-f3c6-4a87-9fc4-18c80614381f/f05b364a-dd0f-8a5c-9214-017ab2cc1d97
base HEAD: 31e9907171ad24a03ddc7489fe53cb68d29cf9ad
current HEAD: 31e9907171ad24a03ddc7489fe53cb68d29cf9ad
dirty: true
changes: ?? workbuddy-result.txt
```

文件内容：

```text
WB-WT-33146F15
```

Usage：

```text
input_tokens: 50510
output_tokens: 129
```

## OpenCode member

```text
member_id: opencode-implementation
task_id: ab47c53a-5c1e-8507-b8aa-510070dafbe7
status: succeeded
native session: ses_f735d38f5ffeUpQTTJTgNAlOim
response: DONE OC-WT-1B7E4A31
```

Git evidence：

```text
branch: uagents/council/8ce9f171-f3c6-4a87-9fc4-18c80614381f/ab47c53a-5c1e-8507-b8aa-510070dafbe7
base HEAD: 31e9907171ad24a03ddc7489fe53cb68d29cf9ad
current HEAD: 31e9907171ad24a03ddc7489fe53cb68d29cf9ad
dirty: true
changes: ?? opencode-result.txt
```

文件内容：

```text
OC-WT-1B7E4A31
```

Usage：

```text
total: 24165
input: 215
output: 14
cache_read: 23936
```

## Isolation 验收

最终检查：

```text
WorkBuddy worktree 中不存在 opencode-result.txt
OpenCode worktree 中不存在 workbuddy-result.txt
source repo 中不存在 workbuddy-result.txt
source repo 中不存在 opencode-result.txt
source repo git status --short 为空
```

`git worktree list --porcelain` 同时列出 source repo 和两个独立 member worktree，三者 HEAD 都为同一个基准提交，两个 member 分别位于自己的 deterministic Council branch。

本次状态采样观察到 WorkBuddy 已 `succeeded` 时 OpenCode 为 `running/submission=sent`。这证明 OpenCode 没有像此前 shared-workspace 实机 E2E 那样停在 `queued/submission=not_sent` 等待同一路径 lease；但该单次采样不足以声称两家 provider 的远端计算严格时间重叠，因此这里只确认独立 worktree 写入和调度不再共享同一个 workspace lease。

## 结论

真实 implementation Council 通过。共发生两次真实 provider prompt：WorkBuddy 一次、OpenCode 一次。没有额外 synthesis/provider call，没有自动 commit/merge，也没有修改 source repo 或 uAgents 主工作区。
