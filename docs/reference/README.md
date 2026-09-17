# Reference

Reference 只定义当前 contract，不记录设计讨论或测试过程。

- [CLI](cli.md)
- [MCP](mcp.md)
- [Request / Task Protocol](protocol.md)
- [Capability 语义](capabilities.md)

机器可读 discovery 优先于手写文档：

```text
uagents describe
uagents describe <command>
uagents schema request
uagents schema council
uagents schema council-validation
uagents schema council-validation-profiles
uagents capabilities <target>
uagents models <target>
```

手写 Reference 用于解释这些 contract 的语义和入口，不替代 Core parser/runtime。
