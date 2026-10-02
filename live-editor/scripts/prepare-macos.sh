#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || { echo '当前发布脚本仅支持 Apple Silicon Mac。' >&2; exit 1; }
mkdir -p "$ROOT/.tools/downloads" "$ROOT/.tools/runtime"
cd "$ROOT"
python3 - <<'PY'
from pathlib import Path
from urllib.request import urlopen
import hashlib, subprocess, zipfile
root=Path('.tools');downloads=root/'downloads';runtime=root/'runtime'
assets=[
 ('https://nodejs.org/dist/v24.12.0/node-v24.12.0-darwin-arm64.tar.gz','node-v24.12.0-darwin-arm64.tar.gz','319f221adc5e44ff0ed57e8a441b2284f02b8dc6fc87b8eb92a6a93643fd8080'),
 ('https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip','ffmpeg.zip','c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924'),
 ('https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffprobe.zip','ffprobe.zip','fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6')]
for url,name,expected in assets:
 target=downloads/name
 if not target.exists():
  print('下载',name,flush=True)
  with urlopen(url,timeout=120) as response, target.open('wb') as out:
   while chunk:=response.read(1024*1024):out.write(chunk)
 if hashlib.sha256(target.read_bytes()).hexdigest()!=expected:raise SystemExit('下载校验失败，请删除并重新下载 '+str(target))
 if name.endswith('.tar.gz'):
  # The official archive is pinned by SHA-256 above. macOS ships bsdtar,
  # while its system Python may predate tarfile's extraction filters.
  subprocess.run(['/usr/bin/tar','-xzf',str(target),'-C',str(runtime)],check=True)
 else:
  with zipfile.ZipFile(target) as archive:
   for item in archive.namelist():
    if item.startswith('/') or '..' in Path(item).parts:raise SystemExit('unsafe archive')
   archive.extractall(runtime/'ffmpeg')
for name in ['ffmpeg','ffprobe']:(runtime/'ffmpeg'/name).chmod(0o755)
PY
if [[ ! -x "$ROOT/.tools/dotnet/dotnet" ]]; then
  curl -fsSL https://dot.net/v1/dotnet-install.sh -o .tools/downloads/dotnet-install.sh
  bash .tools/downloads/dotnet-install.sh --version 8.0.425 --install-dir "$ROOT/.tools/dotnet" --no-path
fi
source "$ROOT/live-editor/scripts/dev-env.sh"
cd "$ROOT/live-editor"
npm ci --cache "$ROOT/.tools/npm-cache"
printf 'Mac 开发依赖已准备好。\n'
