#!/bin/bash
# 编译录制助手:bin/录制助手.app
# 必须是带 Info.plist 的 .app,系统才会弹屏幕录制 / 麦克风权限,并把权限记在它头上。
# 注意:每次重新编译签名会变,系统可能要求重新授权一次。
set -e
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP="$PROJECT_DIR/bin/录制助手.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>录制助手</string>
  <key>CFBundleDisplayName</key><string>录制助手</string>
  <key>CFBundleIdentifier</key><string>local.meeting-recorder.recorder</string>
  <key>CFBundleVersion</key><string>0.3.0</string>
  <key>CFBundleShortVersionString</key><string>0.3.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>recorder</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>录制会议时收录你自己的声音。</string>
  <key>NSScreenCaptureUsageDescription</key><string>录制会议画面和线上会议对方的声音。</string>
</dict>
</plist>
PLIST

swiftc -O -swift-version 5 -o "$APP/Contents/MacOS/recorder" "$PROJECT_DIR/native/record.swift"
codesign --force --sign - --identifier local.meeting-recorder.recorder "$APP" >/dev/null
echo "已编译:$APP"
