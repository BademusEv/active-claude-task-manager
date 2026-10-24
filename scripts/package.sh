#!/bin/sh
# Builds «Claude Sessions.app» (the widget with its own name, icon and bundle
# id, no Dock icon) and installs it into ~/Applications. No asar: the Swift
# helper in build/ has to be a real file to be spawned; and the widget has no
# runtime dependencies, so node_modules stays out. A running copy is
# stopped first; the LaunchAgent, if installed, starts the new one.
set -e
cd "$(dirname "$0")/.."
NAME="Claude Sessions"
BUNDLE_ID="com.vadimevteev.claude-sessions-widget"
LABEL="com.vadimevteev.claude-sessions-widget"
DEST="$HOME/Applications"
# Electron's names for the CPU: arm64 on Apple silicon, x64 on Intel.
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

NODE_MAJOR_MINOR="$(node -p 'process.versions.node.split(".").slice(0, 2).join(".")')"
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)'; then
  echo "Node $NODE_MAJOR_MINOR is too old for @electron/packager: install Node 22.12 or newer" >&2
  exit 1
fi
command -v swift >/dev/null 2>&1 || { echo "swift not found: install the Xcode Command Line Tools with  xcode-select --install" >&2; exit 1; }

[ -x build/front ] || sh scripts/build-helper.sh

if [ ! -f build/icon.icns ]; then
  swift scripts/make-icon.swift build/icon-1024.png
  rm -rf build/icon.iconset && mkdir -p build/icon.iconset
  for s in 16 32 128 256 512; do
    sips -z $s $s build/icon-1024.png --out "build/icon.iconset/icon_${s}x${s}.png" >/dev/null
    d=$((s * 2))
    sips -z $d $d build/icon-1024.png --out "build/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns build/icon.iconset -o build/icon.icns
fi

cat > build/extra-info.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

npx @electron/packager . "$NAME" \
  --platform=darwin --arch="$ARCH" --out=dist --overwrite \
  --icon=build/icon.icns --app-bundle-id="$BUNDLE_ID" \
  --app-category-type=public.app-category.developer-tools \
  --extend-info=build/extra-info.plist \
  --no-asar --ignore='^/node_modules' \
  --ignore='^/dist' --ignore='^/helper' --ignore='^/scripts' \
  --ignore='^/build/icon' --ignore='^/build/extra-info' --ignore='\.md$'

APP="dist/$NAME-darwin-$ARCH/$NAME.app"
# Ad-hoc signature: the bundle was changed after Electron's own signing.
codesign --force --deep --sign - "$APP"

AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
# Stop the copy being replaced: through its LaunchAgent when autostart is on.
[ -f "$AGENT" ] && launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
pkill -f "$DEST/$NAME.app/Contents/MacOS/" 2>/dev/null || true
mkdir -p "$DEST"
rm -rf "$DEST/$NAME.app"
ditto "$APP" "$DEST/$NAME.app"
echo "installed $DEST/$NAME.app"

if [ -f "$AGENT" ]; then
  sh scripts/install-launch-agent.sh
else
  echo "start it with:  open \"$DEST/$NAME.app\"   (or  npm run autostart  to start it at login)"
fi
