# uAgents 与 sub-agents-skills 功能对比

日期：2026-09-02。

## 调研基线

对比对象为 [shinpr/sub-agents-skills](https://github.com/shinpr/sub-agents-skills) 的提交 [`08e11c89de7973de859a09e4a25f51021f5275f5`](https://github.com/shinpr/sub-agents-skills/tree/08e11c89de7973de859a09e4a25f51021f5275f5)，版本 `0.13.2`。本机只读快照保存在 Git 忽略的 `third-part-research/sub-agents-skills/`，不进入 uAgents 发行包。

检查范围包括项目 README、Skill、Python runner、后端命令构造、流解析、单元测试、CI 和 MIT 许可证。其 254 项测试在本机设置 `PYTHONUTF8=1` 后全部通过；不设置时有 253 项通过、1 项因 Windows 中文区域默认 GBK 读取含 Unicode 的 `pyproject.toml` 失败。这说明实现本身测试较完整，也暴露了一个非 UTF-8 Windows 环境下的测试可移植性问题。

主要源码证据：

- [README 与安装/Agent 定义说明](https://github.com/shinpr/sub-agents-skills/blob/08e11c89de7973de859a09e4a25f51021f5275f5/README.md)
- [Skill 工作流](https://github.com/shinpr/sub-agents-skills/blob/08e11c89de7973de859a09e4a25f51021f5275f5/skills/sub-agents/SKILL.md)
- [后端清单与默认超时](https://github.com/shinpr/sub-agents-skills/blob/08e11c89de7973de859a09e4a25f51021f5275f5/skills/sub-agents/scripts/_constants.py)
- [命令、权限和模型参数映射](https://github.com/shinpr/sub-agents-skills/blob/08e11c89de7973de859a09e4a25f51021f5275f5/skills/sub-agents/scripts/_builder.py)
- [同步进程、超时、输出上限和 OpenCode 隔离](https://github.com/shinpr/sub-agents-skills/blob/08e11c89de7973de859a09e4a25f51021f5275f5/skills/sub-agents/scripts/_executor.py)
- [Windows/Linux、Python 3.9/3.12 测试矩阵](https://github.com/shinpr/sub-agents-skills/blob/08e11c89de7973de859a09e4a25f51021f5275f5/.github/workflows/test.yml)

## 两个项目解决的问题不同

`sub-agents-skills` 是一个通用的 CLI 子 Agent runner：项目用 `.agents/*.md` 写角色说明，通过 `run-agent/model/effort/permission` frontmatter 选择后端，父 Agent 同步调用 Python 脚本并取得统一 JSON 结果。它强调跨工具可移植和广泛后端覆盖。

uAgents 是面向这台 Windows 机器和 Codex 工作流的受控调度插件：CLI 路线只是其中一部分，另外还要复用豆包工作、TRAE CN 已登录桌面应用的额度，并记录长任务的提交、归属、状态和结果。它强调明确路线、额度边界、持久任务和桌面应用连接。

因此二者不是简单替代关系。`sub-agents-skills` 更像通用 CLI 执行内核和角色格式；uAgents 更像带安全边界和桌面桥接的本地编排产品。

## 功能对照

| 维度 | sub-agents-skills `0.13.2` | uAgents `0.1.0-alpha.5` | 判断 |
| --- | --- | --- | --- |
| 分发形式 | 一个可复制的 Agent Skill，并提供 Codex、Claude、Grok plugin/marketplace 元数据 | 一个 Codex Plugin，包含一个 Skill、CLI 运行时和两个 MCP | 前者发布成熟且跨客户端；后者才能在同一包中声明桌面 MCP |
| Agent 定义 | `.agents/*.md`；角色正文与 `run-agent/model/effort/permission` frontmatter | 五份 route reference；每次请求 JSON 直接携带任务、模式和产物 | 前者的角色复用与发现明显更完整；uAgents 应借鉴其格式思想 |
| CLI 后端 | 10 个：Codex、Claude、Cursor、GLM、Kimi、Grok、Antigravity/agy、Gemini、OpenCode、Command Code | 3 个：agy、WorkBuddy、OpenCode；另有 2 个桌面 MCP | 前者覆盖面更广；uAgents 当前覆盖的是用户实际要用且已验证的路线 |
| 模型选择 | 后端特定的任意 `model`，`effort` 原样转发 | 固定 allowlist；OpenCode 当前只有 DPF/GLM，agy 固定已验证 Gemini slug | 前者灵活；uAgents 更符合现有额度与“不静默换路线”的约束 |
| 权限 | `read-only/safe-edit/yolo` 统一映射；默认 `safe-edit`，无 stdin，使用各 CLI 非交互模式 | `analysis/implementation` 表达意图；只在已授权 implementation 中启用目标原生编辑能力，不提供通用 yolo | 前者易用但不同 CLI 的隔离强度不同；uAgents 更保守，却仍缺真正的硬性只读/路径隔离 |
| 执行模型 | 父进程同步等待单个 CLI，默认 600 秒；读取流式输出，得到终态后结束/终止子进程 | submit 后由 detached worker 继续，调用方用 status/result 跟进 | 短任务前者更简单；长任务、宿主工具超时和断线恢复由 uAgents 表达得更完整 |
| 任务身份 | 公开结果为 `result/exit_code/status/cli`；没有可查询 task handle | UUID request、task ID、原生 session/task ID、摘要冲突检查和持久状态 | uAgents 对重复提交、发送后断线和任务归属更强 |
| 终态语义 | `success/partial/error`；超时杀本地进程并返回 124，可保留部分文本 | queued/running/needs_user/succeeded/failed/cancel_requested/cancelled/unknown 等；发送状态未知禁止重放 | uAgents 更适合桌面和长任务；前者的三态适合一次性 CLI |
| 产物验收 | 返回最终文本，不核对声明的输出文件 | implementation 必须声明 expected outputs，并检查位置、非空、大小和摘要 | uAgents 的文件交付证据更完整，但目前仍是事后检查 |
| 会话续接 | 每次新上下文；没有公开 resume/status/cancel handle | 设计保留原生 ID，但当前 CLI 也没有可靠 resume 和原生 cancel 确认 | 两者都未完成通用多轮会话；uAgents 至少避免伪造恢复成功 |
| OpenCode 并发 | 为每次调用复制 auth 到独立临时 XDG data/state，避免共享 SQLite 锁 | 每个任务独立 `opencode run --pure`，还没有同等明确的 XDG 隔离 | 这是值得直接吸收的工程措施 |
| 多模型会审 | 可由父 Agent 并行调用不同 Agent 定义；runner 不负责统一题目、匿名或综合 | 明确要求主模型先记录方案、候选同题独立、Codex 按证据综合 | 前者提供通用积木；uAgents 提供本机既有的会审纪律和额度策略 |
| 桌面应用 | 无桌面 MCP；只执行 CLI | 豆包工作与 TRAE CN 的 CDP/MCP 任务桥接 | 这是 uAgents 不能被该仓库替代的核心能力 |
| 安全边界 | 校验 Agent 名称和 symlink；提示只使用可信定义；提供显式 yolo | 固定目标/模型、无任意 CDP eval、任务去重与窗口所有权；CDP 本身仍让同机进程接触登录窗口 | 两者风险不同；不能把通用 profile 当成执行授权 |
| 测试与 CI | 254 项本地通过；GitHub Actions 覆盖 Windows/Linux 和 Python 3.9/3.12 | 68 项当前完整回归通过；主要针对 Windows、Node 22+ 和真实本机协议 | 前者跨平台成熟度更高；uAgents 的真实桌面闭环更贴近当前需求 |
| 许可证 | MIT，仓库和 plugin manifest 明确声明 | 第三方来源/许可证齐全，uAgents 自身尚无顶层 LICENSE | uAgents 发布前必须补齐自身许可证 |

## 可以复用的设计

### 1. 采用角色文件，保留现有执行内核

可以借鉴 `.agents/*.md` 的单一职责、完成条件和扁平 frontmatter，但不必直接替换现有 Node worker。uAgents 已经有任务持久化、幂等、产物核验和桌面 MCP；全部换成同步 Python runner 会丢掉这些能力。

建议新增一层薄解析器：Agent profile 解析为已有 `agent-call.mjs` 请求，适配器继续拥有 target/model allowlist、权限和额度边界。这样角色定义可以复用，传输与安全策略仍由 uAgents 控制。

### 2. 吸收 OpenCode 的每任务状态隔离

对方为每个 OpenCode 进程创建临时 `XDG_DATA_HOME/XDG_STATE_HOME`，只复制所需 auth 文件并在结束后删除，用来规避并发 SQLite session 锁。uAgents 在增加并发会审前应做同类验证；实现时不能读取或记录认证内容，也不能把临时目录落到插件发行目录。

### 3. 采用后端能力表和跨平台测试思路

对方把 command builder、权限映射、effort 支持和 stream parser 分开，并用 Windows/Linux、Python 版本矩阵验证。uAgents 继续用 Node 即可，但可把每条 route 的 `analysis/implementation/model/session/cancel/multimodal` 能力整理为机器可读表，减少 SKILL、reference 与代码漂移。

### 4. 保留它没有覆盖的 uAgents 层

以下部分不应删除或降级：

- 豆包工作、TRAE CN 两个独立 MCP 和严格应用身份检查。
- request UUID、发送前登记、摘要冲突、unknown 状态与禁止自动重放。
- expected outputs 的文件证据。
- 多模型相同题目、独立上下文、额度不静默切换和主模型最终综合。

## 不宜原样照搬的部分

- 不采用默认 `safe-edit` 加通用 `yolo` 的权限模型。不同 CLI 的 flag 语义不等价，uAgents 也不能让一个第三方 Markdown 文件自行获得无沙箱执行权。
- 不直接采用 OpenCode `--auto`。当前 uAgents 明确不为文本提案开启自动审批，与该 runner 的实现存在冲突。
- 不把任意 `model` 值直接传给已登录/计费路线。模型必须保留 allowlist 和 opt-in 额度规则。
- 不通过重定向 Claude 环境变量新增 GLM/Kimi 计费路线。本机已经用 OpenCode 管理相关 provider，重复认证与路由会增加秘密和账单风险。
- 不用同步 600 秒等待替换 uAgents 的 submit/status/result。Codex 工具超时、桌面生成和断线恢复都需要持久任务状态。
- 不把 Agent profile 的正文视为可信授权。只允许用户或受信仓库提供的定义，并在执行前仍以当前会话授权、目标能力和 owned paths 为准。

## 采用决定

不整体引入或替换为 `sub-agents-skills`。计划吸收三部分：`.agents/*.md` 的角色定义方式、后端能力表、OpenCode 每任务状态隔离。实现为 uAgents 自有的最小 Node 解析层，继续复用现有 worker 与两个 MCP。

若后续需要复制其实现代码而不仅是借鉴接口，应依据 MIT 保留许可证和归属；当前对比阶段只保留独立研究快照与来源链接，没有把对方代码复制到发行目录。
