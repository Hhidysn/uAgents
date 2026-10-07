# 2026-10-07 调度失败诊断与修复

基线：`36128c2`，本次在其上修改；未重发两项研究任务。当前改动字节指纹与实机 probe 保存在本地 `.local/verification/dispatch-diagnostics-20261007/`。

## 原任务证据

- Gemini Task `7812ef87-d739-48c0-9bbd-22962de609a2`，native conversation `c4aa9df0-d7d6-46b8-8d29-f0d21d7f2d96`。请求及模型核验正常，终态 `ERROR`，回答为空。只读原生 conversation SQLite 的 `steps.step_payload` 后发现 Google `streamGenerateContent` 请求反复 `EOF`（含内部 attempt 2–8 和最终 executor error）。这是原生提供方连接失败，不能归因于 runner Low。uAgents 只有一个 Attempt，但 agy 内部进行了 HTTP 重试。旧 uAgents 未记录原生 stream，因此只读恢复的片段不等同完整 transcript；没有写回或改造原生数据库。
- GLM Task `d388b318-0572-4452-91fe-9448e8e82228`，native session `ses_eeab512faffe650FssVH6KbVxf`。原 durable stdout 与只读 `session export` 均确认最后回答仅 86 个字符，uAgents 未截断。前序推理约 19,273 字符，output token 不是最终回答长度。三项 webfetch 的错误均为 `unknown certificate verification error`，两项 websearch 失败；未完成官方来源审阅。原生成功与模型核验通过不改变研究验收结论。

两份完整请求在独立研究工作区 `dispatch/survey-gemini-request.json`、`dispatch/survey-glm-request.json`。只读旧结果查询、原始 transcript 解析与已有 native session 导出均不发送新 prompt。

## 实施

- agy 将显式 `execution.effort` 透传为 `--effort`。此前 legacy request 已携带 effort，但 args 构造遗漏；不能据此声称旧调用实际使用了 Low，旧 init 未报告 effort。
- 原生 `ERROR` 产生结构化错误；缺失原因明确标记 `reason_available:false`。原因有界脱敏，不猜测认证或额度。旧 `ERROR` 丢失错误的任务查询补充通用提示，不修改历史记录。
- agy 按 Attempt 保存有界诊断摘要（退出码、effort 请求/自报、原生错误、stderr 摘要、最多 50 条工具错误）；不写入工具参数、完整原生事件或 provider body。
- OpenCode 在成功/失败结果中保留有界工具失败摘要，回答解析不变。
- `result` 提供已存在的本机证据路径及已知退出码，旧 durable exit 文件也可读取。缺失日志/自报信息保持 `null`。
- 独立 Skill 与 aiGame AGENTS/开发指南/cli_runner 同步：主代理准备请求并验收，read-only runner 精确执行并回报；网页来源未读入须标未完成。保留 runner Low，并区分外部模型 effort。

## 验证

`node --test tests/agy-native-permissions.test.mjs tests/cli-transports.test.mjs tests/opencode-v2-completion.test.mjs tests/unified-cli-adapters.test.mjs tests/cli-history.test.mjs tests/cli-convenience.test.mjs`：93/93 通过。覆盖 error 原因缺失/string/object、脱敏、空 SUCCESS、审批优先、effort 透传、worker 结果、旧错误 fallback、成功结果含工具失败与同 Attempt 未重放。

只读复核后进一步覆盖 Basic 凭据与非法 exit 字段，最终字节执行 `node --test tests/agy-native-permissions.test.mjs tests/opencode-v2-completion.test.mjs tests/cli-history.test.mjs`：29/29 通过（包括非零 exit 的原生 ERROR、Bearer/Basic/URL/quoted-key 脱敏、真实 stderr tail、等待审批的诊断保留）。`npm --prefix plugins/uagents/mcp/unified test`：28/28 通过；最终摘要净化调整后重新构建 bundle，`npm run test:pack` 检查 162 个文件、23 个必需路径通过。git diff whitespace 检查通过。

