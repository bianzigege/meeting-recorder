// 演示视频支持分段请求(Range)。Pages 的静态文件不认 Range、总是整段返回,iPhone / Safari 放 mp4 必须要分段。
// 同路径有静态文件时 Pages 不走函数,所以视频页用 /v/sanhui-demo.mp4:这里从静态资源 /video/<文件> 取整段流,按请求的区间截出来,回 206。
import SIZES from "../../lib/media.js"; // 构建时写入的文件大小(静态资源响应里没有 content-length)
const BASE = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=3600" };

async function serve({ request, env, params }, withBody) {
  if (!SIZES[params.file] || !params.file.endsWith(".mp4")) return new Response("没有这个文件", { status: 404 });
  const asset = await env.ASSETS.fetch(new Request(new URL(`/video/${params.file}`, request.url)));
  if (!asset.ok) return asset;
  const size = SIZES[params.file];
  const m = /^bytes=(\d*)-(\d*)$/.exec((request.headers.get("range") || "").trim());
  if (!m || !size || (!m[1] && !m[2])) {
    return new Response(withBody ? asset.body : null, { headers: { ...BASE, "Content-Length": String(size) } });
  }
  let start, end;
  if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  else { start = Math.max(0, size - Number(m[2])); end = size - 1; } // bytes=-N:最后 N 字节
  if (start > end || start >= size) {
    if (asset.body) await asset.body.cancel();
    return new Response(null, { status: 416, headers: { ...BASE, "Content-Range": `bytes */${size}` } });
  }
  const headers = { ...BASE, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) };
  if (!withBody) { if (asset.body) await asset.body.cancel(); return new Response(null, { status: 206, headers }); }
  // 边读边截:跳过 start 之前的字节,读到 end 就停
  let pos = 0;
  const slice = new TransformStream({
    transform(chunk, ctl) {
      const from = Math.max(0, start - pos), to = Math.min(chunk.length, end + 1 - pos);
      if (to > from) ctl.enqueue(chunk.subarray(from, to));
      pos += chunk.length;
      if (pos > end) ctl.terminate();
    },
  });
  asset.body.pipeTo(slice.writable).catch(() => {});
  return new Response(slice.readable, { status: 206, headers });
}

export const onRequestGet = (ctx) => serve(ctx, true);
export const onRequestHead = (ctx) => serve(ctx, false);
