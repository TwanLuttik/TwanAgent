#!/bin/sh
# Sign the debug binary and open it as an app so macOS can grant local network access.
set -e
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
bin="$root/src-tauri/target/debug/twanagent"
entitlements="$root/src-tauri/Entitlements.plist"
app="$root/src-tauri/target/debug/TwanAgent Dev.app"
identity="${TWANAGENT_SIGN_IDENTITY:-Apple Development}"

if [ ! -x "$bin" ]; then
  echo "Debug binary is missing. Run npm run tauri dev once so it can compile." >&2
  exit 1
fi

mkdir -p "$app/Contents/MacOS"
cp "$bin" "$app/Contents/MacOS/twanagent"
cat > "$app/Contents/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>twanagent</string>
  <key>CFBundleIdentifier</key><string>app.twanagent.desktop.dev</string>
  <key>CFBundleName</key><string>TwanAgent Dev</string>
  <key>CFBundleDisplayName</key><string>TwanAgent Dev</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>NSLocalNetworkUsageDescription</key>
  <string>TwanAgent connects to SSH servers on your local network to open remote projects.</string>
  <key>NSBonjourServices</key>
  <array>
    <string>_ssh._tcp</string>
  </array>
</dict>
</plist>
EOF
codesign --force --sign "$identity" --identifier app.twanagent.desktop.dev --entitlements "$entitlements" "$app"
echo "Signed $app"
echo "Quit the current tauri dev window, then this app will open."
open "$app"
