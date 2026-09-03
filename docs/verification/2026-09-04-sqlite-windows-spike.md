# SQLite Windows 控制面验证

日期：2026-09-04

## 决策

统一 Runtime 控制面采用 Node 内置 `node:sqlite` 的同步 `DatabaseSync` API，最低 Node 版本收紧为 `22.13.0`。不增加原生扩展依赖；SQLite 只保存任务协调元数据，Prompt、大响应和产物仍保存到受控文件目录。

选择理由：

- Node 官方从 22.13.0 起取消 `--experimental-sqlite` 启动参数要求。
- 无需为 Windows 干净安装编译或下载第三方原生扩展。
- 本机 Node 24/Windows 对 WAL、事务回滚、多进程唯一约束和进程强杀恢复的实测满足控制面最低需求。

限制：本机没有 Node 22 可执行文件，因此 Node 22.13+ 的并发行为尚未在本机实测。进入发布门禁前必须在 Node 22 Windows CI 或独立主机上运行同一脚本；不能把 Node 官方 API 可用性当作该版本并发测试已经通过。

参考：

- https://nodejs.org/api/sqlite.html
- https://nodejs.org/download/release/v22.13.1/docs/api/sqlite.html

## 实测命令

```powershell
node scripts/sqlite-spike.mjs
```

实测环境和结果：

```json
{
  "ok": true,
  "node": "v24.13.0",
  "platform": "win32-x64",
  "sqlite": "3.50.4",
  "journal_mode": "wal",
  "rollback_count": 0,
  "concurrent_processes": 32,
  "child_failures": [],
  "unique_rows": 1,
  "crash_recovery_rows": 1
}
```

运行时仍显示 ExperimentalWarning。该警告需要记录，但不改变验证结果；发布说明必须明确 Node 版本约束和 `node:sqlite` 的稳定性状态。