真实安装的 agy 使用 `--effort high` 完成 preflight handshake，退出 0，`submission:not_sent`，未提交用户消息、未调用模型。native init 未自报 effort，保持 `effort_reported:null`。这只证明参数被当前 CLI 接受，不声称 provider 任务已恢复。

当前 Windows curl 和 Node fetch 读取 Modrinth API 文档、GitHub Vineflower 页面返回 200；不证明 OpenCode 的 webfetch TLS 已修好。CLI child environment 没有丢弃 CA/proxy 变量；当前 shell 与 managed service 配置未设置额外 CA。原任务带硬时限，使用 standalone，因此其证书配置来自启动环境。准确 TLS 根因尚未确定，没有关闭校验或重启/修改原生服务。若实际需要私有根 CA，应在正确进程配置已核实的 PEM；见 [OpenCode 官方网络说明](https://opencode.ai/v2/docs/network/)。当前可用的研究替代流程是主代理先保存官方来源，再提交限定材料的分析任务。

未重新执行两项研究，没有把旧连接错误或研究结果改写成成功，也没有运行新的付费 provider 回归。

本地 CLI 已用离线 tarball 更新，并刷新 `C:/Users/24590/.codex/skills/agent-dispatch`。安装后的五个改动模块与 Skill SHA-256 均匹配仓库；新 CLI 查询旧 Gemini 任务返回明确的 missing-reason 错误，查询旧 GLM 任务返回原 stdout/stderr 路径与退出码 0。aiGame runner TOML 解析通过，仍为 Luna Low。两仓库本次代码/文档均未提交推送，aiGame 原有 `.pi/APPEND_SYSTEM.md` 等用户改动保留。

## 提交复检

被测版本为 `uagents@0.2.0-alpha.4`，对象为 Git 基线 `36128c2` 上最终提交工作树。前述原生调查、安装和实机验证为原有记录；本次复检未重发模型请求、领取积分、更新全局安装或修改 aiGame 仓库。

`sol_high` 只读审阅发现并复现诊断摘要的三项问题，主代理完成修正，四个新增回归用例均先失败后通过：

- 省略带缩进或行内的回显 payload，并覆盖 camelCase token 字段。agy 不再先截断原 stderr 后脱敏：完整捕获至多 64 KiB，超过界限则省略尾部并记录 `stderr_truncated:true`，避免丢掉标记后泄露正文；分块输出的标记与凭据也覆盖。
- 被拒绝的会话结果不提供诊断状态或错误原因；带显式外来会话身份的工具事件不进入当前 Task 诊断。
- OpenCode transcript 缺失、格式错误或仅含外来会话时，`identity_verified` 保持 false；只有匹配的原生事件才提供身份核验证据。

只读复查未发现上述问题的剩余阻断项。新诊断测试纳入 `npm test` 和 `npm run test:unified`；CLI Reference、包内 AGENTS、默认预算说明及验证目录导航同步。

最终检查：

- `UAGENTS_AUTO_CHECKIN=0 node --test tests/protocol.test.mjs tests/cli-convenience.test.mjs tests/native-diagnostics.test.mjs tests/agy-native-permissions.test.mjs tests/opencode-v2-completion.test.mjs tests/cli-transports.test.mjs tests/unified-cli-adapters.test.mjs tests/cli-history.test.mjs tests/package-distribution.test.mjs`：113/113 通过。Windows 实际命令先设置对应环境变量，再执行 `node --test`。
- 同一环境下 `npm --prefix plugins/uagents/mcp/unified test`：重新构建后 28/28 通过。定向检查合计 141 项；没有运行整个仓库测试。
- `npm run test:pack`：alpha.4 包含 162 个文件，23 个必需路径通过。
- 15 份变更 Markdown 的 71 个本地链接、15 个 JS 文件语法、2 份 JSON 及两个标准测试入口通过；`git diff --check` 通过。

上述脱敏覆盖已复现的格式，不对没有可识别标记的任意自由文本作凭据净化保证。旧安装的源文件一致性按首次安装记录解释；提交复检修正尚未在全局安装副本重新验收。
