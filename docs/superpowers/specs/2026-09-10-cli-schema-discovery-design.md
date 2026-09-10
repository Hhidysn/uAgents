# CLI Schema Discovery 设计

日期：2026-09-10。

## 目标

让本地 Codex 在使用 uAgents CLI 时可以读取 machine-readable 的命令和请求契约，而不是主要依赖
`SKILL.md` / `references/protocol.md` 自然语言去推断参数名。

本功能只做 discovery，不联系 Provider、不启动 Agent、不读取任务数据库。

## 命令面

新增两个只读命令：

```text
uagents describe
uagents describe <command>
uagents schema request
```

`describe` 返回 CLI 自己的命令、positionals、options、互斥约束和 effect 分类。

`schema request` 返回 Draft 2020-12 JSON Schema，描述统一 request：

- 顶层字段和 required 字段；
- `analysis | implementation`；
- attachment `file | image` 与 `path | source`；
- expected outputs；
- execution effort / permission / timeout / native args；
- policy；
- `session.continue_from_task_id`。

CLI discovery 默认且只支持 JSON；它本身就是给程序读取的接口。

## Source of truth

Core parser 仍是最终权威：

```text
src/protocol/schema.mjs
```

本阶段把字段名、枚举和主要限制抽成该模块的导出常量，parser 与 discovery schema 共用这些常量。
`request-json-schema.mjs` 不重新定义 target-native 参数，也不代替 runtime parser。

JSON Schema 对“字节长度”和“Windows/Unix absolute path”等标准 JSON Schema 难以精确表达的规则，使用
`x-uagents-max-bytes` / `x-uagents-path` 扩展标记；真正 admission 仍由 `parseRequest` 执行。

MCP 入口已经通过 `tools/list` 暴露 tool input schema，因此不新增重复的 `uagents_schema` MCP tool。
测试会比较 MCP `uagents_submit` 的主要结构与 Core discovery schema，防止明显漂移。

## Codex 使用方式

Skill 只需要告诉调用方：

1. CLI syntax 不确定时先读 `describe` / `describe <command>`；
2. 构造 submit request 时读 `schema request`；
3. `protocol.md` 和 target reference 负责语义、能力边界和行为说明；
4. 不直接学习或拼接 WorkBuddy/OpenCode/agy 的原生 CLI 参数，那仍由 transport mapping 负责。

## 非目标

- 不把 target-native CLI flags 暴露为公共协议。
- 不自动生成 prompt。
- 不增加 Provider/model 探测。
- 不把 JSON Schema 编译成新的运行时 validator；Core parser 仍是 admission authority。
- 不新增权限、sandbox 或 fallback 行为。
