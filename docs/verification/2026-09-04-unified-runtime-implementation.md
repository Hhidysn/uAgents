# Unified Agent Runtime implementation verification

日期：2026-09-04  
实现版本：`0.2.0-alpha.1+codex.20260904010854`  
实现提交范围：`5f11261..b51c3d7` 之后的当前 HEAD

## 结果

统一 Core、五个 Adapter、CLI 和单一 stdio MCP 已实现并切流。插件 manifest 只声明 `unified` MCP；旧目标专用 server 不再进入宿主工具面。现有未提交的旧豆包/TRAE store、smoke 与 dist 修改保持未提交、未覆盖。

## 确定性验证

最终 `npm test` 退出码为 0：

- Root/Core：58/58 通过。
- 历史豆包 transport 回归：9/9 通过。
- 历史 TRAE gateway/transport 回归：9/9 通过。
- Unified MCP：2/2 通过。
- 合计：78/78 通过。

覆盖包括：严格协议与 envelope、模型四字段、Policy fail-closed、32 进程同 UUID 单 Attempt、发送检查点 kill-point、waiting-user/indeterminate 状态机、workspace 父子冲突与 fencing、短 TTL heartbeat 续租、输入变化、不可变产物捕获、五个 Adapter、CLI 取消、CLI/MCP 同 UUID，以及真实 stdio initialize/tools-list。

测试仅使用 fixture 和 connection-only/version-only probe，没有提交真实模型任务。Node 24.13.0 会为 `node:sqlite` 输出 ExperimentalWarning；测试未把警告误当失败。

## 干净插件验证

从 Git HEAD 使用 `git archive HEAD:plugins/uagents` 生成不含 `node_modules`、`.git`、`.local` 和研究资料的干净副本：

`F:\documents\software\uAgents\.local\verification\53e9b19b-3c67-46c2-b5b0-ec411c865995\plugin`

结果：

- `quick_validate.py`：Skill valid。
- `validate_plugin.py`：Plugin validation passed。
- 统一 MCP server 名称：`uagents-unified`。
- 工具数：10；名称与设计一致。
- OpenCode probe：`1.18.13`、`scope=version_only`、`submission=not_sent`。

## 本机安装状态

`codex plugin add uagents@personal` 未完成：Codex 在备份旧插件缓存时返回 Windows `Access denied (os error 5)`。只读检查进一步确认：

- 当前已安装版本仍为 `0.1.0-alpha.6+codex.20260902162429`。
- personal marketplace 当前源是 `C:\Users\24590\plugins\uagents`，不是本次编辑的 F 盘仓库插件目录。
- 当前执行令牌对 `C:\Users\24590\.codex\plugins\cache\personal` 的相关路径没有可用写入能力。

因此没有删除缓存、没有手改 marketplace，也没有把“源码实现完成”误报为“Codex 已加载新版”。需在 marketplace 源同步到本次插件目录并具备缓存写权限后重新执行安装，再用新 Codex 任务确认新 Skill/MCP 拾取。
