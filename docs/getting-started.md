# XHS Creator Export：安装与首次使用

本页面向第一次使用小红书创作者数据导出器的用户。安装、登录和首次采集均在本地完成；先准备自己的平台账号。

## 环境要求

安装 [Node.js 24](https://nodejs.org/en/download)、npm 和 [Google Chrome](https://www.google.com/chrome/)。在终端检查：

```sh
node --version
npm --version
```

Node.js 版本应以 `v24.` 开头。本项目要求 Node.js 24，其他大版本会被 CLI 拒绝。没有 Chrome 时，在安装项目依赖后执行：

```sh
npx playwright install chromium
```

Linux 如缺浏览器系统依赖，改用 `npx playwright install --with-deps chromium`。默认 `browser: auto` 优先使用已安装的 Chrome，否则使用已安装的 Playwright Chromium。

## 安装方式 A：源码（当前主要方式）

目前尚未配置公开 GitHub 远端，也未发布 Releases。获得本项目源码包后解压；将来上传仓库后也可使用 GitHub 的 **Code → Download ZIP** 或克隆真实仓库。在解压后的项目目录打开终端，Windows 可以使用 PowerShell：

```sh
npm ci
npm run build
node dist/cli.js init
node dist/cli.js doctor
```

后续命令都在同一项目目录运行。首次初始化生成 `xhs-creator-export.yaml`，已有配置不会被覆盖。`doctor` 检查 Node、浏览器可用性、目录和 SQLite，不进行账号登录。

## 安装方式 B：运行版 ZIP

本地构建脚本可生成 `release/xhs-creator-export-0.2.0.zip`，这不是已经发布的 GitHub 下载链接。当前没有可公开下载的 Release；待维护者实际发布运行版后，可下载该版本的真实 ZIP。运行版包含 `dist/cli.js`、锁文件及说明书，不包含 Node.js、浏览器或已安装依赖。

拿到运行版 ZIP 后解压，在解压目录执行，无需构建：

```sh
npm ci --omit=dev
node dist/cli.js init
node dist/cli.js doctor
```

安装依赖需要联网。若手中只有源码 ZIP，使用方式 A；不要跳过构建。

## 登录自己的账号

```sh
node dist/cli.js login
```

在独立浏览器中扫码或使用平台提供的账号密码登录，并自行处理验证码。确认登录后窗口自动关闭。默认登录状态保存在 `.xhs-creator-export/profile`，不使用日常 Chrome 个人资料，同一登录目录不能同时运行多个任务。

## 第一次采集

替换示例日期为自己需要的范围，起止日期必须同时提供，包含起止当日，使用上海时区：

```sh
node dist/cli.js collect --from 2026-10-01 --to 2026-10-15
```

或自动识别平台允许的完整日期范围：

```sh
node dist/cli.js collect
```

采集过程中不要手动切换自动化窗口中的账号、日期或图表。程序结束后核对终端的任务状态及完整性报告；`partial` 表示部分完成。

## 找到输出

终端显示任务 ID 和完整结果路径，默认是 `.xhs-creator-export/jobs/<任务ID>/`。macOS 可按 `Command + Shift + .` 显示隐藏目录，也可以直接打开终端显示的路径。为方便查找，可在 `xhs-creator-export.yaml` 中将 `outputDir` 改为 `downloads`；已有任务续采时应保留原路径。

先打开 Excel 总表或 `archive.zip`，同时查看 `validation.json` 的缺失和警告。[输出文件说明](output-files.md)解释各文件及数据口径。[命令参考](cli-reference.md)介绍停止、续采和重试。

## 原生模块安装失败

先确认 Node.js 为 24，并检查网络能否获取依赖与平台二进制。如果仍提示需要本机编译，按错误提示安装工具：macOS 的 Xcode Command Line Tools、Windows 的 Visual Studio C++ Build Tools，或 Linux 的 Python、make 和 C++ 编译器。编译工具并非所有用户的必装项。

安装检查只在 macOS 本地实际执行；仓库虽配置三平台构建流程，尚不能据此宣称 Windows、Linux 已完成真实平台采集验收。

其他问题见[故障排查](troubleshooting.md)。[返回 README](../README.md)
