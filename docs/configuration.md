# XHS Creator Export：配置选项

本页面向需要调整浏览器、输出路径和恢复预算的用户。配置示例见 [config.example.yaml](../config.example.yaml)，默认值以当前源码为准。

## 配置文件与路径

`node dist/cli.js init` 在当前目录创建 `xhs-creator-export.yaml`，不会覆盖已有文件。登录状态、任务数据库和默认输出保存在 `.xhs-creator-export/`。

路径相对于 YAML 文件所在目录解析，不相对于当前终端目录。选择其他配置时，全局选项置于命令前：

```sh
node dist/cli.js --config my-config.yaml collect
```


## 全部默认值

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `browser` | `auto` | `auto` / `chrome` / `chromium` |
| `profileDir` | `.xhs-creator-export/profile` | 专用登录目录 |
| `outputDir` | `.xhs-creator-export/jobs` | 结果目录 |
| `databasePath` | `.xhs-creator-export/tasks.sqlite` | 任务进度数据库 |
| `headless` | `false` | 是否隐藏自动化浏览器 |
| `dateStrategy` | `platform` | 自动识别平台日期范围 |
| `intervalMs` | `2000` | 笔记间隔，毫秒；允许 0–60000 |
| `operationTimeoutMs` | `30000` | 页面操作超时，毫秒；允许 1000–300000 |
| `downloadTimeoutMs` | `60000` | 下载超时，毫秒；允许 1000–300000 |
| `stepRetries` | `2` | 单步骤额外重试次数，允许 0–5 |
| `noteRestarts` | `1` | 单篇详情重新打开次数，允许 0–2 |

未列出的配置键会被拒绝。`dateStrategy` 当前仅支持 `platform`；显式日期通过 `collect --from ... --to ...` 指定。

## 方便查找的输出目录

修改配置中的对应字段，或以此作为部分配置（省略项使用默认值）：

```yaml
outputDir: downloads
headless: false
```

新任务结果写入配置目录旁边的 `downloads`。已有任务的输出目录不要随意改变，否则续采可能找不到产物。

## 无界面采集

先用相同配置执行 `login`，再设置：

```yaml
headless: true
```

正常采集不显示窗口。`login` 始终使用可见窗口；无界面采集遇到登录过期或验证码会保存进度，标为 `waiting_for_user` 并退出，不会自动弹出窗口。执行 `login` 后再 `resume YOUR_JOB_ID`。详细步骤见[故障排查](troubleshooting.md)。

不要将专用 profile 指向日常 Chrome 目录，不要并行运行使用同一 profile 的任务。个人配置不应公开提交，更多内容见[隐私说明](privacy.md)。

[返回 README](../README.md)
