# Council Candidate Validation / Test Evidence 验证

日期：2026-09-12。

## Provider-free fixture

自动化 Git fixture 使用同一个 validation argv 在两个 candidate worktree 中执行：一个候选有 `marker.txt`，另一个没有。验证结果分别持久化为 `passed / exit_code=0` 与 `failed / exit_code=7`，并能从 Council status/diff 读取。另有 timeout fixture 验证 `outcome:"timeout"`，以及 70,000 字节 stdout fixture 验证正文被限制为 65,536 字节而 command outcome 仍保持 passed。

cleaned candidate 会在执行前返回 `request_conflict`，不会运行 validation command。

## 真实 candidate 零-provider 验证

复用 2026-09-11 真实 WorkBuddy + OpenCode implementation Council：

```text
council_id = 8ce9f171-f3c6-4a87-9fc4-18c80614381f
```

对两个真实 Agent worktree 执行同一条本地 Node validation：要求当前目录恰好存在一个 `*-result.txt` 并输出其文件名。最终 evidence：

```text
workbuddy-implementation  passed / 0 / workbuddy-result.txt
opencode-implementation   passed / 0 / opencode-result.txt
```

该验证只运行本地 Node 进程，没有发送新的 WorkBuddy/OpenCode/provider prompt。

## 当前边界

validation 直接执行 argv，不使用 shell；Windows 下 npm 等脚本入口应显式给可执行入口（例如 `npm.cmd`）。第一版顺序执行 selected members，只保留 latest validation evidence。

## 最终门禁

```text
Council + CLI targeted   31/31
Unified MCP targeted      8/8

Core                    302/302
Doubao MCP               11/11
TRAE MCP                  9/9
Unified MCP               8/8
Total                   330/330
```
