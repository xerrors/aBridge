# 开发与交付

## 本地环境

使用 Python 3.12–3.14、uv 和 Node.js。macOS 原生编译另需 Swift 工具链；Linux 可运行服务和自动化协议测试。

```sh
make sync
make check
```

外置卷可能生成 AppleDouble 文件并干扰依赖安装。可把虚拟环境与缓存放到本机 APFS 目录：

```sh
export UV_PROJECT_ENVIRONMENT="$HOME/Library/Caches/aBridge/dev-venv"
export UV_CACHE_DIR="$HOME/Library/Caches/aBridge/uv-cache"
make sync
```

## 修改范围

- `abridge/` 是运行代码；`native/` 是 Mac 壳与构建；`deploy/` 是明确调用的安装工具。
- 阅读架构后再跨模块修改。保留权限交集、操作去重、取消与结果未知的语义。
- 用 `make format` 统一 Python 格式。测试验证外部行为或关键边界，不复制实现逻辑。
- 未接通驱动和能力进入 roadmap，不能用协议占位冒充功能。
- 真实 Agent 调试使用 Yuxi。需要前台、系统权限或真实账号的检查不进入无人值守 CI。

## 版本与构建

版本只在 `abridge/__init__.py` 修改。Python 元数据、服务响应、设备握手和原生包读取同一值。

```sh
make build
python3 native/build.py --output /tmp/aBridge.app \
  --python "$(uv run --no-sync python -c 'import sys; print(sys.executable)')" --project "$PWD"
```

原生构建校验签名；输入不变时不重编、不重签。`--force` 用于重新构建；`--signing-identity` 可指定已有证书。默认 ad hoc 用于本机构建，不能当作公证分发。

发布前更新变更记录、执行 CI 同等检查，并核对发行包和安装路径。正式签名、公证、托管发布和自动更新尚未建立，不把本机测试包标为正式安装包。

## 本机资料

`.local/` 用于安装笔记、历史验证证据和调研下载，不进入 Git 或发行包。测试使用虚构身份；不要提交凭据、设备 Key、真实操作载荷或个人截图。
