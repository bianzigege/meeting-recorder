#!/bin/zsh
# 本地预览网页演示版(带云端函数):http://localhost:8788
# 第一次运行会从上一级的 .env 读 GENESIS_API_KEY 写进 .dev.vars(已 gitignore)
cd "$(dirname "$0")"
WRANGLER="$HOME/Desktop/泰语学习/bianzi-thai/.tools/node_modules/wrangler/bin/wrangler.js"
[ -f .dev.vars ] || grep '^GENESIS_API_KEY=' ../.env > .dev.vars
bun build.ts || exit 1
exec /usr/local/bin/node "$WRANGLER" pages dev dist --port 8788
