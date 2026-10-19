# XHS Creator Export：命令行参考

本页面向已安装并完成首次初始化的用户。命令入口为 `node dist/cli.js`，首次使用见[安装教程](getting-started.md)。

## 命令与选项

所有命令在安装目录运行。将 `YOUR_JOB_ID` 和 `YOUR_NOTE_ID` 替换成实际 ID：

| 命令 | 作用 |
| --- | --- |
| `node dist/cli.js init` | 生成默认配置，不覆盖已有文件 |
| `node dist/cli.js doctor` | 检查 Node、浏览器、目录及 SQLite |
| `node dist/cli.js doctor --launch` | 额外启动并关闭专用浏览器检查，不登录 |
| `node dist/cli.js login` | 可见窗口交互登录或处理验证码 |
| `node dist/cli.js collect` | 创建批次，采集平台允许的完整日期范围 |
| `node dist/cli.js collect --from YYYY-MM-DD --to YYYY-MM-DD` | 按指定日期创建批次并采集 |
| `node dist/cli.js status` | 最近任务状态 |
| `node dist/cli.js status YOUR_JOB_ID` | 指定任务状态、错误及输出位置 |
| `node dist/cli.js resume YOUR_JOB_ID` | 核对已存产物，继续未完成内容 |
| `node dist/cli.js retry YOUR_JOB_ID` | 补采未完成或核对后发现损坏的内容 |
| `node dist/cli.js retry YOUR_JOB_ID --note YOUR_NOTE_ID` | 强制重采原批次中的指定笔记 |
| `node dist/cli.js export YOUR_JOB_ID` | 从已有数据重新生成总表、报告和 ZIP |
| `node dist/cli.js --config my-config.yaml collect` | 使用指定配置，适用于其他子命令 |
| `node dist/cli.js --help` | 全局帮助 |
| `node dist/cli.js collect --help` | 子命令帮助 |
| `node dist/cli.js --version` | 当前版本 |

`--from`、`--to` 必须同时提供有效日期，包含起止日，使用上海时区。无日期时读取平台允许的边界，不固定为六个月；无法可靠识别时要求指定日期。

`resume` 与不带 `--note` 的 `retry` 都会核对已有文件，跳过验证完成的笔记；`retry` 面向补采，支持通过 `--note` 强制重采指定笔记。账号、日期和目录核对条件不因重试而取消；任务结束前还会重新核对目录。使用官方导出失败的笔记 ID 加 `--note`，才能明确要求重采已完成但有警告的该篇。

`export` 不打开浏览器、不下载新数据；核对文件，并从已保存响应重建数据行。它也会更新旧批次的可读产物命名。文件缺失时可能导出部分结果，不等于修复缺失产物；需执行 `resume`。

## 停止与恢复

一次 `Ctrl+C` 请求安全停止，已验证且提交数据库的笔记保留；未完成的当前笔记不能视为已保存成功。第二次 `Ctrl+C` 强制退出，重启后用 `resume` 核对进度与文件大小、SHA-256，缺失或损坏的内容重采。

可见模式遇到登录或验证码，在专用窗口中处理后继续。无界面模式遇到相同情况保存进度并退出，执行 `login` 后再 `resume`，不会自动切换可见窗口。所有命令应使用同一[配置与登录目录](configuration.md)。

## 任务状态与退出码

| 状态 | 含义 |
| --- | --- |
| `running` | 正在执行 |
| `waiting_for_user` | 需要登录或验证；无界面模式退出后等待处理 |
| `partial` | 必要采集未完整，或账号、范围、目录核对未通过；不是完整成功 |
| `complete_with_warnings` | 必要采集完成，但官方导出等存在警告 |
| `complete` | 完整完成 |
| `cancelled` | 已请求停止，可续采 |

退出码 `0` 为正常结束（可能包含官方导出警告），`1` 为错误，`2` 为采集命令返回部分完成，`130` 为用户停止。不要仅凭退出码认定无缺失，结合 `status` 和 `validation.json` 检查。[输出说明](output-files.md)解释报告用途。

## 旧 JSON 转换

```sh
node dist/cli.js export --legacy /path/to/content-data.json --out /path/to/converted
```

旧 JSON 同目录需包含其引用的官方文件和截图；`--out` 仅用于此旧数据转换。旧 JSON 不转为可续采任务，建议明确指定不同输出目录，避免覆盖原文件。不要与任务 ID 同时使用 `--legacy`。

[返回 README](../README.md)

## 历史命令（v0.3 本地开发版）

沿用全局 `-c, --config` 参数；每个命令均可加 `--help`。历史功能不访问平台、不启动浏览器。

| 命令 | 作用 |
| --- | --- |
| `node dist/cli.js history sync --account my-creator-account` | 首次绑定账号别名并扫描配置 outputDir；只读原 Job |
| `node dist/cli.js history sync --job YOUR_JOB_ID` | 只同步某个已经绑定账号的 Job |
| `node dist/cli.js history status` | 统计历史快照并显示最近同步结果；不创建缺失的库 |
| `node dist/cli.js history verify` | 检查结构、外键、唯一约束和业务指纹；不自动修复 |
| `node dist/cli.js history export --account my-creator-account` | 导出当前有效版本的五种历史产物 |

`history export` 可加 `--all-accounts` 明确允许多账号（不能与 `--account` 同用）、`--include-revisions` 查看旧有效版本、`--include-invalid` 包含被拒绝版本的审计视图、`--output NEW_PRIVATE_DIRECTORY` 指定尚不存在的私人目录。默认不覆盖现有输出。

历史命令退出码：0 成功；1 配置/数据库/输出失败；2 部分 Job 失败、记录隔离或 verify 异常；130 安全中断。无错误但指标窗口未知等警告保存在 QC 中，不改变原任务状态。详情见[历史数据](history-data.md)。
