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
ARCH="$(uname -m)"

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

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
pkill -f "$DEST/$NAME.app/Contents/MacOS/" 2>/dev/null || true
mkdir -p "$DEST"
rm -rf "$DEST/$NAME.app"
ditto "$APP" "$DEST/$NAME.app"
echo "installed $DEST/$NAME.app"

if [ -f "$HOME/Library/LaunchAgents/$LABEL.plist" ]; then
  sh scripts/install-launch-agent.sh
fi
