# Dynamic Model Discovery 验证

日期：2026-09-12。

## Provider-free 本机证据

OpenCode help：

```text
opencode models [provider]
--pure
--refresh  refresh the models cache from models.dev
```

实际执行时未传 `--refresh`：

```text
opencode models commandcode-goat --pure
```

当前返回 4 条 route，其中静态 allowlist 2 条、discovered-only 2 条。

WorkBuddy：

```text
node <installed-codebuddy.js> --help
```

本机 help 的 `--model` 项返回 `auto` 加 14 个 concrete model labels。

两类命令均没有发送任务 prompt。

## 自动化覆盖

- WorkBuddy help parser；
- OpenCode provider catalog parser；
- configured + discovered route 合并；
- discovered-only route 不获得 admission；
- configured route 未出现在 catalog 时 `discovered=false / usable=false`；
- discovery 失败时 configured rows 保留且 `usable=null`；
- CLI `models` discovery contract；
- Unified MCP `uagents_list_models` parity。

## 证据边界

`discovered=true` 只证明本机 native CLI metadata/catalog 能看到该模型。它不证明：

- provider credentials 有效；
- 当前 quota 足够；
- provider 在线；
- 一次真实 prompt 一定能成功。

因此所有 rows 继续返回 `provider_availability:"unconfirmed"`。

## 测试结果

```text
Model Discovery + CLI targeted   20/20
Unified MCP targeted             10/10

Core                            308/308
Doubao MCP                       11/11
TRAE MCP                          9/9
Unified MCP                      10/10
Total                           338/338
```
