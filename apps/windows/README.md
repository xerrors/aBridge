# Windows PC 客户端

独立 Rust 原生运行时与 Win32 托盘界面，提供截图、前台键鼠输入、Shell 和文件能力，直接连接现有 Server。完整便携目录小于 10,000,000 字节，不分发 Node 或 WinUI 运行库。

**[下载、安装、连接、更新与源码构建指南](../../docs/windows-client.md)**

- `src/`：此前 TypeScript 实现与 Windows 驱动参考，供行为对照使用。
- `windows-native-shell/`：Win32 界面及 Rust 设备连接、授权、状态、操作调度与执行；界面和运行时通过私有 stdio 通信。
- `tests/`：协议、授权、取消、Windows 执行与壳回归测试。
- `../../tools/package-windows.ts`：生成包含运行时的未签名 x64 便携包。
- `../../tools/check-windows-package.ts`：校验 ZIP、校验和、文件边界和仓库外独立启动。
