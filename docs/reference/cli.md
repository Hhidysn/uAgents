# CLI Reference

插件根目录中的统一入口：

```text
node <plugin-root>/bin/uagents.mjs <command>
```

## Discovery

```text
targets
capabilities <target>
models <target>
describe
describe <command>
schema request
schema council
schema council-validation
schema council-validation-profiles
```

这些命令不创建 Provider task。

## Task

```text
submit (--request <file> | --request-stdin)
status <task-id>
result <task-id>
cancel <task-id>
list
reconcile <task-id>
resume <task-id>
```

`submit` 的 `--request` 和 `--request-stdin` 严格二选一。

## Host lifecycle

```text
ensure <target> [--refresh]
probe <target>
stop <target>
```

## Council

```text
council-submit (--request <file> | --request-stdin)
council-status <council-id>
council-result <council-id>
council-diff <council-id>
council-validate <council-id> (--member <member-id> | --all) (--validation <file> | --profile <name>)
council-adopt <council-id> --member <member-id> --workspace <absolute-dir>
council-cleanup <council-id> (--member <member-id> | --all) [--force]
```

精确参数、exclusive groups 和 machine-readable description 始终以 `describe <command>` 为准。
