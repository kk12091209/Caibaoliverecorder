#!/usr/bin/env bash
# Package an already signed app. Never changes files inside the app bundle.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
OUTPUT="${1:?Usage: package-macos-dmg.sh /absolute/build/output}"
[[ "$OUTPUT" == /* ]] || { echo '请使用绝对输出路径。' >&2; exit 1; }
APP="$OUTPUT/菜播·录包机.app"
VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")
DMG="$OUTPUT/Caibo-$VERSION-macos-arm64.dmg"
[[ ! -e "$DMG" ]] || { echo "文件已存在：$DMG" >&2; exit 1; }
codesign --verify --deep --strict "$APP"
PYTHON="${PYTHON:-python3}"
if ! PYTHONPATH="$ROOT/.tools/dmg-python" "$PYTHON" -c 'import ds_store, mac_alias' 2>/dev/null; then
  "$PYTHON" -m pip install --target "$ROOT/.tools/dmg-python" 'ds_store==1.3.1' 'mac_alias==2.2.3'
fi
STAGE=$(mktemp -d "$ROOT/.tools/dmg-stage.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
# ditto preserves the signature and executable bits.
ditto "$APP" "$STAGE/菜播·录包机.app"
ln -s /Applications "$STAGE/Applications"
cp "$OUTPUT/使用说明.txt" "$STAGE/安装说明.txt"
PYTHONPATH="$ROOT/.tools/dmg-python" "$PYTHON" - "$STAGE" <<'PY'
import sys
from pathlib import Path
from ds_store import DSStore
with DSStore.open(str(Path(sys.argv[1])/'.DS_Store'), 'w+') as store:
    store['.']['vSrn'] = ('long', 1)
    store['.']['icvl'] = ('type', b'icnv')
    store['.']['bwsp'] = {'ShowStatusBar': False, 'ShowToolbar': False, 'ShowPathbar': False, 'ShowSidebar': False, 'ShowTabView': False, 'WindowBounds': '{{300, 180}, {640, 390}}', 'ContainerShowSidebar': False}
    store['.']['icvp'] = {'viewOptionsVersion': 1, 'backgroundType': 1, 'backgroundColorRed': 1.0, 'backgroundColorGreen': 0.96, 'backgroundColorBlue': 0.97, 'iconSize': 100.0, 'textSize': 14.0, 'gridSpacing': 100.0, 'gridOffsetX': 0.0, 'gridOffsetY': 0.0, 'arrangeBy': 'none', 'labelOnBottom': True, 'showItemInfo': False, 'showIconPreview': True}
    store['菜播·录包机.app']['Iloc'] = (170, 150)
    store['Applications']['Iloc'] = (470, 150)
    store['安装说明.txt']['Iloc'] = (320, 300)
PY
hdiutil create -volname "菜播·录包机 $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -imagekey zlib-level=9 "$DMG"
hdiutil verify "$DMG"
(cd "$OUTPUT" && shasum -a 256 "Caibo-$VERSION-macos-arm64.dmg" "Caibo-$VERSION-macos-arm64.zip") > "$OUTPUT/SHA256SUMS.txt"
printf '已生成拖放安装包：%s\n' "$DMG"
