# 当前实现

本目录只描述当前仓库已经实现的行为，不记录功能演进过程、被否决方案或旧测试结果。

当前产品可以概括为：

```text
request
  -> target/model policy
  -> Task / Attempt
  -> native Agent
  -> status / result / artifacts

optional:
  attachments
  session continuation / fork
  Council fan-out / validation / adopt
  managed local Agent lifecycle
```

当前详细入口：

- [Agent 与能力矩阵](agents.md)
- [附件](attachments.md)
- [会话 continuation / fork](sessions.md)
- [Council](council.md)
- [模型与路由](models.md)
- [Runtime 与生命周期](runtime.md)

精确 schema、命令和 capability 字段定义见 [Reference](../reference/README.md)。测试和真实 Provider 证据见 [Verification](../verification/)。
