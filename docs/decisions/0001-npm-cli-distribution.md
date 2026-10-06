# uAgents 以 npm 包分发，下线 Codex 插件形态

Date: 2026-10-06
Status: Accepted

## Context

uAgents 之前只以 Codex 插件形态分发：`.codex-plugin/plugin.json` 声明技能与 MCP，宿主通过市场安装，入口写作 `node "<plugin-root>/bin/uagents.mjs"`。这带来两个问题：

- 其它宿主（opencode、pi）也能执行命令，但没有稳定入口，必须自己推导一个随安装变化的插件路径。
- 插件形态把"Codex 的自动装配"和"uAgents 的能力"绑在一起，而 uAgents 的能力本身与宿主无关。

用户决定：把 uAgents 改成能独立安装的命令行包，命令名为 `uagents`，下线 Codex 插件形态，保留全部现有能力。

## Decision

包根目录是 `plugins/uagents`，`package.json` 声明 `bin.uagents`、`bin.uagents-service`、`bin.uagents-mcp-bridge`、`bin.uagents-checkin`，`license: MIT`，`engines.node: >=22.14.0`，并用显式 `files` 白名单决定发布内容。`.codex-plugin/` 与 `.mcp.json` 已删除；技能内容保留在 `skills/agent-dispatch/`，作为随包分发的可选项。

本轮不发布到公开 npm：安装方式是 `npm pack` 产物加 `npm install -g <tarball>`。

目标适配器的加载改为按需：`src/adapters/index.mjs` 只在派发到某个目标时才 `import` 对应模块。桌面目标（豆包工作、TRAE）的代码仍在同一个包里，但不派发到它们就不会被加载。

## Alternatives considered

保留 Codex 插件形态、只补文档说明路径 - 最强理由：零打包工作，Codex 用户继续享有技能自动加载与 MCP 自动接线。否决原因：其它宿主仍要推导版本化路径，用户提出的问题没有被解决。

发布到公开 npm 注册表 - 最强理由：任何人 `npm i -g uagents` 即可使用。本轮否决原因：用户没有 npm 账号且注册页面暂时受限；`uagents` 这个名字在 2025-10-07 曾被第三方发布 `0.1.0`、2025-10-09 整包撤回，占用情况需要一次真实发布才能确认。

把豆包工作与 TRAE 拆成第二个包 - 最强理由：非 Windows 安装不带桌面代码。否决原因：实测分发体积只有 3.4 MB（此前"94 MB"是把开发用 `node_modules` 算进去了），而拆分要求把 `src/adapters/index.mjs` 的静态导入和 `src/host/target-supervisor.mjs` 的 launcher 构造改成可注入的按需发现，并多维护一个包的版本同步。收益与代价不匹配。

复用 one-code-cli / agent-mux / ai-dispatch / climux / zag - 最强理由:都是 MIT,已经做了"一个命令调多个 agent CLI"并把每次运行落盘。否决原因:它们没有受管桌面目标、没有 Council、没有已验收的持久任务与不确定状态处理;换过去等于丢掉已实现能力,且会换语言栈。只借鉴了形态：`occ skills install --target` 这类“把说明书装进宿主技能目录”的做法已实现为本包的 `uagents skills install --dir <目录>`（带 `--dry-run` 与 `--force`），不引入外部依赖。

保持现状不动 - 最强理由：不引入打包与发布义务。否决原因：入口路径继续依赖安装位置，问题仍在。

## Research evidence (2026-10-06)

- `registry.npmjs.org/uagents` 返回 200：`0.1.0` 发布于 2025-10-07，2025-10-09 撤下（`unpublished`）；`npm view uagents` 为 E404。npm 撤回政策原文：整包撤回后 24 小时内不能再发新版本。用户确认该版本不是自己发布的。`uagents-cli`、`@uagents/cli`、`agent-mux` 均不存在。
- npm 官方文档：没有 `.npmignore` 时会改用 `.gitignore`；`files` 白名单之外的 `package.json`、`README`、`LICENSE` 与 `bin` 始终包含；`package-lock.json` 始终排除。
- npm 官方文档：OIDC 可信发布要求 npm CLI `>=11.5.1`、Node `>=22.14.0`、工作流 `id-token: write`，并在 npm 网站为包配置可信发布者。本机是 node 24.13.0 / npm 11.17.0。本轮不需要，因为不发布。
- 第三方义务（本地实查）：`mcp/{unified,doubao,trae}/THIRD_PARTY_NOTICES.md` 记录的运行时组件全部是 MIT（`@modelcontextprotocol/*` 2.0.0、`zod` 4.5.4、`ws` 8.21.1、`jose` 6.2.12、`eventsource*`、`pkce-challenge`），TRAE 侧 vendored 的 `@luckycat133/traecnclaw` 0.6.0 也是 MIT。结论：MIT 主包与这些义务兼容，但 NOTICE 与 `third-party-licenses/` 必须随 tarball 分发。

## Consequences and validation

- 任何能执行命令的宿主可以直接调用 `uagents`，不再需要知道安装位置；单一包意味着只有一个版本号需要同步。
- 持续代价：本轮只能从本地 tarball 安装，README 与快速开始必须带着"构建 + `npm pack` + 全局安装"这一步；`files` 白名单要在运行时文件移动时同步维护；由于包根目录没有 `.npmignore`，npm 会回退到 ignore 文件，`npm run test:pack`（对 `npm pack --dry-run` 的结果核对必需文件与禁止内容）是这条规则的守卫。
- 已知限制：桌面目标的代码会随包分发到非 Windows 机器，只是在派发前不会被加载。
- 已知限制：`mcp/*/package-lock.json` 无法进 tarball（npm 始终排除），NOTICE 中引用的 integrity 记录只存在于仓库。
- 已知既有失败：`tests/codex-app-server.test.mjs` 两条取消语义测试在未改动的基线上同样失败，见同日期的验证记录；本次改动没有引入也没有修复它。
- 验证：`tests/package-distribution.test.mjs`、`npm run test:pack`、临时前缀下的全局安装与 CLI 检查，见 [npm 包分发验证](../verification/2026-10-06-npm-package-distribution.md)。

## Conditions for revisiting

拿到 npm 账号、并确认 `uagents` 名字可占用后，重新评估公开发布，届时改用 OIDC 可信发布而不是长期 token。如果出现真实的非 Windows 用户需要干净安装，重新评估桌面目标拆包。如果 `uagents` 名字不可用，只需换包名，`bin` 命令名与文档可以不变。
