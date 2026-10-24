#!/bin/sh
# Installs (or with `remove` uninstalls) a per-user LaunchAgent that starts the
# widget at login. Its output goes to ~/Library/Logs/claude-sessions-widget.log,
# started afresh on every launch. A crash restarts it; Выход in its menu does not.
set -e
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.vadimevteev.claude-sessions-widget"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ELECTRON="$PROJECT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
# The packaged app (npm run package) when installed, else the development build.
APP_BIN="$HOME/Applications/Claude Sessions.app/Contents/MacOS/Claude Sessions"
LOG="$HOME/Library/Logs/claude-sessions-widget.log"
DOMAIN="gui/$(id -u)"

if [ "$1" = "remove" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

if [ -x "$APP_BIN" ]; then
  RUN_BIN="$APP_BIN"
  RUN_ARG=""
else
  [ -x "$ELECTRON" ] || { echo "run npm install first: $ELECTRON missing" >&2; exit 1; }
  [ -x "$PROJECT/build/front" ] || "$PROJECT/scripts/build-helper.sh"
  RUN_BIN="$ELECTRON"
  RUN_ARG="$PROJECT"
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>exec "\$0" \${1:+"\$1"} &gt;"\$2" 2&gt;&amp;1</string>
    <string>$RUN_BIN</string>
    <string>$RUN_ARG</string>
    <string>$LOG</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
PLIST

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# bootout returns before the old job is gone; bootstrap fails with error 5 until then.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "installed $LABEL (starts $RUN_BIN at login; started now)"
