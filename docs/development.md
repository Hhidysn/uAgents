# 开发与验证

需要 Node.js `>=22.13.0`。从仓库根目录运行以下命令。

## 目录

| 路径 | 内容 |
| --- | --- |
| `plugins/uagents/bin/` | CLI、服务与桥接入口 |
| `plugins/uagents/src/` | Core、registry/policy、runtime、host 与 adapters |
| `plugins/uagents/mcp/` | MCP 源码、依赖锁定、构建产物与许可证 |
| `plugins/uagents/skills/agent-dispatch/` | 随插件发布的执行 Skill 与参考 |
| `tests/` | Core、原生进程 fixture 与打包回归 |
| `docs/current/` / `docs/reference/` | 当前设计与使用 / 精确协议 |

## 构建

```powershell
npm --prefix plugins/uagents/mcp/unified ci --ignore-scripts
npm --prefix plugins/uagents/mcp/unified run build
```

构建生成 `server.mjs`、`service.mjs` 和 `bridge.mjs`。这些 bundles 与插件 `src/` 一起分发，安装后运行不依赖 `node_modules`。依赖版本、registry integrity 和许可证分别保存在 package lock 与各 MCP 的 third-party notices 中。

## 按变更验证

| 变更 | 检查 |
| --- | --- |
| Core / adapter | `node --test tests/<相关文件>.test.mjs` |
| 服务策略、调度、Council 并发或路径 | `npm run test:service` |
| 统一 MCP、HTTP 服务或桥接 | `npm --prefix plugins/uagents/mcp/unified test`（包含构建） |
| 插件入口与分发目录 | `node --test tests/plugin-package.test.mjs` |
| 完整仓库回归 | `npm test`（包含服务与各 MCP 测试） |
| 文档或提交内容 | 检查本地链接、示例与实际 discovery，并运行 `git diff --check` |

对 Windows 原生进程生命周期测试，需要串行复核时使用 `node --test --test-concurrency=1 <相关测试文件>`。provider-free fixture 和真实 Provider 调用分别记录；版本 probe 不能替代模型、附件或会话的真实验收。

## 插件核对与文档维护

提交前确认源码、bundles、入口和许可证一起更新。安装验证使用安装命令返回的 version / installedPath，核对实际文件内容；打包测试会检查拷贝后的插件能否在没有 `node_modules` 时加载。

每次验证在 [verification/](verification/README.md) 记录被测提交或工作树、构建身份、命令、结果及未验证行为。文档只随已实现设计更新；旧方案与讨论放到 [history/](history/README.md)，规则见 [文档维护](README.md)。
