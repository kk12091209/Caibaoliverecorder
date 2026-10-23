#!/bin/zsh
set -eu
tool_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$tool_dir"
tool_url='http://127.0.0.1:17970/tools/downloader'
if curl -fsS --max-time 2 'http://127.0.0.1:17970/api/downloader/config' >/dev/null 2>&1; then
  open "$tool_url"
  exit 0
fi
node_exe="$(command -v node || true)"
if [[ -z "$node_exe" && -x "$HOME/local/node/bin/node" ]]; then node_exe="$HOME/local/node/bin/node"; fi
if [[ -z "$node_exe" ]]; then print '需要先安装 Node.js 22.18 或更新版本。'; read -r '?按回车关闭'; exit 1; fi
if [[ ! -d node_modules ]]; then print '请先在此目录运行 npm ci 安装项目依赖。'; read -r '?按回车关闭'; exit 1; fi
mkdir -p .downloader-local
nohup "$node_exe" scripts/dev-downloader.mjs >.downloader-local/server.log 2>&1 &
print "$!" >.downloader-local/server.pid
for attempt in {1..30}; do
  if curl -fsS --max-time 1 'http://127.0.0.1:17970/api/downloader/config' >/dev/null 2>&1; then open "$tool_url"; exit 0; fi
  sleep .5
done
print '启动没有完成，请查看 .downloader-local/server.log。'
read -r '?按回车关闭'
