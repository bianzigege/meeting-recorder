#!/bin/zsh
# 发布网页演示版到 https://sanhui-kaigong.pages.dev
# wrangler 借用开口泰项目里装好的那份,必须用 /usr/local/bin/node 跑(其他 node 读不了钥匙串,bun 会半途退出)
cd "$(dirname "$0")"
WRANGLER=(/usr/local/bin/node "$HOME/Desktop/泰语学习/bianzi-thai/.tools/node_modules/wrangler/bin/wrangler.js")
export CLOUDFLARE_ACCOUNT_ID=c648da23e6d3b8dbcc37a1e705e9963f
PROJECT=sanhui-kaigong
SITE="https://$PROJECT.pages.dev"

bun build.ts || exit 1

# 第一次:建项目、放 MOI 的 Key(Key 只在 Cloudflare 里,不进页面)
if ! "${WRANGLER[@]}" pages project list 2>/dev/null | grep -q "$PROJECT"; then
  "${WRANGLER[@]}" pages project create "$PROJECT" --production-branch main || exit 1
fi
if ! "${WRANGLER[@]}" pages secret list --project-name "$PROJECT" 2>/dev/null | grep -q GENESIS_API_KEY; then
  grep '^GENESIS_API_KEY=' ../.env | cut -d= -f2- | tr -d '\n' | "${WRANGLER[@]}" pages secret put GENESIS_API_KEY --project-name "$PROJECT" || exit 1
fi

CHECK=(index.html demo.js core.js app.js samples/seed.json)
want=$(for f in $CHECK; do shasum "dist/$f" | cut -d' ' -f1; done)
for i in 1 2 3; do
  "${WRANGLER[@]}" pages deploy dist --project-name "$PROJECT" --branch main --commit-dirty=true 2>&1 | tail -3
  for t in 1 2 3 4 5 6; do
    sleep 5
    got=$(for f in $CHECK; do curl -sL "$SITE/${f/index.html/}?v=$RANDOM" | shasum | cut -d' ' -f1; done)
    if [ "$got" = "$want" ] && curl -s "$SITE/demo-api/ping" | grep -q endpoints; then echo "已发布:$SITE"; exit 0; fi
  done
  echo "第 $i 次还没生效,重试…"
done
echo "发布失败"; exit 1
