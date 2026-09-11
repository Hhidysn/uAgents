# Council Candidate Comparison 验证

日期：2026-09-11。

## Provider-free 自动化验证

- implementation Council 的一个 member 修改 tracked `base.txt`，`council-diff` 返回 `tracked_files` 和 unified `tracked_patch`；
- 另一个 member 新增 untracked `new.txt`，返回 path / bytes / UTF-8 text；
- shared Council 调用 `council-diff` 返回 `unsupported_capability`；
- CLI discovery 暴露 `council-diff` 且 effect 为 `local_only`；
- Unified MCP 工具列表暴露 `uagents_council_diff`；
- MCP/CLI 均不需要 native Agent 或 provider。

## 真实 worktree 复用验证

复用已明确授权并完成的 implementation Council：

```text
council_id = 8ce9f171-f3c6-4a87-9fc4-18c80614381f
```

执行：

```text
node plugins/uagents/bin/uagents.mjs council-diff 8ce9f171-f3c6-4a87-9fc4-18c80614381f --state-dir <existing-e2e-state>
```

得到：

```text
workbuddy-result.txt  bytes=15  text="WB-WT-33146F15\n"
opencode-result.txt   bytes=14  text="OC-WT-1B7E4A31"
```

两个 member Task 都保持 `succeeded`，HEAD/base HEAD 未改变。本验证只读取本地状态和 Git worktree，**没有新的 provider prompt**。

## 测试结果

```text
Council + CLI targeted   22/22
Unified MCP targeted      7/7

Core                    293/293
Doubao MCP               11/11
TRAE MCP                  9/9
Unified MCP               7/7
Total                   320/320
```
