# 自动签到

uAgents 在 Windows 启动时检查本机 TRAE CN / TRAE SOLO CN、WorkBuddy 的有效登录态。任一允许的目标已登录时，注册或复用 `uAgents.AutoCheckin`，默认每天本机时间 **00:30** 签到，错过时间后补跑。uAgents 退出后，计划任务仍独立运行。

初始化只读取本地登录态、部署运行文件和注册任务。计划任务执行时才访问签到接口；每个账号独立处理，先查今日状态，已签跳过。未登录或 token 过期则跳过。登录和刷新仍由原客户端负责。

## 启用与查看

```powershell
uagents init
uagents checkin status
uagents checkin --check-only
uagents checkin
```

- `init` 按本机登录态自动注册；尊重已保存的停用状态。
- `checkin status` 读取计划任务与最近一次计划任务执行报告，不访问 Provider。
- `checkin --check-only` 只查两边的签到状态。
- `checkin` 立即执行一次签到，不注册任务。
- `--target trae` / `--target workbuddy` 可限制手动执行范围，也可重复指定。

更改每日时间、显式重新启用或停用：

```powershell
uagents checkin enable --time 01:00
uagents checkin disable
```

停用会保存偏好并停用 uAgents 自己的计划任务，后续启动不会重新启用。设置 `UAGENTS_AUTO_CHECKIN=0` 可禁止本进程自动注册；它不停止已经注册的任务，停止应使用 `checkin disable`。

自动注册入口包括统一 stdio MCP 启动、共享服务的 `init` / `serve`，以及 CLI 的 `submit` / `council-submit` / `ensure`。CLI 的 discovery、probe、status、result 等命令保持原有观察行为。共享服务和 registry 禁用的目标不参与该入口的注册。已有任务的范围由最近一次有效注册决定。

## 独立执行与迁移

脚本、偏好和报告默认保存到 `%USERPROFILE%\.uagents\checkin-v1`；没有 USERPROFILE 时回落到 `%LOCALAPPDATA%\uAgents\checkin-v1`。运行目录按源码、目标、Node 路径与物理状态路径的 SHA256 标识部署，计划任务不依赖安装包路径或源码仓库的生命周期。状态命令返回实际报告路径。

部署使用物理绝对路径，兼容 MSIX 宿主对 AppData 的目录重定向。不同宿主使用同一用户目录中的停用偏好。新构建下一次初始化时更新计划任务指向；旧运行文件保留，不覆盖运行中的构建。

计划任务使用当前 Windows 用户、Interactive 登录类型和 Limited 权限，隐藏启动，最多执行五分钟，重复运行请求由 `IgnoreNew` 忽略。用户需已登录 Windows；电脑关机或退出 Windows 期间不会执行，之后可补跑。任务不保存 Windows 密码。

检测到原 `AutoCheckin` 任务时，仅迁移经过核验的 `auto-checkin\run_all.bat`：它必须调用 TRAE、WorkBuddy 的原签到脚本，且脚本包含相应接口。先注册新任务，再备份旧任务 XML 到 `legacy-AutoCheckin.xml` 并停用旧任务。不会删除旧脚本或修改无关任务。正在运行的旧任务不会迁移；发现同名 uAgents 任务但所有权标记不匹配时拒绝覆盖。

## 登录态与结果

TRAE 依次读取 `%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json` 和 `%APPDATA%\Trae CN\User\globalStorage\storage.json`。当前支持个人客户端登录态，不扫描其它账号目录或受管隔离 profile。

WorkBuddy 读取 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`。支持原明文 token 和本机验证过的加密格式；加密格式使用已安装 WorkBuddy 的 Node 模式和客户端自身解密组件，仅在内存与内部管道中处理。验证版本为 WorkBuddy **5.7.3**。未知格式或运行组件缺失时跳过，不导出密钥、不写入原登录文件。

只访问 TRAE 的 `api.trae.cn` 和 WorkBuddy 的 `www.codebuddy.cn`；拒绝 HTTP 重定向与未知登录域。没有额外 Python 依赖，不发送飞书等通知。输出仅含登录是否存在、来源、签到状态和必要业务码，不含 token、token 前缀或原始 Provider 响应。

结果可能为 `checked_in`、`already_checked_in`、`not_checked_in`、`skipped`、`failed`、`unconfirmed`。领取响应丢失时只复查状态，不自动重发该领取。只有 TRAE 明确拒绝的 `9074` 限流最多重试三次。

WorkBuddy 状态查询返回未签，但领取接口以 HTTP 400 / code 10001 明确回复“今天已签到”时，结果记录 `verification=provider_already_checked_in` 和 `status_query_checked=false`，保留接口差异。只查状态仍反映查询接口的原值。未知的 10001 错误不会当作签到成功。

精确命令见 [CLI Reference](../reference/cli.md)，测试和真实计划任务运行记录见 [验证证据](../verification/2026-10-04-auto-checkin.md)。
