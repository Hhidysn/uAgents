# Model Discovery Cache / agy Native Catalog 验证

日期：2026-09-19。

本轮目标是把 model discovery 与 admission policy 分开：native catalog 可以自动发现，但发现本身不能扩大准入。

## agy 实机 no-prompt discovery

本机 agy：

```text
agy 1.2.5
```

原生：

```text
agy models
```

可返回 Gemini、Claude、GPT-OSS 等 catalog 项。uAgents 现在使用同一个 no-prompt native 命令：

本机刷新期间还复现了一个实际时序问题：原生 `agy models` 一次完成耗时约 9.4 秒，旧通用
10 秒 discovery budget 曾导致 `ETIMEDOUT` 并正确回退旧 snapshot。为避免常态刷新卡在边界，
现将 agy native catalog 的等待上限单独调整为 30 秒；WorkBuddy/OpenCode 保持 10 秒。
调整后重新刷新返回 14 条 fresh native models，再次跨 CLI 进程调用约半秒，返回 `source=cache`。

```text
node plugins/uagents/bin/uagents.mjs models agy --refresh
```

首次结果的 configured route：

```text
model               gemini-3.8-flash-medium
configured          true
admission_allowed   true
discovered          true
usable              true
discovery.source    native
```

其它 discovered `gemini-*` 通过现有 pattern admission 得到 `admission_allowed=true`；例如
`claude-sonnet-4-6` / `gpt-oss-120b-medium` 会显示为 discovered，但保持
`admission_allowed=false`。

紧接着再次运行：

```text
node plugins/uagents/bin/uagents.mjs models agy
```

相同 snapshot 返回：

```text
discovery.source  cache
discovery.stale   false
```

证明跨 CLI 进程复用了 per-user HostStore model catalog cache。

## 其它 target

WorkBuddy 和 OpenCode 同样验证了：

```text
models <target> --refresh  -> discovery.source=native
models <target>            -> discovery.source=cache
```

DSH、Doubao、TRAE 没有可靠 native model catalog，因此只返回 configured route，且：

```text
discovered        null
usable            null
discovery.source  configured
```

不会再为 backend-default route 生成重复的 discovered-only row。

## Cache contract

- TTL：10 分钟；
- cache key 包含 target、verified native executable fingerprint 和 discovery scope；
- executable identity 改变后不会复用旧 catalog；
- `--refresh` / MCP `refresh=true` 绕过 catalog cache；
- 同一 identity 的 refresh 失败时可回退到 stale snapshot，并记录 `discovery.refresh_error`；
- stale snapshot 的 `usable=null`；
- cache 只保存 native evidence，admission 每次读取都由当前 policy 重新计算；
- submit path 不读取 model discovery cache；
- HostStore 用 refresh start time 防止较旧并发刷新覆盖较新的 snapshot。

## 测试

```text
Core          335/335 (node --test --test-concurrency=4)
Core          333/334 (standard npm test under parallel load, before final agy budget test)
OpenCode durable isolated 4/4 PASS
Doubao MCP     11/11
TRAE MCP        9/9
Unified MCP    14/14
```

标准 Core 两次运行均只在既有 OpenCode durable recovery 的 10 秒 wall-clock fixture 超时；
该 fixture 在独立运行时 4/4 通过。在新增 agy 专属 30 秒 discovery budget 测试后，
以 `--test-concurrency=4` 运行 Core 全量 335/335 通过；未修改 OpenCode runtime。
该记录不将两次标准高并发门禁称为全绿。

## 最终本机 Codex 安装版

```text
0.2.0-alpha.1+codex.20260919124231
```

通过 `codex plugin add uagents@personal --json` 正常安装。最终 cache 的
`models agy` 返回 14 条模型，其中 1 条 configured concrete route、11 条准入允许；
`discovery.source=cache`、`discovery.stale=false`。repo/personal source/installed cache 的
139 个 tracked plugin 文件逐个 SHA-256 一致，mismatch=0。

本轮验证没有执行 provider-bearing Agent prompt；Git 发布记录以仓库提交历史为准。

专项覆盖包括 agy parser、pattern admission、configured-only 去重、TTL、显式 refresh、stale fallback、
verified executable identity change、current-policy recomputation、HostStore persistence/ordered write 和 MCP refresh forwarding。

本轮 model discovery 实机验证没有提交 Agent prompt。
