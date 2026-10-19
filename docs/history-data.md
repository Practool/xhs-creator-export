# 跨批次历史数据（v0.3 本地开发版）

历史层只读取现存 Job，不登录或发起平台请求；`collect` 不会自动同步。原配置、任务库、Job ID、续采和单 Job 导出保持原有语义。当前默认配置为 `xhs-creator-export.yaml`；已有旧名配置仍可通过 `-c` 显式指定，无需迁移。

## 使用

在安装目录运行，实际私人配置可用全局 `-c /path/to/config.yaml` 指定：

```sh
node dist/cli.js history sync --account my-creator-account
node dist/cli.js history status
node dist/cli.js history verify
node dist/cli.js history export --account my-creator-account
node dist/cli.js history sync --job YOUR_JOB_ID
```

首次同步每个 Job 必须提供账号别名；现有 identityHint 是页面文字，不能替代稳定平台账号 ID。别名由用户明确确认归属，不能自动证明两个历史文件属于同一账号。Job 绑定后可以省略别名；后续显式别名或已有账号文字证据冲突会被拒绝。账号隔离键为 `(account_scope, note_id)`；当前作用域前缀为 `alias:`。不同账号可能有相同笔记 ID。

默认扫描配置 `outputDir` 下一层 Job 目录，只读取 `content-data.json`（最大 32 MiB）与可选 `validation.json`（最大 4 MiB）；不读取 profile 或任务库。只接受实际 schemaVersion 4，或缺少版本但结构相同的旧文件；更旧或不明结构记录错误，不猜测转换。符号链接、越界路径、读取中变化、重复 ID 和冲突引用都受到检查。单 Job 失败不影响其他 Job，缺少的源 Job 不会删除历史。

## 时间、修订和质量

- `published_at_utc` 是发布时间；来自原详情 post_time 毫秒值、目录 post_time 或原上海时区文本。
- `observed_at_utc` 优先逐篇 `snapshot.capturedAt`，其次原 `row.采集时间`。这些用 `note_time` 标记。
- 仅有 `job.finishedAt/createdAt` 时标 `job_time_approx`；原始时间未知时保留 NULL 与 `unknown`。不使用容易被重导出更新的 job.updatedAt，也不使用导入时间补齐。
- `timestamp_source`、原始时间和 `imported_at` 分别保留。UTC ISO 与上海无时区行文本的转换有明确来源；任意无时区 ISO 不会被当作本机时区解析。
- 不同 Job 永远是不同观测，即使同日且数值相同。同一 Job 单篇业务内容改变时追加 revision；指纹不变则 `SKIPPED_UNCHANGED`。源 JSON 字节指纹与业务指纹分别保存，文件时间、ZIP、重导出时间、附件改名不制造业务修订。
- 同一账号 / Job / 笔记默认只有一个当前有效版本。坏修订以 `needs_review` 保留，但不会撤销上一有效版本；通过 `--include-invalid` 查看。`--include-revisions` 查看全部有效修订。
- partial/cancelled 等全局状态不决定已完成逐篇观测是否可用。缺 ID 记录隔离到同步 QC；不生成假 ID。缺时间记录可导出，但不能伪装成严格时间序列。

当前代码只能证实日期筛选限制笔记发布时间，尚无可靠证据说明详情指标属于累计还是选定周期，因此全部指标 `metric_scope=unknown`、`window_start/window_end=NULL`。不进行增长计算、插值、D+1/D+7 推断。详见[映射规则](metric-mapping.md)。

## 存储合同

`history.sqlite` 与配置 `databasePath` 同目录，完全独立于 tasks.sqlite；默认导出在同级 history-exports。不能把任务库自身命名为 history.sqlite。只有手动 sync 会初始化历史库，status/verify/export 不创建缺失库。

历史 Schema 为 **1**，使用 SQLite `user_version` 和 history_schema 双重版本记录。当前仅支持新库初始化与已有 v1；未知结构或更高版本直接拒绝，不执行无备份迁移。未来升级必须实现备份、事务迁移与失败恢复。

| 表 | 约束与作用 |
| --- | --- |
| `history_schema` | 迁移版本与应用时间 |
| `accounts` | account_scope 主键，明确别名来源 |
| `job_bindings` | job_id 唯一且不可静默改绑，账号证据仅保存哈希 |
| `notes` | `(account_scope,note_id)` 主键 |
| `import_runs` | 每次同步开始/结束与 QC 摘要；中断运行可识别 |
| `source_imports` | 各 Job 源指纹、私人路径、结果与失败原因 |
| `note_snapshots` | `(account_scope,note_id,job_id,revision)` 唯一；当前版本部分唯一索引 |
| `metric_observations` | `(snapshot_id,metric_key)` 主键与外键，扩展型指标 JSON body |

SQLite 外键开启、写入 busy timeout 1 秒、WAL。每 Job 绑定、修订切换、指标插入和成功来源记录同一事务完成。失败来源记录在事务外保存；CLI 中断按已提交 Job 恢复，未提交事务回滚。`verify` 检查完整性、外键、当前索引、账号绑定与业务指纹，不自动修改数据。

## 导出合同

`history export` 生成长表、宽表、Excel、JSON 与 QC 五个文件，所有文件先写入私人临时目录，校验完成后整体原子重命名。自定义 `--output` 必须是新目录；公共 Git 路径和符号链接被拒绝。失败或安全中断清理临时目录；异常杀进程可能留下 `.history-export-*.tmp`，它不是有效的完成导出。

长表标准列：account_scope、note_id、job_id、snapshot_id、revision、observed_at_utc、time_precision、published_at_utc、metric_key、value、value_type、unit、value_status、quality_status、source_kind、metric_scope、window_start、window_end；另含 source_field_path、metric_schema_version、timestamp_source、imported_at 和双指纹。状态与单位参考指标映射。

宽表默认每 `(account_scope,note_id,job_id)` 当前有效版本一行，主要指标机器键为列名，状态在长表。审计导出增加 snapshot_id/revision 区别；未知扩展字段在 history.json 的 unmapped_fields 保留，不伪装成已定义指标。百分数点 26.9 在 CSV/JSON 保存为 26.9，Excel 保存为 0.269 并使用 0.00% 格式。CSV 防公式解释，Excel 单元格只写原始值。

多账号默认要求 `--account`；确需合并时显式 `--all-accounts`，每行始终保留账号作用域。默认只选当前有效版本，`--include-revisions` 与 `--include-invalid` 是明确审计选项。QC 包含筛选范围、账号、Job/笔记/快照/指标数量、无时间/近似时间/未知统计窗口数量、拒绝修订、排除数量与最近同步问题。

Excel 任一表超过 1,048,575 条数据行时明确失败，不截断。v0.3 不保证未经测量的大规模性能，导出内存需求随指标总数增长。历史库可从原件重建，但账号别名绑定必须先保留；不要为了排错删除数据库。
