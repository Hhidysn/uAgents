# Validation Profiles 设计

日期：2026-09-12。

## 目标

把已经存在的 Council multi-step validation 从“每次传一份 JSON”提升为“项目可以提交并复用一套命名质量标准”。Profile 只负责复用现有 validation contract，不新增第二套执行引擎、测试发现器或 winner 评分器。

## 项目配置

固定位置：

```text
<Council source workspace>/.uagents/validation-profiles.json
```

示例：

```json
{
  "schema_version": "1.0",
  "profiles": {
    "fast": {
      "checks": [
        { "name": "lint", "command": ["npm.cmd", "run", "lint"] },
        { "name": "typecheck", "command": ["npm.cmd", "run", "typecheck"] }
      ]
    },
    "pre-adopt": {
      "on_failure": "continue",
      "checks": [
        { "name": "lint", "command": ["npm.cmd", "run", "lint"] },
        { "name": "test", "command": ["npm.cmd", "test"], "timeout_ms": 300000 },
        { "name": "build", "command": ["npm.cmd", "run", "build"] }
      ]
    }
  }
}
```

文件级 `schema_version` 只写一次；每个 profile body 直接复用现有 `council-validation` 的 `command` 或 `checks`、`timeout_ms`、`on_failure`。最多 32 个 profiles；profile 名只允许字母、数字、`.`、`_`、`-`，并以字母或数字开头。

## 调用

继续支持显式 validation JSON：

```text
council-validate <id> --all --validation validation.json
```

新增：

```text
council-validate <id> --all --profile pre-adopt
```

`--validation` 与 `--profile` 严格二选一。Unified MCP 的 `uagents_council_validate` 同样在 `validation` 与 `profile` 中二选一。

机器可读 contract：

```text
schema council-validation
schema council-validation-profiles
describe council-validate
```

## Source authority

Profile 总是从 Council **原始 source workspace** 读取，而不是从任何 candidate worktree 读取。这样所有候选使用相同的项目质量标准；candidate 即使修改自己 worktree 中的 `.uagents/validation-profiles.json`，也不会改变本次比较规则。

Profile 展开后仍调用现有 Council validation runtime。持久化 evidence 继续包含完整展开后的 command/checks，并额外记录：

```json
{"profile":{"name":"pre-adopt","file":".uagents/validation-profiles.json"}}
```

因此历史 evidence 不依赖之后的 profile 文件内容才能解释。

## 明确不做

- 不提供内置 `fast` / `full` 等默认 profile；
- 不自动探测 npm/pnpm/pytest/cargo/go；
- 不自动生成 validation commands；
- 不做 profile inheritance / include / composition；
- 不允许每个 candidate 自己选择不同 profile 定义；
- 不新增 shell execution、provider 调用、winner selection、adopt 或 merge 自动化。
