// 字卡:按网页版配色渲染成 1920×1080 png,再合成需要的小段 mp4。bun cards.ts <输出目录>
import { Page, sleep } from "./cdp.ts";
import { launchChrome } from "./rec.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUT = path.join(process.argv[2] || "out", "字卡");
mkdirSync(OUT, { recursive: true });
const BASE = `<!doctype html><meta charset="utf-8"><style>
:root{--bg:#f5f6f8;--card:#fff;--text:#1c1f24;--muted:#6b7280;--line:#e5e7eb;--primary:#2563eb;--warn:#f59e0b;--danger:#dc2626;--ok:#16a34a}
*{box-sizing:border-box;margin:0}
body{width:1920px;height:1080px;font-family:"PingFang SC","Hiragino Sans GB","Noto Sans SC",sans-serif;color:var(--text);overflow:hidden}
.full{position:absolute;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center}
.lines{display:flex;flex-direction:column;gap:44px}
.line{font-size:76px;font-weight:600;letter-spacing:.02em;display:flex;align-items:center;gap:28px}
.line i{font-style:normal;width:18px;height:18px;border-radius:50%;background:var(--danger);flex:none}
.line.dim{opacity:0}
.title{text-align:center}
.title .logo{font-size:120px}
.title h1{font-size:150px;font-weight:700;letter-spacing:.06em;margin-top:10px}
.title p{font-size:46px;color:var(--muted);margin-top:34px;letter-spacing:.04em}
.title .bar{width:120px;height:8px;border-radius:4px;background:var(--primary);margin:36px auto 0}
.url{text-align:center}
.url .name{font-size:58px;font-weight:600}
.url .big{font-size:118px;font-weight:700;color:var(--primary);margin:44px 0 40px;letter-spacing:.01em}
.url .small{font-size:40px;color:var(--muted);line-height:1.7}
.badge{position:absolute;right:0;top:0;padding:7px 16px;border-radius:999px;background:rgba(28,31,36,.5);color:#fff;font-size:21px;font-weight:600;letter-spacing:.08em}
.stat{position:absolute;right:56px;bottom:60px;background:rgba(255,255,255,.97);border:2px solid var(--line);border-radius:28px;padding:30px 44px;box-shadow:0 18px 50px -18px rgba(15,23,42,.35)}
.stat .k{font-size:32px;color:var(--muted)}
.stat .v{font-size:64px;font-weight:700;margin-top:10px;display:flex;align-items:baseline;gap:22px}
.stat .v b{color:var(--primary)}
.stat .v span{color:var(--line);font-weight:400}
</style>`;

const cards: Record<string, { html: string; transparent?: boolean; w?: number; h?: number }> = {
  "镜03-问题-1": { html: `<div class="full"><div class="lines"><div class="line"><i></i>会上定的事，散会就忘</div><div class="line dim"><i></i>纪要没人写，写了没人看</div><div class="line dim"><i></i>谁负责、做完没，得翻群聊</div></div></div>` },
  "镜03-问题-2": { html: `<div class="full"><div class="lines"><div class="line"><i></i>会上定的事，散会就忘</div><div class="line"><i></i>纪要没人写，写了没人看</div><div class="line dim"><i></i>谁负责、做完没，得翻群聊</div></div></div>` },
  "镜03-问题-3": { html: `<div class="full"><div class="lines"><div class="line"><i></i>会上定的事，散会就忘</div><div class="line"><i></i>纪要没人写，写了没人看</div><div class="line"><i></i>谁负责、做完没，得翻群聊</div></div></div>` },
  "镜04-片名": { html: `<div class="full"><div class="title"><div class="logo">🎙️</div><h1>散会即开工</h1><div class="bar"></div><p>MatrixNEXT 2026 · 创意赛道 · 会议变行动</p></div></div>` },
  "镜17-网址": { html: `<div class="full"><div class="url"><div class="name">🎙️ 散会即开工</div><div class="big">sanhui-kaigong.pages.dev</div><div class="small">github.com/bianzigege/meeting-recorder<br>MatrixNEXT 2026 创意赛道</div></div></div>` },
  "镜07-数字叠加": { transparent: true, html: `<div class="stat"><div class="k">我的一场真实会议</div><div class="v">22 分钟<span>|</span><b>46 秒</b>提出 <b>7 件事</b></div></div>` },
  "角标-示例数据": { transparent: true, w: 130, h: 44, html: `<div class="badge">示例数据</div>` },
  "角标-3倍速": { transparent: true, w: 130, h: 44, html: `<div class="badge">3× 加速</div>` },
};

await launchChrome();
const p = await Page.open(9223);
for (const [name, c] of Object.entries(cards)) {
  const w = c.w || 1920, h = c.h || 1080;
  await p.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await p.send("Emulation.setDefaultBackgroundColorOverride", c.transparent ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {});
  const html = BASE + (c.w ? `<style>body{width:${w}px;height:${h}px}</style>` : "") + c.html;
  await p.goto("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await sleep(300);
  await p.shot(path.join(OUT, `${name}.png`));
  console.log("✓", name);
}
await p.close();

// 小段 mp4:镜 3 三行跟口播一行行出现(各 3.3 秒,0.3 秒淡入);镜 4 片名 2 秒;镜 17 网址 6 秒
const run = (args: string[]) => { const r = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", ...args]); if (r.exitCode) throw new Error(r.stderr.toString()); };
const vid = (png: string, sec: number, out: string) => run(["-loop", "1", "-t", String(sec), "-i", path.join(OUT, png), "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "16", "-movflags", "+faststart", path.join(OUT, out)]);
vid("镜03-问题-1.png", 3.6, "_a.mp4"); vid("镜03-问题-2.png", 3.6, "_b.mp4"); vid("镜03-问题-3.png", 3.4, "_c.mp4");
run(["-i", path.join(OUT, "_a.mp4"), "-i", path.join(OUT, "_b.mp4"), "-i", path.join(OUT, "_c.mp4"), "-filter_complex",
  "[0][1]xfade=transition=fade:duration=0.3:offset=3.3[ab];[ab][2]xfade=transition=fade:duration=0.3:offset=6.6,format=yuv420p[v]", "-map", "[v]", "-c:v", "libx264", "-crf", "16", "-movflags", "+faststart", path.join(OUT, "镜03-问题.mp4")]);
for (const f of ["_a.mp4", "_b.mp4", "_c.mp4"]) Bun.spawnSync(["rm", path.join(OUT, f)]);
vid("镜04-片名.png", 2, "镜04-片名.mp4");
vid("镜17-网址.png", 6, "镜17-网址.mp4");
writeFileSync(path.join(OUT, "说明.txt"), "镜07-数字叠加.png 是透明底,叠在第 7 镜录屏的 0:06–0:12 上;角标-3倍速.png 叠在第 14 镜的等待段。\n");
console.log("字卡和小段视频已生成:", OUT);
