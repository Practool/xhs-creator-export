# XHS Creator Export

**小红书创作者数据一键导出到 Excel / CSV / JSON。**

小红书创作者数据导出器。使用 Playwright，自动采集**自己账号**在小红书创作服务平台当前可见的视频与图文笔记分析数据，整理为可分析、可备份的本地文件。

[![Node.js 24](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/en/download)
[![MIT License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

## 核心功能

- **批量导出**：自动筛选日期、翻页，采集内容表现和互动指标。
- **多种格式**：生成 Excel 总表、CSV、JSON 和完整 ZIP 数据包。
- **原始资料**：保存适用的官方导出文件与观看趋势截图。
- **断点续采**：中断后继续、失败项重试、已有数据重新导出。

> 仅处理自己账号可访问的数据。内容、指标和日期范围以平台实际提供的功能为准。

## 快速开始

**需要：** Node.js 24、npm，以及 Google Chrome 或 Playwright Chromium。

### 1. 安装

目前尚未配置公开 GitHub 远端或发布 Releases。以源码安装为主要方式：获得本项目源码并解压，在项目目录的终端执行：

```sh
npm ci
npm run build
node dist/cli.js init
node dist/cli.js doctor
```

没有 Chrome 时先执行 `npx playwright install chromium`。运行版 ZIP 的使用方法与发布状态见[安装教程](docs/getting-started.md)。

### 2. 登录自己的账号

```sh
node dist/cli.js login
```

在独立浏览器窗口中完成登录；扫码、账号密码及验证码由你自行处理。

### 3. 导出数据

日期需按自己的需求替换；包含起止当日，使用上海时区：

```sh
node dist/cli.js collect --from 2026-10-01 --to 2026-10-15

# 或采集平台当前允许的完整日期范围
node dist/cli.js collect
```

结束后终端显示任务 ID 和结果目录，默认位于 `.xhs-creator-export/jobs/<任务ID>/`。

## 你会得到什么

| 输出 | 用途 |
| --- | --- |
| `小红书笔记分析总表.xlsx` | 一篇笔记一行的 Excel 汇总 |
| `笔记分析总表.csv` | CSV 分析与工具导入 |
| `content-data.json` | 结构化数据、来源和产物索引 |
| `official/` | 平台官方导出文件 |
| `core-view-trends/`、`trends/` | 适用的观看趋势截图 |
| `validation.json` | 完整性、缺失项和警告报告 |
| `<任务目录名>.zip` | 与任务目录同名的本批次打包归档，文件名包含任务日期 |

平台不适用、数据不足与采集失败分别记录；**缺失值不自动写成 0**。

## 续采与重试

```sh
node dist/cli.js status
node dist/cli.js resume YOUR_JOB_ID
node dist/cli.js retry YOUR_JOB_ID
node dist/cli.js export YOUR_JOB_ID
```

将 `YOUR_JOB_ID` 替换为实际任务 ID。默认显示采集浏览器；需要后台运行时见[无界面配置](docs/configuration.md)。当前不会在无界面模式遇到验证时自动打开窗口。

## 跨批次历史（本地 v0.3 开发版，尚未发布）

新增离线手动历史同步、修订审计与 CSV / Excel / JSON 导出，原采集命令继续使用。首次同步需明确账号别名，详见[历史数据说明](docs/history-data.md)及[指标映射](docs/metric-mapping.md)。

```sh
node dist/cli.js history sync --account my-creator-account
node dist/cli.js history verify
node dist/cli.js history export --account my-creator-account
```

## 文档

- [安装与首次使用](docs/getting-started.md)
- [命令行参考](docs/cli-reference.md)
- [配置选项](docs/configuration.md)
- [输出文件与数据口径](docs/output-files.md)
- [常见问题与故障排查](docs/troubleshooting.md)
- [隐私与使用说明](docs/privacy.md)

## 隐私与声明

本项目是非官方独立工具，与小红书不存在官方授权或关联。仅导出自己账号正常可访问的数据，不绕过登录、验证码或访问限制；使用时请遵守适用的平台规则。

登录状态与结果保存在本地。**不要公开上传 `.xhs-creator-export/`、个人配置、会话、账号信息或真实导出文件。**

## License

[MIT License](LICENSE) · [第三方依赖说明](docs/dependencies.md)
