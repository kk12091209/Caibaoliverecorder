#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
source "$ROOT/live-editor/scripts/dev-env.sh"
[[ $(uname -m) == arm64 ]] || { echo '当前候选包仅支持 Apple Silicon。' >&2; exit 1; }
VERSION=$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version" "$ROOT/live-editor/package.json")
OUTPUT="${1:-$ROOT/release/macOS/$VERSION}"
[[ ! -e "$OUTPUT" ]] || { echo "输出目录已存在，请选择新目录：$OUTPUT" >&2; exit 1; }
for tool in node dotnet swiftc; do command -v "$tool" >/dev/null || { echo '请先运行 prepare-macos.sh'; exit 1; }; done
cd "$ROOT/live-editor"
npm run build
cd "$ROOT"
dotnet publish BililiveRecorder.Cli/BililiveRecorder.Cli.csproj -c Release -r osx-arm64 -p:RuntimeIdentifiers=osx-arm64 --self-contained true -o .tools/runtime/recorder
mkdir -p "$OUTPUT"
APP="$OUTPUT/菜播·录包机.app"
CONTENTS="$APP/Contents"
RESOURCES="$CONTENTS/Resources"
mkdir -p "$CONTENTS/MacOS" "$RESOURCES/live-editor" "$RESOURCES/runtime/node" "$RESOURCES/runtime/ffmpeg" "$RESOURCES/licenses"
# Some Xcode Swift drivers trap with a non-ASCII TMPDIR. Node tests still use
# the canonical project directory; only the compiler uses macOS's temp root.
TMPDIR=/private/tmp TMP=/private/tmp TEMP=/private/tmp xcrun swiftc -swift-version 5 -O -target arm64-apple-macos14.0 -module-cache-path "$ROOT/.tools/swift-module-cache" -framework AppKit -framework WebKit -framework IOKit live-editor/desktop-macos/Backend.swift live-editor/desktop-macos/App.swift -o "$CONTENTS/MacOS/CaiboDesktop"
cp -R live-editor/server live-editor/dist "$RESOURCES/live-editor/"
cp live-editor/package.json "$RESOURCES/live-editor/"
cp .tools/runtime/node-v24.12.0-darwin-arm64/bin/node "$RESOURCES/runtime/node/"
cp .tools/runtime/ffmpeg/ffmpeg .tools/runtime/ffmpeg/ffprobe "$RESOURCES/runtime/ffmpeg/"
python3 - "$ROOT/.tools/runtime/recorder" "$RESOURCES/runtime/recorder" <<'PY'
import shutil,sys
# Local CLI runs can create logs beside cached binaries. Never publish those
# files or debug symbols; the installed Mac app writes logs under user data.
shutil.copytree(sys.argv[1],sys.argv[2],ignore=shutil.ignore_patterns('logs','*.pdb'))
PY
cp LICENSE THIRD_PARTY_NOTICES.md "$RESOURCES/licenses/"
cp .tools/runtime/node-v24.12.0-darwin-arm64/LICENSE "$RESOURCES/licenses/Node-LICENSE.txt"
cp live-editor/package-lock.json "$RESOURCES/licenses/editor-dependencies.json"
cp live-editor/desktop-macos/THIRD_PARTY.md "$RESOURCES/licenses/Mac-THIRD-PARTY.md"
for package in vue lucide-vue-next; do
  license=$(find "live-editor/node_modules/$package" -maxdepth 1 -iname '*license*' -type f -print -quit)
  [[ -n "$license" ]] && cp "$license" "$RESOURCES/licenses/$package-LICENSE.txt"
done
# Publish keeps .NET's runtime notices. Preserve the restore metadata and NuGet
# license files as well, without bundling the development SDK/cache.
python3 live-editor/scripts/macos-licenses.py "$RESOURCES/licenses" "$ROOT"
ICONSET="$ROOT/.tools/Caibo.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" live-editor/desktop/assets/app-original.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size*2)); sips -z "$double" "$double" live-editor/desktop/assets/app-original.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RESOURCES/AppIcon.icns"
python3 - "$APP" "$VERSION" <<'PY'
import sys,plistlib
from pathlib import Path
app=Path(sys.argv[1]);version=sys.argv[2]
p={'CFBundleIdentifier':'io.github.kk12091209.caibo','CFBundleName':'菜播·录包机','CFBundleDisplayName':'菜播·录包机','CFBundleExecutable':'CaiboDesktop','CFBundlePackageType':'APPL','CFBundleShortVersionString':version,'CFBundleVersion':version,'CFBundleIconFile':'AppIcon','LSMinimumSystemVersion':'14.0','NSPrincipalClass':'NSApplication','NSHighResolutionCapable':True,'NSHumanReadableCopyright':'糊涂小菜包 · GPL-3.0','NSAppTransportSecurity':{'NSAllowsLocalNetworking':True,'NSExceptionDomains':{'127.0.0.1':{'NSExceptionAllowsInsecureHTTPLoads':True}}}}
with (app/'Contents/Info.plist').open('wb') as out:plistlib.dump(p,out)
PY
IDENTITY="${MACOS_SIGN_IDENTITY:--}"
if [[ "$IDENTITY" != '-' && "$IDENTITY" != 'Developer ID Application:'* ]]; then echo '公开签名请使用 Developer ID Application 证书。' >&2; exit 1; fi
SIGN_ARGS=(--force --sign "$IDENTITY")
if [[ "$IDENTITY" != '-' ]]; then SIGN_ARGS+=(--options runtime --timestamp); fi
while IFS= read -r -d '' file; do
  if file -b "$file" | grep -q 'Mach-O'; then
    case "$(basename "$file")" in
      node|BililiveRecorder.Cli) codesign "${SIGN_ARGS[@]}" --entitlements live-editor/desktop-macos/entitlements.plist "$file" ;;
      *) codesign "${SIGN_ARGS[@]}" "$file" ;;
    esac
  fi
done < <(find "$RESOURCES/runtime" -type f -print0)
codesign "${SIGN_ARGS[@]}" "$APP"
codesign --verify --deep --strict "$APP"
python3 - "$APP" "$OUTPUT" "$IDENTITY" <<'PY'
import sys,hashlib,json
from pathlib import Path
app=Path(sys.argv[1]);out=Path(sys.argv[2])
files=[{'path':str(p.relative_to(app)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(app.rglob('*')) if p.is_file()]
(out/'manifest.json').write_text(json.dumps({'architecture':'arm64','minimumMacOS':'14.0','signing':'ad-hoc' if sys.argv[3]=='-' else 'Developer ID','notarized':False,'files':files},ensure_ascii=False,indent=2)+'\n')
PY
cp live-editor/desktop-macos/使用说明.txt "$OUTPUT/使用说明.txt"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUTPUT/Caibo-$VERSION-macos-arm64.zip"
(cd "$OUTPUT" && shasum -a 256 "Caibo-$VERSION-macos-arm64.zip") > "$OUTPUT/SHA256SUMS.txt"
printf '已生成本地候选：%s\n' "$OUTPUT"
