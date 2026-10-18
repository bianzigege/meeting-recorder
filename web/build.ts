// 生成网页演示版:bun web/build.ts → web/dist(静态页面)+ web/lib/seed.js(云端函数用的示例数据)
// 页面和本地版是同一套 index.html / app.js / style.css;demo.js 在浏览器里接管 /api/*,数据存在访客自己的浏览器里。
import { DEFAULT_TEMPLATES, COMMON_RULES } from "../templates.ts";
import { readdir, readFile, mkdir, rm, copyFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const WEB = import.meta.dir;
const ROOT = path.resolve(WEB, "..");
const DIST = path.join(WEB, "dist");
const SAMPLES = path.join(ROOT, "samples", "meetings");
const VENDOR: Record<string, string> = {
  "d3.js": "d3/dist/d3.min.js",
  "markmap-lib.js": "markmap-lib/dist/browser/index.iife.js",
  "markmap-view.js": "markmap-view/dist/browser/index.js",
};

await rm(DIST, { recursive: true, force: true });
await mkdir(path.join(DIST, "vendor"), { recursive: true });
await mkdir(path.join(DIST, "samples"), { recursive: true });

// 页面:同一份 index.html,加演示脚本和样式,换个名字
let html = await readFile(path.join(ROOT, "public", "index.html"), "utf8");
const swap = (a: string, b: string) => { if (!html.includes(a)) throw new Error("index.html 里找不到:" + a); html = html.replace(a, b); };
swap("<title>会议录音纪要</title>", "<title>散会即开工 · 演示版</title>\n  <meta name=\"description\" content=\"开完会自动生成任务、发群认领、到期提醒、下次开会对照完成情况。MatrixNEXT 2026 参赛作品演示。\" />");
swap('<link rel="stylesheet" href="/style.css" />', '<link rel="stylesheet" href="/style.css" />\n  <link rel="stylesheet" href="/demo.css" />');
swap('<div class="brand">🎙️ 会议录音纪要</div>', '<div class="brand">🎙️ 散会即开工 <span class="demo-tag">演示版</span></div>');
swap('<script src="/vendor/d3.js"></script>', '<script src="/demo.js"></script>\n  <script src="/vendor/d3.js"></script>');
await writeFile(path.join(DIST, "index.html"), html);

for (const f of ["app.js", "style.css"]) await copyFile(path.join(ROOT, "public", f), path.join(DIST, f));
await copyFile(path.join(ROOT, "shared", "core.js"), path.join(DIST, "core.js"));
for (const f of ["demo.js", "demo.css"]) await copyFile(path.join(WEB, f), path.join(DIST, f));
for (const [name, src] of Object.entries(VENDOR)) await copyFile(path.join(ROOT, "node_modules", src), path.join(DIST, "vendor", name));

// 示例会议:页面用的 seed.json(含行动项、对照候选、分析结果)+ 录音;函数用的 seed.js(只要逐字稿和会议信息)
const readJson = async (p: string, d: any) => (existsSync(p) ? JSON.parse(await readFile(p, "utf8")) : d);
const meetings: Record<string, any> = {};
const fnMeetings: Record<string, any> = {};
for (const id of (await readdir(SAMPLES)).filter((d) => /^\d{8}-\d{6}/.test(d)).sort()) {
  const dir = path.join(SAMPLES, id);
  const meta = await readJson(path.join(dir, "meta.json"), null);
  if (!meta) continue;
  const transcript = await readFile(path.join(dir, "transcript.txt"), "utf8");
  const results: Record<string, string> = {};
  if (existsSync(path.join(dir, "results"))) {
    for (const f of await readdir(path.join(dir, "results"))) if (f.endsWith(".md")) results[f.slice(0, -3)] = await readFile(path.join(dir, "results", f), "utf8");
  }
  const { tracks, ...pub } = meta; // 网页版只放混音,不放分轨
  meetings[id] = { meta: { ...pub, mode: "audio" }, transcript, results, actions: await readJson(path.join(dir, "actions.json"), []), reviews: await readJson(path.join(dir, "reviews.json"), []) };
  fnMeetings[id] = { id, title: meta.title, createdAt: meta.createdAt, durationSec: meta.durationSec, speakerNames: meta.speakerNames || {}, transcript };
  await mkdir(path.join(DIST, "samples", id), { recursive: true });
  await copyFile(path.join(dir, meta.audioFile), path.join(DIST, "samples", id, meta.audioFile));
}
const templates = DEFAULT_TEMPLATES.map((t) => ({ ...t }));
await writeFile(path.join(DIST, "samples", "seed.json"), JSON.stringify({ version: Date.now(), meetings, templates }));
await writeFile(path.join(WEB, "lib", "seed.js"), `// 由 web/build.ts 生成,别手改\nexport default ${JSON.stringify({ meetings: fnMeetings, templates, COMMON_RULES })};\n`);
await writeFile(path.join(DIST, "_headers"), "/samples/*\n  Cache-Control: public, max-age=3600\n/*\n  X-Content-Type-Options: nosniff\n");
console.log(`已生成 web/dist:${Object.keys(meetings).length} 场示例会议,${templates.length} 个模板`);
