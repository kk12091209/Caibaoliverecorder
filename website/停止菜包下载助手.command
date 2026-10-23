#!/bin/zsh
set -eu
tool_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$tool_dir"
tool_pid="$(lsof -tiTCP:17970 -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
if [[ -z "$tool_pid" ]]; then print '菜包下载助手已停止。'; exit 0; fi
tool_command="$(ps -p "$tool_pid" -o command=)"
if [[ "$tool_command" != *scripts/dev-downloader.mjs* ]]; then print '该端口由其他程序使用，未停止它。'; read -r '?按回车关闭'; exit 1; fi
tool_parent="$(ps -p "$tool_pid" -o ppid= | tr -d ' ')"
parent_command="$(ps -p "$tool_parent" -o command= || true)"
if [[ "$parent_command" == *node*--watch*scripts/dev-downloader.mjs* ]]; then kill -TERM "$tool_parent"; else kill -TERM "$tool_pid"; fi
print '菜包下载助手已停止。'
