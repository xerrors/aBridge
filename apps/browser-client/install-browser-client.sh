#!/usr/bin/env bash
# aBridge Linux 浏览器安装器。发布时写入对应的版本和包摘要。
set -euo pipefail

usage() {
    printf '%s\n' '用法：bash install-browser-client.sh [https://bridge.example.com]'
}

main() {
    if [[ ${1:-} == --help ]]; then
        usage
        exit 0
    fi
    if (( $# > 1 )); then
        usage >&2
        exit 2
    fi
    local version='@VERSION@'
    local archive_sha256='@ARCHIVE_SHA256@'
    if [[ ! $archive_sha256 =~ ^[a-f0-9]{64}$ ]]; then
        printf '%s\n' '请从 aBridge 的 GitHub Release 下载生成的安装脚本。' >&2
        exit 2
    fi
    # Bash 从下载管道读取脚本，交互输入单独走控制终端。
    if ! { exec 3<> /dev/tty; } 2>/dev/null; then
        printf '%s\n' '请在交互终端运行。通过 SSH 执行时请分配终端（ssh -t）。' >&2
        exit 2
    fi
    local origin=${1:-}
    if [[ -z $origin ]]; then
        printf '%s' 'aBridge HTTPS 地址：' >&2
        if ! IFS= read -r origin <&3; then
            exit 2
        fi
    fi
    origin=${origin%/}
    origin=${origin,,}
    origin=${origin%:443}
    if [[ ! $origin =~ ^https://([a-z0-9.-]+|\[[a-f0-9:]+\])(:[0-9]{1,5})?$ ]]; then
        printf '%s\n' '请输入 aBridge 的 HTTPS 根地址。' >&2
        exit 2
    fi
    if (( EUID == 0 )) || [[ $(uname -m) != x86_64 ]] || ! command -v apt-get >/dev/null; then
        printf '%s\n' '请在 Ubuntu 或 Debian amd64 上使用可运行 sudo 的普通账号。' >&2
        exit 1
    fi

    local archive="abridge-client-browser-${version}-linux.tar.gz"
    local install_dir="$HOME/.local/lib/abridge-client-browser-$version"
    local python="$install_dir/.venv/bin/python"
    local client="$install_dir/abridge-client-browser"
    umask 077
    mkdir -p "$install_dir"
    exec 9>"$install_dir/.install.lock"
    flock 9

    if [[ ! -f "$install_dir/.installed" || ! -x "$python" || ! -x "$client" ]]; then
        sudo apt-get update
        sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl python3-venv
        (
            download_dir=$(mktemp -d)
            trap 'rm -rf -- "$download_dir"' EXIT
            cd "$download_dir"
            curl --proto '=https' -fLSs -o "$archive" "https://github.com/xerrors/aBridge/releases/download/v$version/$archive"
            printf '%s  %s\n' "$archive_sha256" "$archive" | sha256sum --check -
            tar -xzf "$archive" --strip-components=1 -C "$install_dir"
        )
        python3 -m venv "$install_dir/.venv"
        "$python" -m pip install -r "$install_dir/requirements.txt"
        sudo env DEBIAN_FRONTEND=noninteractive "$python" -m playwright install-deps chromium
        "$python" -m playwright install --no-shell chromium
        touch "$install_dir/.installed"
    fi

    local status state
    status=$("$python" -I "$client" status)
    state=$("$python" -I -c '
import json
import sys

status = json.loads(sys.argv[1])
if status["status"] != "unbound" and status["browser_origin"] != sys.argv[2]:
    sys.exit("当前浏览器已绑定其他 aBridge 地址，请核对地址和运行账号。")
if status["status"] == "running" and not status["connected"]:
    sys.exit("浏览器进程已启动，正在等待连接。请在 aBridge 设备页检查在线状态。")
print(status["status"])
' "$status" "$origin")
    if [[ $state == unbound ]]; then
        "$python" -I "$client" bind --server "$origin" <&3
    elif [[ $state == running ]]; then
        printf '%s\n' '浏览器已连接到 aBridge。'
        exit 0
    fi

    printf '%s\n' '正在前台启动浏览器。请保持此终端打开，并在 aBridge 确认设备在线。'
    exec 9>&-
    exec "$python" -I "$client" run <&3 3>&-
}

main "$@"
