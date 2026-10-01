# 本机插件发布与 OpenCode V2 兼容验证

日期：2026-10-02（Asia/Shanghai）。基础提交：`dd20958`；测试对象为该提交加本记录所述兼容修复、文档整理与回归测试。发布构建：`0.2.0-alpha.1+codex.20261001182923`。

## 发布范围

- 整理 README、当前 Agent/模型/Runtime 文档、协议参考和文档入口。校准 Codex 图片、Claude Code 图片/PDF/UTF-8 文本、DSH 图片协议映射及未确认 E2E 的能力表。
- 明确 agy 原生自动批准策略与 advisory 只读边界；原真实终端审查证据保留在 [独立记录](2026-10-02-agy-native-auto-approval.md)，本轮没有重复发送该审查请求。
- 纳入待提交的 OpenCode V2 修复：发现 `@opencode/cli` 的 Windows executable；解析 `opencode v2.x` 版本；V2 run 使用进程 cwd 而不注入已移除的 `--dir`；V2 模型发现一次列举后按配置 provider 过滤。V1 保留原参数映射。
- 保留 native args 顺序与参数冲突校验、原生身份检查、幂等、取消和发送不确定性规则。没有把文本加零退出码放宽为成功证据。

## 本机原生接口

已发现入口：`C:\Users\24590\AppData\Roaming\npm\node_modules\@opencode\cli\bin\opencode.exe`。只读执行 `--version`、`run --help`、`models --help`；原生版本为 `opencode v2.0.21`。

run 帮助包含 session/fork、model、JSON format、file、title、auto 和 standalone；不包含 `--dir`、`--pure` 或 `--variant`。模型格式为 `provider/model#variant`。models 帮助不再声明 provider 位置参数。

`uagents probe opencode --model commandcode-goat/deepseek/deepseek-v4.1-flash` 返回 `succeeded / version_only / version=2.0.21 / submission=not_sent`。

本次首次 models refresh 只返回配置行，未发现匹配项；后续直接查询同一入口和显式 `uagents models opencode --refresh` 都读到以下 5 条路线。首次差异原因未定位，不将目录发现视为账号或 Provider 在线证明。

```text
commandcode-goat/deepseek/deepseek-v4-flash
commandcode-goat/deepseek/deepseek-v4-pro
commandcode-goat/deepseek/deepseek-v4.1-flash
commandcode-goat/z-ai/glm-5.3
commandcode-goat/z-ai/glm-5.3-flash
```

刷新结果为 `discovery.status=ok / source=native`；这些路线均 `discovered=true`、`admission_allowed=true`，`provider_availability=unconfirmed`。

## 针对性测试

```powershell
node --test tests/cli-transports.test.mjs tests/model-discovery.test.mjs tests/agy-native-permissions.test.mjs tests/plugin-package.test.mjs
node --test --test-name-pattern OpenCode tests/unified-cli-adapters.test.mjs tests/opencode-durable-recovery.test.mjs tests/durable-cli-execution.test.mjs
python <skill-creator-root>/scripts/quick_validate.py plugins/uagents/skills/agent-dispatch
git diff --check
```

第一组最终 `49/49` 通过，涵盖原生版本和参数、V1/V2 目录、模型附件证据、权限拒绝及打包。新增回归以真实 V2 事件形状验证：只有 step_start/text 且退出码为 0 时仍为 `unknown / native_completion_unconfirmed / retry_safe=false`。

第二组 Node 输出 8 个通过项，其中 durable-cli-execution 文件没有匹配到用例，以文件级项返回通过；实际执行的 OpenCode 恢复、超时和 adapter 用例为 7 个，均通过。本轮实际执行 56 个针对性用例，不声称运行了完整测试套件。Skill validator 返回 `Skill is valid!`，diff 检查通过。

文档检查覆盖 README、当前能力、协议参考和随插件发布的 Skill 文档，共扫描 27 个文件、82 个本地链接，没有缺失目标文件；此检查不验证外部站点或 Markdown anchor。

## 真实 OpenCode Task：终态未确认

独立目录：`F:\documents\software\uAgents\.local\plugin-release-20261002`。使用新 UUID、独立 state root 和空 workspace，提交一条不使用工具、不修改文件、仅回复 `UAGENTS_OPENCODE_V2_OK` 的 analysis Task。

- target：`opencode`；route：`commandcode-goat/deepseek/deepseek-v4.1-flash`；permission：`advisory-read-only`。
- Task：`9ca81ebc-dd76-41fd-9650-4a6a539afa93`；attempt：`2f6e779b-f040-4b01-850e-b2c868fab076`，ordinal `1`。
- 原生 session：`ses_f07492f68ffeVXDVd5Qudz3aX0`。
- 提交、status、result 均使用同一个 `--state-dir <样例根目录>\state`。
- 原生 stdout 仅有同一 session/message 的 `step_start` 和 `text`；文本精确为 `UAGENTS_OPENCODE_V2_OK`，exit.json 记录退出码 `0`。没有 `step_finish`，没有工具事件，workspace 仍为空。
- uAgents 保持 `indeterminate / submission=sent / native_completion_unconfirmed`，最终 response 为空、usage 为 null。`model_reported=null / model_verified=false` 没有被推断填充。
- 对同一 Task 执行只读 reconcile 后仍为 `indeterminate`。没有换 UUID 重发，原始事件、请求和状态保留在上述 `.local` 目录。

这次调用证明了原生接收和文本事件送达，不能计为完整 E2E 成功。V2 终态事件缺失的原因及其恢复接口、V2 真实续接/fork、附件和写入任务尚未验证；V1 的历史成功记录不能代替 V2 验证。

## 本机安装

仓库中的 152 个 tracked plugin 文件已同步到个人源 `C:\Users\24590\plugins\uagents`，然后运行 `codex plugin add uagents@personal --json`。

返回安装版本：`0.2.0-alpha.1+codex.20261001182923`；安装目录：`C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20261001182923`。仓库、个人源和已安装缓存的 152 个 tracked 文件 SHA-256 全部一致。未手工更改 marketplace。

安装版 OpenCode probe 返回 `succeeded / version_only / 2.0.21 / not_sent`；agy probe 返回 `succeeded / preflight_only / not_sent`。安装验证没有重复发送任何 Provider Task。其它 target 本轮没有新增真实调用验证，其证据与限制仍以各自记录为准。
