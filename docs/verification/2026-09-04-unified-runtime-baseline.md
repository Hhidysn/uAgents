# 统一 Runtime 实施基线

日期：2026-09-04

## 环境

- Windows x64
- Node `v24.13.0`
- 根测试命令：`npm test`

## 实施前测试

`npm test` 退出码为 0：

- 根测试：52/52 通过
- 豆包 MCP：9/9 通过
- TRAE MCP：9/9 通过
- 合计：70/70 通过

## 实施前已有工作区修改

以下路径在统一 Runtime 实施前已经由用户修改或新增，不属于本次 Gate 0 基线提交，实施不得重置或覆盖：

```text
.gitignore
README.md
docs/history/status/2026-09-02-current-progress.md
plugins/uagents/.codex-plugin/plugin.json
plugins/uagents/mcp/doubao/dist/server.mjs
plugins/uagents/mcp/doubao/src/store.mjs
plugins/uagents/mcp/doubao/test/server-smoke.test.mjs
plugins/uagents/mcp/trae/dist/server.mjs
plugins/uagents/mcp/trae/src/store.mjs
plugins/uagents/mcp/trae/test/server-smoke.test.mjs
scripts/verify-installed-plugin.mjs
docs/verification/2026-09-03-cli-candidate-contracts.md
```

`npm test` 会重新构建两个桌面 MCP 的 `dist/server.mjs`；这些文件在基线前已经是修改状态，所以后续差异必须按用户现有内容合并，不能简单还原。
