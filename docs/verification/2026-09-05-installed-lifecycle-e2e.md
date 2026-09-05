# 安装后受管生命周期 E2E 证据（Gate 5 发布步骤 8，CLI-first）

日期：2026-09-05。安装缓存：`C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260905113451`（SHA-256 与 C 盘源 110/110 一致）。全部验证通过安装缓存中的 `bin\uagents.mjs` 执行；未发送任何 Prompt、未消耗额度。

## 发布链

1. `git archive HEAD:plugins/uagents` → 110 文件暂存副本（双校验器通过、CLI 冒烟通过）。
2. 旧源移备份（`uagents-backup-20260905*`）→ 原子替换。
3. `codex plugin add uagents@personal` → 版本 `0.2.0-alpha.1+codex.20260905113451`。
4. 源↔缓存逐文件 SHA-256：110/110 一致。

## 安装缓存只读验证

- `targets` → 5 个目标。
- `capabilities doubao` → `lifecycle:{managed:true,auto_launch:true,profile:"isolated",ensure:true,resume:true,stop:true}`。
- `probe doubao` → `target_not_ready/cdp_unavailable`，`submission:not_sent`（只读、未启动）。

## Doubao 受管 E2E（完整闭环）

1. 首次 `ensure doubao`：**失败 `launch_failed/process_exited, exit_code=0`** —— 真实缺陷暴露：DoubaoWork.exe 是 stub 启动器，派生 `app\DoubaoWork.exe` 后正常退出 0；launcher 误判为失败。现场同时发现 16:53 的受管孤儿实例（PID 32004，命令行引用 `host-v1\profiles\doubao\1`，Host DB 无记录）。
2. 修复（fc1303c）：exit 0 视为移交；新增孤儿收养——端口段扫描 + 所有权（安装树 + 命令行引用受管 Profile 根 + 端口一致），命令行只读瞬态、不落盘。
3. 重发后 `ensure doubao` → `ok:true`：**收养** PID 32004（`adopted:true`），`waiting_user/preflight_login`，未重复启动。
4. 二次 `ensure` → `mode:reuse`，同一 instance_id。
5. `stop` 首次遇 `lease_conflict` —— 第二个真实缺陷：一次性 CLI ensure 无 worker 释放 Host lease（bc59093 修复：ensure 返回前释放，任务路径不受影响）。
6. 修复后 `ensure`（reuse）→ `stop` → `ok:true`，端口 19222-19224 清空、无残留进程。

## TRAE 受管 E2E

`ensure trae` 返回 `ok:true` 完整证据：gateway（PID 31020，port 19422，`instance_nonce`，capability file 于 `host-v1\secrets\trae-gateway-token`）+ 桌面（PID 13888，CDP 19322）双启动，`waiting_user/preflight_login`（setup surface）。shell 超时将本次会话进程树一并终止（端口已清空），属测试环境问题而非插件缺陷。`stop trae` 对死实例正确拒绝（`stop_not_owned/ownership_verification_failed`），用户日常 Trae 窗口未被触碰。

## 环境审计

- 受管专用窗口均使用 `host-v1\profiles\<target>\<n>` 隔离 Profile；用户自己的 Doubao/Trae 窗口全程未被连接、导航或终止。
- 未发送 Prompt、未登录、未消耗额度；gateway token 只存在于 secrets 文件与内存。
- 修复提交：`fc1303c`（收养）、`bc59093`（一次性 ensure 释放租约）+ 两次 cachebuster（最终 `0.2.0-alpha.1+codex.20260905113451`）。
