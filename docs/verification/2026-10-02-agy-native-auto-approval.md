# agy 原生工具自动批准验证

日期：2026-10-02（Asia/Shanghai）。基础提交：`6701b15`。测试对象：该提交加本记录所述 agy 启动参数修复，分支 `codex/agy-native-permissions`。插件构建：`0.2.0-alpha.1+codex.20261001173059`。

## 原审批原因

本机 `agy.exe --version` 返回 `1.2.14`。`agy.exe --help` 声明 `--dangerously-skip-permissions` 自动批准所有工具权限请求，`--sandbox` 启用终端沙箱限制。

旧 Task `b779752f-a465-4b4c-af92-797562e2f7a1` 已发送并验证为 `Gemini3.8FlashMedium`，但停在 `waiting_user / native_approval_required`，没有审查结果。只读检查其原生会话 `54417a40-b92a-4740-a2ed-5a5bca2bb647` 的 SQLite steps 后，确认被拒绝的工具是 `run_command`。原生错误明确要求一次管理员提权，以设置 sandboxing。现有 adapter 强制传入了 `--sandbox`；这次审批涉及 Windows 沙箱初始化，不是仓库目录的文件系统访问授权。原 Task 未重放；其他调用已记录的取消意图未改动。

原生沙箱说明：[Antigravity CLI sandbox](https://antigravity.google/docs/cli-sandbox)。只读审查仍可能运行终端工具；提示中的只读意图不免除原生工具审批。

## 变更

用户明确要求改用原生 `--dangerously-skip-permissions`。agy 的 analysis 和 implementation 启动均增加该参数，移除 uAgents 强制注入的 `--sandbox`。保留显式模型、workspace、stream JSON、超时，以及 implementation 的 `--mode accept-edits`。原生用户配置仍可以启用沙箱。

`analysis` 和 `advisory-read-only` 是提示指导，不提供强制只读保证。审查 Task 必须明确要求不修改文件、不执行有修改效果的命令。uAgents 没有增加模拟点击审批逻辑，没有改变幂等、取消、发送不确定性或权限拒绝的处理。

## 针对性测试

执行命令：

```powershell
node --test tests/agy-native-permissions.test.mjs tests/protocol.test.mjs tests/advisory-permission.test.mjs
node --test --test-name-pattern agy tests/unified-cli-adapters.test.mjs
```

结果：第一条 `12/12` 通过，第二条选中的 agy 测试 `1/1` 通过。新增测试验证两个模式的原生参数，以及原生仍拒绝工具时记录 `needs_user / native_approval_required`、`retry_safe=false`，只发送一次请求。已有测试覆盖 advisory 权限、协议幂等、取消和 agy adapter 行为。

打包检查 `node --test tests/plugin-package.test.mjs` 为 `1/1` 通过；`skill-creator/scripts/quick_validate.py plugins/uagents/skills/agent-dispatch` 返回 `Skill is valid!`。本轮合计 14 个选定测试通过，`git diff --check` 通过。

## 真实 CLI 验证

使用独立 Git 样例目录 `F:\documents\software\uAgents\.local\agy-autoapproval-e2e-20261002\workspace`。样例在已有 `average.mjs` 中删除了空数组保护，并增加唯一标记 `AGY_DIFF_MARKER_8Q2L`。审查提示要求原生终端执行 `git diff -- average.mjs`，指出标记与缺陷，并禁止修改、创建、删除文件和运行修改命令。

- target：`agy`；model：`gemini-3.8-flash-medium`；mode：`analysis`；permission policy：`advisory-read-only`。
- Task：`81a2c84d-f8b3-489e-a705-d4c9d34b0ca5`；attempt：`1`；原生会话：`3eb5a267-eb47-4cb1-9dc8-c957f777319f`。
- 命令：使用修改后的 `plugins/uagents/bin/uagents.mjs submit --request <样例根目录>\request.json --state-dir <样例根目录>\state`，随后查询同一 state root 的 status/result。
- 结果：`succeeded`、`submission=sent`、`model_verified=true`，约 19 秒完成。没有停在原生审批。
- 原生 SQLite steps 证明 `run_command` 执行了 `git diff -- average.mjs`，工作目录正确。返回了精确标记，并正确指出空数组从返回 `0` 变为 `NaN`。
- 执行前后文件 SHA-256 都是 `db765d8c0dff5e4c1f946443913561ff2bc456028d56ba19df46446dc5605ef6`；Git 状态均为 ` M average.mjs`。本次样例工作目录内容未变化。

原生会话证据在本机 `.gemini/antigravity-cli/conversations` 下；样例、提交 JSON、执行前快照和 uAgents Task 状态保留在上述 `.local` 目录，不随仓库发布。

## 本机插件

通过 `codex plugin add uagents@personal --json` 安装构建 `0.2.0-alpha.1+codex.20261001173059`。仓库、个人插件源和已安装缓存的 manifest、agy transport、agy reference 与 Skill 文件 SHA-256 分别一致。已安装构建运行 `probe agy --model gemini-3.8-flash-medium`，返回 `succeeded / preflight_only / submission=not_sent`。真实 Task 使用同一 transport 内容，未为了安装复验而重复发送审查请求。

## 范围

真实验证覆盖本机 Windows、agy 1.2.14、Gemini 3.8 Flash Medium 的只读审查和终端读取。implementation 的参数行为有测试，未额外执行真实写入 Task；其他模型、其他机器和原生配置主动开启沙箱的场景未验证。自动批准不构成强制只读机制，也不保证原生 sandbox 的管理员初始化永远不会出现。
