# Council Candidate Validation / Test Evidence 设计

日期：2026-09-12。

> 本文记录最初 single-command validation 阶段。当前源码已在保持该 contract 兼容的基础上增加有序 named checks；见 [Multi-step Candidate Validation 设计](2026-09-12-multi-step-candidate-validation-design.md)。

## 目标

让 git-worktree Council 的候选在各自 effective workspace 中运行用户明确指定的本地验证命令，并把可比较的测试证据持久化到 Council member。该能力不调用 Agent/provider，不自动选择 winner，也不修改候选代码。

## 接口

CLI：

```text
schema council-validation
council-validate <council-id> (--member <member-id> | --all) --validation <file>
```

MCP：`uagents_council_validate`。

validation JSON：

```json
{
  "schema_version": "1.0",
  "command": ["npm.cmd", "test"],
  "timeout_ms": 120000
}
```

`command` 是直接 argv，不经过 shell。第一项作为 executable，其余参数原样传入。第一版不提供 shell command string、自定义 env、并行 validation 或自动 test discovery。

## 执行与证据

- 仅 `workspace_strategy:"git-worktree"` Council；
- selected member Task 必须 terminal；
- cleaned worktree 不可再验证；
- `--all` 先整体做静态 preflight，再顺序执行每个 member；
- cwd 使用 member 的 effective worktree workspace；
- 默认 timeout 120 秒，可显式设为 100 ms–1 小时；
- stdout/stderr 各最多内联 64 KiB，同时记录 captured bytes 与 truncated；
- 非零 exit code 记为 `outcome:"failed"`，不是 API error；
- timeout 记为 `outcome:"timeout"`；无法启动/本地执行错误记为 `outcome:"error"`；
- exit 0 记为 `outcome:"passed"`。

member manifest 只保存 latest validation evidence：command、timeout、started/finished/duration、outcome、exit code、signal、error code、stdout/stderr。`council-status` / `council-result` / `council-diff` 都能读取该 evidence。

## 明确不做

- 不运行 shell；
- 不自动挑选 npm/pytest/cargo/go 命令；
- 不自动依据 pass/fail 选择 candidate；
- 不自动 adopt/commit/merge；
- 不发送新的模型请求。
