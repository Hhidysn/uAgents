# Validation Profiles provider-free 验证

日期：2026-09-12。

## 已验证行为

- profile file parser 复用现有 Council validation contract；
- profile body 不重复 `schema_version`；
- profile name 与 profile 数量受 schema 约束；
- `schema council-validation-profiles` 暴露固定项目路径与 machine-readable contract；
- CLI `council-validate` 要求 `--validation` / `--profile` 二选一；
- MCP `uagents_council_validate` 要求 `validation` / `profile` 二选一；
- profile 从 Council source workspace 加载；
- candidate worktree 修改自己的 profile 文件不会改变 source profile；
- 展开后的 named checks 继续进入原 validation runtime；
- persisted status/result/diff evidence 带 profile name/file，同时保留完整展开后的 validation evidence；
- unknown profile 与缺失 profile file 返回本地结构化错误；
- 全过程不调用 Agent/provider。

## Targeted

```text
Council + CLI   36/36
Unified MCP      10/10
```

## 真实既有 candidate profile 验证

复用已存在的真实 implementation Council：

```text
8ce9f171-f3c6-4a87-9fc4-18c80614381f
```

在它的 source workspace 临时放置 `candidate-smoke` profile，通过 CLI：

```text
council-validate <id> --all --profile candidate-smoke
```

WorkBuddy 与 OpenCode 两个真实 candidate 都得到：

```text
result-file          PASS
candidate-isolation  PASS
overall              PASS
```

随后 `council-diff` 能直接读到 persisted `profile.name="candidate-smoke"`、profile file path 与展开后的 checks。验证完成后临时 source profile 文件已删除；Council evidence 仍保留。整个过程没有新的 Agent/provider 调用。

## 完整门禁

```text
Core                    312/312
Doubao MCP               11/11
TRAE MCP                  9/9
Unified MCP              10/10
Total                   342/342
```

```text
Skill validator    PASS
Plugin validator   PASS
git diff --check   PASS
```
