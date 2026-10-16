#!/bin/bash
# 生成可双击的 macOS 应用(菜单栏常驻),安装到 ~/Applications/会议录音纪要.app
# 用法: ./build-app.sh
# 注意:.app 不能放在 桌面 / 文稿 / 下载 这些受系统保护的文件夹里,
#       否则从 Finder 启动时子进程读不到项目文件,所以统一装到 ~/Applications。
set -e
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Applications/会议录音纪要.app"
mkdir -p "$HOME/Applications"
# 不整个删掉重建:签名一变,系统授予的权限(桌面文件夹、完全磁盘访问)就要重新给
[ -f "$APP/Contents/MacOS/launcher" ] && rm -rf "$APP"   # 旧版是启动脚本,换成新版
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# 菜单栏常驻程序:启动服务、打开主窗口、开会提醒、全局快捷键 ⌃⌥⌘R
PLIST_TMP="$(mktemp)"
cat > "$PLIST_TMP" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>会议录音纪要</string>
  <key>CFBundleDisplayName</key><string>会议录音纪要</string>
  <key>CFBundleIdentifier</key><string>local.meeting-recorder</string>
  <key>CFBundleVersion</key><string>0.4.0</string>
  <key>CFBundleShortVersionString</key><string>0.4.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>MeetingRecorder</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>14.2</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>MRProjectDir</key><string>$PROJECT_DIR</string>
</dict>
</plist>
PLIST

# Info.plist 内容没变就不动(改了它签名就失效,要重签)
NEED_SIGN=0
if ! cmp -s "$PLIST_TMP" "$APP/Contents/Info.plist"; then mv "$PLIST_TMP" "$APP/Contents/Info.plist"; NEED_SIGN=1; else rm -f "$PLIST_TMP"; fi

MB_BIN="$APP/Contents/MacOS/MeetingRecorder"
if [ ! -x "$MB_BIN" ] || [ "$PROJECT_DIR/native/menubar.swift" -nt "$MB_BIN" ]; then
  echo "编译菜单栏程序…(重新编译后,系统可能会再问一次是否允许访问桌面文件夹)"
  swiftc -O -swift-version 5 -o "$MB_BIN" "$PROJECT_DIR/native/menubar.swift"
  NEED_SIGN=1
fi
[ "$NEED_SIGN" = 1 ] && { codesign --force --sign - --identifier local.meeting-recorder "$APP" >/dev/null 2>&1 || true; }

# 图标:有 AppIcon.icns 就用,没有就跳过
[ -f "$PROJECT_DIR/assets/AppIcon.icns" ] && cp "$PROJECT_DIR/assets/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

# 首次编译本地转写程序
if [ ! -x "$PROJECT_DIR/bin/transcribe" ] && command -v swiftc >/dev/null 2>&1; then
  echo "编译本地转写程序…"
  mkdir -p "$PROJECT_DIR/bin"
  swiftc -O -o "$PROJECT_DIR/bin/transcribe" "$PROJECT_DIR/native/transcribe.swift"
fi

# 编译录制助手(原生录屏 / 录音)。源码没改就不重编:重编后签名会变,系统要重新授权屏幕录制
REC_BIN="$PROJECT_DIR/bin/录制助手.app/Contents/MacOS/recorder"
if command -v swiftc >/dev/null 2>&1 && { [ ! -x "$REC_BIN" ] || [ "$PROJECT_DIR/native/record.swift" -nt "$REC_BIN" ]; }; then
  echo "编译录制助手…"
  bash "$PROJECT_DIR/native/build-recorder.sh"
fi

# 录制时的红点计时同样预设到靠右,避开刘海(已经有位置就不动)
defaults read local.meeting-recorder.recorder "NSStatusItem Preferred Position Item-0" >/dev/null 2>&1 || \
  defaults write local.meeting-recorder.recorder "NSStatusItem Preferred Position Item-0" -float 360

echo "已安装:$APP"
echo "在 Finder 的「前往 → 个人 → Applications」里能找到,双击打开。打开后常驻在菜单栏(右上角的波形图标)。"
echo "(不要把它移到桌面、文稿、下载文件夹,会启动失败)"
open -R "$APP" 2>/dev/null || true
