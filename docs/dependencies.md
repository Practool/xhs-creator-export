# XHS Creator Export：第三方依赖与许可证

本页面向使用和分发程序的用户，说明第三方运行依赖及许可证。产品采用 MIT，依赖保留各自许可证；`package-lock.json` 固定实际版本，安装包内包含各自许可证文件。

| 运行依赖 | 已安装版本 | 许可证 |
| --- | --- | --- |
| playwright | 1.64.1 | Apache-2.0 |
| better-sqlite3 | 12.11.1 | MIT |
| exceljs | 4.4.0 | MIT |
| archiver | 7.0.1 | MIT |
| sharp | 0.35.5 | Apache-2.0 |
| commander | 14.0.3 | MIT |
| yaml | 2.9.1 | ISC |
| zod | 4.6.7 | MIT |

sharp 的平台二进制涉及 libvips 等组件，各组件保留其许可证（包括 LGPL）；本项目通过 npm 获取原始包，不重新打包这些二进制。浏览器通过用户安装的 Chrome 或 Playwright 安装获取，不随发布包分发。发布包只包含本项目编译产物，不捆绑 node_modules。

[返回 README](../README.md)
