#!/bin/sh
# Stops the orca-office bridge's launchd agent and removes it (see install-bridge.sh). Logs stay.
set -eu
LABEL="${ORCA_OFFICE_LABEL:-com.orca-office.bridge}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || echo "$LABEL was not running"
rm -f "$PLIST"
echo "uninstalled $LABEL"
