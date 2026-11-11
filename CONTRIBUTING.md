# 开发与交付

## 本地环境

使用 Python 3.12–3.14、uv 和 Node.js。Node 只用于前端语法检查，产品不依赖 Node。macOS 原生编译另需 Swift 工具链；Linux 可运行服务与不接触桌面的协议测试。

```sh
make sync
make check
```

`make check` 同步开发依赖，运行 Python lint、格式与测试、前端语法检查，并构建源码包与 wheel 做冒烟检查。外置卷可能产生 AppleDouble 文件，可把虚拟环境和缓存放到本机 APFS：

```sh
export UV_PROJECT_ENVIRONMENT="$HOME/Library/Caches/aBridge/dev-venv"
export UV_CACHE_DIR="$HOME/Library/Caches/aBridge/uv-cache"
make sync
```

Mac 上需要核对真实 SDK 时显式安装可选依赖：

```sh
uv sync --locked --extra dev --extra macos
uv run --no-sync pytest -q tests/sdk/test_cua_native_contract.py
```

该检查仅构造内嵌 SDK、读取诊断并关闭，不截图、输入或启动浏览器。默认开发与服务安装不选择 `macos` extra；`make sync` 会恢复默认开发依赖组。

## 修改范围

- `abridge/` 是运行代码，`native/` 是 Mac 壳与构建，`deploy/` 是明确调用的安装工具。
- 修改前阅读架构。能力与工具映射使用 `protocol.py` 单源；服务端不能导入设备驱动的原生库。
- 保留权限交集、操作去重、取消和结果未知语义。Cua 同进程入口、会话引用、10 秒有效期和清理路径须有边界验证。
- 浏览器只使用自建临时 profile；合成 DOM 点击不得静默替换为其他输入路由。依赖修复与授权入口仅在本机。
- 用 `make format` 统一 Python 格式。测试验证关键外部行为，不复制实现；新增变化或失败才扩大、重复测试范围。
- 未接通驱动与能力进入 roadmap，不能用协议占位冒充功能。实现完成与业务验收完成分开报告。

## 手工验收


需要前台、系统权限或真实账号的检查由操作者协调，不进入无人值守 CI。只使用自有 fixture，不读个人文档或聊天。核对模型实际工具调用、动作后观察和 fixture 状态，再记录结论；验证码不得提前放入模型提示。具体流程见 [Yuxi 接入](docs/yuxi-integration.md)。

## 版本与构建

版本只在 `abridge/__init__.py` 修改。Python 元数据、服务响应、设备握手与原生包读取同一值。

```sh
make build
python3 native/build.py --output /tmp/aBridge.app \
  --python "$(uv run --no-sync python -c 'import sys; print(sys.executable)')" --project "$PWD"
```

原生构建校验签名；输入不变时不重编、不重签。`--force` 强制重建，`--signing-identity` 指定已有证书。默认 ad hoc 用于内部本机交付，不能当作公证分发。

交付前更新变更记录、执行 CI 同等检查，并核对源码包、wheel、第三方许可与安装路径。CI 不持有用户凭据，也不自动部署或外部发布。

## 本机资料

`.local/` 用于安装笔记、历史证据和调研下载，不进入 Git 或发行包。自动化测试使用虚构身份；不要提交凭据、设备 Key、真实操作载荷或个人截图。
