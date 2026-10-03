# 当前 Council 能力

Council 是普通 uAgents Task 之上的 fan-out / fan-in orchestration。每个 member 仍使用现有 Task、Attempt、Worker、native session、result 和 artifact 管线。

当前生命周期：

```text
council-submit
  -> council-status / council-result
  -> council-diff
  -> council-validate
  -> council-adopt
  -> council-cleanup
```

## Analysis Council

默认组合是：

```text
mode=analysis
workspace_strategy=shared
```

适合让多个 Agent 独立分析同一 workspace。

## Implementation Council

并行实现使用：

```text
mode=implementation
workspace_strategy=git-worktree
```

每个 member 从 source committed `HEAD` 获得独立 branch/worktree。source workspace 的 dirty tracked/untracked 内容不会自动复制到 candidate。

## Compare

`council-diff` 只读本地 candidate，返回 response、usage、artifacts、tracked diff 和 untracked metadata。未跟踪内容只读取 worktree 内的普通文件；外部链接、多硬链接和超限文件只返回描述，不读取外部内容。

## Validate

`council-validate` 可以对单个 member 或全部 candidate 执行显式 argv validation，不经过 shell。

支持：

- 单步 `{command, timeout_ms}`；
- 多步 named `checks[]`；
- `on_failure=continue|stop`；
- source workspace 中的 `.uagents/validation-profiles.json` 命名 profile。

Validation 只记录 evidence，不自动选择 winner。

## Adopt

`council-adopt` 只采纳用户明确指定的 succeeded member。destination 必须仍处于 Council 的 base HEAD；操作不会自动 commit、merge、cherry-pick 或切 branch。

## Cleanup

`council-cleanup` 显式移除 member worktree 和 dedicated branch。默认只允许清理 clean 且没有独立 commit 的 candidate；其它情况需要 `--force`。

Council manifest、Task、result 和 validation evidence 会保留。

## 并发与范围

submit、validate、adopt 和 cleanup 使用同一 Council 的共享租约与 fencing。验证预留所有所选成员和命令的超时预算；写入证据或执行受控修改前核对所有权。崩溃后的租约在到期前仍会阻止新修改；服务不自动重跑 validation。

adopt 在应用 patch 前预检查未跟踪文件冲突，检查源文件与目标父目录的真实范围，并以独占方式复制未跟踪文件。操作仍要求明确选择成功候选及目的 workspace。

通过 HTTP 服务调用时，源 workspace、成员 target 和实际 Git repository root 都受配置范围约束；派生 worktree 通过原 Council 授权。见 [服务范围](service.md#运行与恢复边界)。

## 明确不做

- 自动投票或 winner selection
- 自动 synthesis
- 自动 commit / merge / cherry-pick
- 后台 cleanup / GC

精确命令见 [CLI Reference](../reference/cli.md)。
