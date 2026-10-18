#!/bin/zsh
# 录演示视频用:把 Mac 版(菜单栏 App)临时切到示例会议库,录完切回真实会议库。
#   ./promo/demo-mode.sh on      拷一份示例会议到 .demo-meetings,App 改用这份,「今天」固定为 2026-10-27
#   ./promo/demo-mode.sh popup   在示例库下重开 App 并弹一次「腾讯会议 好像在开会」提醒窗(15 秒),录第 5 镜用
#   ./promo/demo-mode.sh off     切回真实会议库
# 真实会议一个字都不会动;示例库的改动只在 .demo-meetings 里(已 gitignore)。
DIR="${0:A:h:h}"
APP="$HOME/Applications/会议录音纪要.app"
DEMO="$DIR/.demo-meetings"
ENVS=(--env "MEETINGS_DIR=$DEMO" --env "DEMO_TODAY=2026-10-27")
API="http://127.0.0.1:3456"

recording() { curl -s --max-time 2 "$API/api/record/status" -H "Origin: $API" | grep -q '"active":true'; }
stop_app() {
  if recording; then echo "正在录音,先停掉录音再切换"; exit 1; fi
  pkill -x MeetingRecorder 2>/dev/null
  pkill -f "bun run server.ts" 2>/dev/null
  for i in {1..20}; do curl -s --max-time 1 "$API/api/ping" >/dev/null 2>&1 || break; sleep 0.5; done
}
wait_up() { for i in {1..40}; do curl -s --max-time 1 "$API/api/ping" -H "Origin: $API" >/dev/null 2>&1 && return 0; sleep 0.5; done; echo "服务没起来"; exit 1; }
show() { curl -s --max-time 3 "$API/api/briefing" -H "Origin: $API" | python3 -c 'import json,sys;print("会前汇报:", json.load(sys.stdin)["line"])'; }

case "$1" in
  on)
    stop_app
    rm -rf "$DEMO" && cp -R "$DIR/samples/meetings" "$DEMO"
    open "${ENVS[@]}" "$APP"
    wait_up; echo "已切到示例会议库($DEMO)"; show ;;
  popup)
    [ -d "$DEMO" ] || { echo "先运行 on"; exit 1; }
    stop_app
    open "${ENVS[@]}" "$APP" --args --background --demo-reminder
    wait_up; echo "提醒窗会在右上角出现,停留 15 秒" ;;
  off)
    stop_app
    open "$APP"
    wait_up; echo "已切回真实会议库"; show ;;
  *) echo "用法:$0 on | popup | off"; exit 1 ;;
esac
