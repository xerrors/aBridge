# aBridge Linux CLI

用 Linux CLI 将开发机或服务器接入 aBridge，供 Agent 执行 Shell 和文件任务。客户端可以在无图形环境的机器上运行。Shell 和文件操作使用启动客户端的账户权限。

## 安装与绑定

从 GitHub Release 下载与机器架构对应的 Linux 包和同版本的 `SHA256SUMS`。在下载目录校验安装包后解压。在管理台创建电脑设备，取得 Device Token：

```sh
sha256sum --check --ignore-missing SHA256SUMS
tar -xzf abridge-client-<version>-<target>.tar.gz
./abridge-client setup --url https://bridge.example.com
./abridge-client service install
```

从 CI artifact 或旧版 Release 下载时，使用同名的 `.tar.gz.sha256` 进行校验。

`setup` 隐藏输入 Device Token，先向 Server 验证设备类型，再原子保存绑定。非交互绑定可使用 `setup --stdin`，从受保护的标准输入读取 JSON：`url`、`device_key`、可选的 `capabilities`（`shell/files` 布尔开关）和 `http_confirmed_origin`。不要把 Token 放进命令行参数或日志。默认开启设备已获授权的 Shell/File 能力。

推荐 HTTPS/WSS。交互式绑定到远程 HTTP 时，终端会显示完整 Origin 和明文传输提示。输入 `y` 确认后再输入 Device Token，直接回车会取消。通过 `setup --stdin` 绑定远程 HTTP 时，须在 JSON 中填写完全匹配的 `http_confirmed_origin`。HTTPS 和回环 HTTP 无需额外确认。系统须提供 `/bin/sh` 和可信 CA 证书。

## 后台服务

`service install` 将当前可执行文件复制到 `~/.local/lib/abridge-client/abridge-client`，创建并启动当前用户的 `abridge-client.service`。无需 root，日志由 journald 管理。要在退出 SSH 后继续运行，并在开机时无需登录就启动，可使用：

```sh
./abridge-client service install --linger
```

`--linger` 向 `loginctl enable-linger` 显式传入当前 UID，无需登录会话；能否执行取决于系统授权策略。客户端不自动调用 sudo。没有 systemd 的环境可以使用 `run`，由现有进程管理器保持前台进程运行。

```sh
~/.local/lib/abridge-client/abridge-client status
~/.local/lib/abridge-client/abridge-client pause
~/.local/lib/abridge-client/abridge-client resume
~/.local/lib/abridge-client/abridge-client capability shell off
~/.local/lib/abridge-client/abridge-client logs
systemctl --user restart abridge-client.service
```

暂停和能力开关持久化；自动重连或服务重启不会恢复被暂停的访问。`stop` 停止当前操作，`systemctl --user stop abridge-client.service` 停止后台客户端。断线后建立新会话，结果未知的操作不会自动重放。

后台服务从 systemd 继承环境。需要特定工作目录、可执行文件或虚拟环境时，请用绝对路径，或在请求中显式设置 `cwd` 和 `env.PATH`。

默认状态目录是 `$XDG_DATA_HOME/abridge/linux-client` 或 `~/.local/share/abridge/linux-client`，绑定文件权限为 `0600`、目录为 `0700`。`--state-dir /absolute/path` 可用于独立实例的配置与前台运行。实际路径加上 `/control.sock` 须符合本机 Unix socket 路径长度限制，绑定时会校验。用户级服务固定为一个 `abridge-client.service`，再次安装时使用指定状态目录。卸载服务：

```sh
~/.local/lib/abridge-client/abridge-client service uninstall
```

卸载服务会保留绑定和操作去重记录。手动更新时先停止当前任务，再用新版二进制执行 `service install`，沿用原状态目录。

## 从源码构建

开发需要 Node/npm 和 Rust 1.100.0（含 rustfmt、clippy）；安装后的客户端不需要这些工具。

```sh
npm install
npm run linux:build
npm run linux:check
npm run package:linux -- --target aarch64-unknown-linux-musl
```

构建从 `packages/protocol/src/` 导出需要的契约到 `build/linux-client/contract.json`，在编译时嵌入。产品版本来自根 `package.json`；Rust 清单中的 `0.0.0` 只是内部包标记。依赖使用提交的 `Cargo.lock`，常规构建均使用 `--locked`。

`linux:build` 产出 `dist/linux-client/<target>/abridge-client`；`package:linux` 产出 `dist/releases/` 下的 `.tar.gz`、SHA-256 和体积报告。打包强制检查二进制不超过 15 MiB、完整下载包不超过 5 MiB，并保留依赖许可。macOS 可以执行单元测试和本机开发构建，但不能将 macOS 文件当作 Linux 产物。

正式候选在 Linux amd64/arm64 原生 runner 上以 musl 静态链接构建，不依赖宿主 glibc 版本。Ubuntu/Debian 构建机先安装 `musl-tools`，用 `rustup target add aarch64-unknown-linux-musl` 添加 ARM64 目标；amd64 使用 `x86_64-unknown-linux-musl`。必要时设置对应的 `CC_aarch64_unknown_linux_musl=musl-gcc` 和 `CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=musl-gcc`（amd64 替换架构名）。CI 验证产物没有 ELF 动态解释器或动态库依赖。用户运行仍需要 Shell 和 CA 证书。

交叉构建可传 `-- --target <Rust target>`，须预先安装相应 Rust target 和链接器；打包器不会自动修改系统工具链。GNU 目标需要兼容的 glibc，musl 目标可用于减少该依赖；以实际目标的运行验证为准。
