# 开发与验证

需要 Node.js `>=22.14.0`。从仓库根目录运行以下命令。

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

构建生成 `server.mjs`、`service.mjs` 和 `bridge.mjs`。这些 bundles 与 `src/` 一起分发，安装后运行不依赖 `node_modules`。依赖版本、registry integrity 和许可证分别保存在 package lock 与各 MCP 的 third-party notices 中。

打包前还要构建两个桌面目标的 bundle（分发测试与 `npm pack` 都要求它们存在）：

```powershell
npm --prefix plugins/uagents/mcp/doubao ci --ignore-scripts
npm --prefix plugins/uagents/mcp/doubao run build
npm --prefix plugins/uagents/mcp/trae ci --ignore-scripts
npm --prefix plugins/uagents/mcp/trae run build
```

## 按变更验证

| 变更 | 检查 |
| --- | --- |
| Core / adapter | `node --test tests/<相关文件>.test.mjs` |
| 服务策略、调度、Council 并发或路径 | `npm run test:service` |
| 登录态读取、签到或计划任务 | `npm run test:checkin`，必要时验证真实 Windows 任务 |
| 统一 MCP、HTTP 服务或桥接 | `npm --prefix plugins/uagents/mcp/unified test`（包含构建） |
| 包入口与分发目录 | `node --test tests/package-distribution.test.mjs` |
| npm 包实际内容 | `npm run test:pack`（核对 `npm pack --dry-run` 的结果，而不是只看 `files` 白名单） |
| 完整仓库回归 | `npm test`（包含签到、服务与各 MCP 测试） |
| 文档或提交内容 | 检查本地链接、示例与实际 discovery，并运行 `git diff --check` |

对 Windows 原生进程生命周期测试，需要串行复核时使用 `node --test --test-concurrency=1 <相关测试文件>`。provider-free fixture 和真实 Provider 调用分别记录；版本 probe 不能替代模型、附件或会话的真实验收。

## 包核对与文档维护

提交前确认源码、bundles、入口和许可证一起更新。安装验证使用 `npm pack` 产物与已安装的包根目录，核对实际文件内容；`node scripts/verify-installed-package.mjs <package-root> <state-root>` 检查 skill、CLI 入口、状态目录创建与统一 MCP 工具列表；分发测试会检查只含核心的副本在没有 `node_modules` 时仍能服务其余目标，并明确报告缺失的桌面组件。CI 在 Windows 上执行 `npm test` 与 `npm run test:pack`。

每次验证在 [verification/](verification/README.md) 记录被测提交或工作树、构建身份、命令、结果及未验证行为。文档只随已实现设计更新；旧方案与讨论放到 [history/](history/README.md)，规则见 [文档维护](README.md)。
