#!/bin/zsh
# 本地预览网页演示版(带云端函数):http://localhost:8788
# 第一次运行会从上一级的 .env 读 GENESIS_API_KEY 写进 .dev.vars(已 gitignore)
cd "$(dirname "$0")"
WRANGLER="$HOME/Desktop/泰语学习/bianzi-thai/.tools/node_modules/wrangler/bin/wrangler.js"
# 有 .dev.vars 时 wrangler 只读它、不读 wrangler.toml 的 [vars],所以每次把 Key 和 [vars] 合在一起重写
{ grep '^GENESIS_API_KEY=' ../.env; sed -n '/^\[vars\]/,/^\[/p' wrangler.toml | grep -E '^[A-Z_]+ *=' | sed -E 's/ *= */=/'; } > .dev.vars
bun build.ts || exit 1
exec /usr/local/bin/node "$WRANGLER" pages dev dist --port 8788
