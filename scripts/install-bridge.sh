#!/bin/sh
# Installs the orca-office bridge as a launchd agent (design #21): it starts at login, restarts if it
# dies, and outlives Orca restarts and plugin reloads. Undo with scripts/uninstall-bridge.sh.
#
#   scripts/install-bridge.sh            # bridge on 127.0.0.1:4317
#   ORCA_OFFICE_PORT=4417 scripts/install-bridge.sh
#
# The bridge runs from this checkout, so keep it where it is (or install again after moving it).
set -eu

LABEL="${ORCA_OFFICE_LABEL:-com.orca-office.bridge}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/orca-office"
PORT="${ORCA_OFFICE_PORT:-4317}"
CLIENT_PORT="${ORCA_OFFICE_CLIENT_PORT:-5317}"

NODE="$(command -v node || true)"
ORCA="$(command -v orca || true)"
TSX="$REPO/node_modules/.bin/tsx"
[ -n "$NODE" ] || { echo "node not found on PATH" >&2; exit 1; }
[ -x "$TSX" ] || { echo "run npm ci in $REPO first ($TSX missing)" >&2; exit 1; }
[ -n "$ORCA" ] || echo "warning: orca CLI not on PATH; agents, bots and environments won't be polled" >&2

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

mkdir -p "$HOME/Library/LaunchAgents" "$LOGS"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(xml "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>$(xml "$TSX")</string>
    <string>src/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$REPO/bridge")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$(dirname "$NODE"):${ORCA:+$(dirname "$ORCA"):}/usr/bin:/bin:/usr/sbin:/sbin")</string>
    <key>ORCA_OFFICE_PORT</key><string>$(xml "$PORT")</string>
    <key>ORCA_OFFICE_CLIENT_PORT</key><string>$(xml "$CLIENT_PORT")</string>
    ${ORCA:+<key>ORCA_BIN</key><string>$(xml "$ORCA")</string>}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$(xml "$LOGS/bridge.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOGS/bridge.log")</string>
</dict>
</plist>
PLIST
plutil -lint "$PLIST" >/dev/null

DOMAIN="gui/$(id -u)"
# Installed before: replace it.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "installed $LABEL ($PLIST), bridge on http://127.0.0.1:$PORT, logs in $LOGS/bridge.log"
