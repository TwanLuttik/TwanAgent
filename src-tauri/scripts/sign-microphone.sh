#!/bin/sh
# Bind Info.plist into the ad-hoc signature. A linker-signed debug binary reports
# "Info.plist=not bound", so TCC ignores NSMicrophoneUsageDescription and aborts.
set -eu
bin=${1:-}
plist=${2:-}
if [ -z "$bin" ] || [ ! -f "$bin" ] || [ -z "$plist" ] || [ ! -f "$plist" ]; then
  echo "usage: sign-microphone.sh <binary> <Info.plist>" >&2
  exit 1
fi
dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
entitlements="$dir/../Entitlements.plist"
codesign --force --sign - --identifier app.twanagent.desktop --entitlements "$entitlements" "$bin"
codesign -d --entitlements :- "$bin" 2>&1 | grep -E 'audio-input|Identifier' || true
