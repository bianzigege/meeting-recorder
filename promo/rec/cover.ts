// 视频封面:横版 1280×720(B 站 / YouTube / 视频号横版)+ 竖版 1080×1440(视频号 / 抖音 / 小红书)。
// bun cover.ts <视频素材目录>  → <目录>/封面/
// 画面:大数字「逾期 7 → 1」(视频开头和结尾都落在这个数字上,示例数据)+ 片名 + 旁白里的一句话。配色按产品知识包的视觉规范。
import { Page, sleep } from "./cdp.ts";
import { launchChrome } from "./rec.ts";
import { mkdirSync } from "node:fs";
import path from "node:path";

const OUT = path.join(process.argv[2] || "out", "封面");
mkdirSync(OUT, { recursive: true });

const CSS = `<!doctype html><meta charset="utf-8"><style>
:root{--bg:#f5f6f8;--card:#fff;--text:#1c1f24;--muted:#6b7280;--line:#e5e7eb;--primary:#2563eb;--danger:#dc2626;--ok:#16a34a}
*{box-sizing:border-box;margin:0}
body{font-family:"PingFang SC","Hiragino Sans GB","Noto Sans SC",sans-serif;color:var(--text);background:var(--bg);overflow:hidden;position:relative}
body::before{content:"";position:absolute;inset:0;background:radial-gradient(circle at 85% 20%,rgba(37,99,235,.10),transparent 55%),radial-gradient(circle at 10% 95%,rgba(37,99,235,.06),transparent 50%)}
.logo{line-height:1}
h1{font-weight:800;letter-spacing:.05em;line-height:1.05}
.bar{height:8px;border-radius:4px;background:var(--primary)}
.tag{color:#374151;font-weight:500;line-height:1.5}
.foot{color:var(--muted);letter-spacing:.04em}
.card{background:var(--card);border:2px solid var(--line);box-shadow:0 30px 70px -30px rgba(15,23,42,.35);display:flex;flex-direction:column;align-items:center}
.k{color:var(--muted);font-weight:600;letter-spacing:.08em}
.nums{display:flex;align-items:center;font-weight:800;line-height:1;font-variant-numeric:tabular-nums}
.from{color:var(--danger)}
.arrow{color:#9ca3af;font-weight:400}
.to{color:var(--primary)}
.note{color:var(--muted)}
.chip{display:inline-flex;align-items:center;gap:.4em;background:rgba(37,99,235,.08);color:var(--primary);font-weight:600;border-radius:999px}
</style>`;

const covers: Record<string, { w: number; h: number; html: string }> = {
  "封面-横版-1280x720": {
    w: 1280, h: 720,
    html: `<style>
      .wrap{position:absolute;inset:0;display:flex;align-items:center;padding:0 72px;gap:56px}
      .left{flex:1}
      .logo{font-size:64px}
      h1{font-size:104px;margin-top:18px}
      .bar{width:96px;margin:30px 0 28px}
      .tag{font-size:34px}
      .foot{font-size:22px;margin-top:40px}
      .chip{font-size:22px;padding:8px 18px;margin-top:22px}
      .card{width:470px;border-radius:36px;padding:40px 30px 36px}
      .k{font-size:28px}
      .nums{font-size:190px;gap:26px;margin:18px 0 10px}
      .arrow{font-size:96px}
      .note{font-size:24px}
    </style>
    <div class="wrap">
      <div class="left">
        <div class="logo">🎙️</div>
        <h1>散会即开工</h1>
        <div class="bar"></div>
        <div class="tag">把会上定的事变成任务，<br>跨会议一直跟到做完</div>
        <div class="chip">MOI 知识库 + 智能体</div>
        <div class="foot">MatrixNEXT 2026 · 创意赛道 · 会议变行动</div>
      </div>
      <div class="card">
        <div class="k">逾期任务</div>
        <div class="nums"><span class="from">7</span><span class="arrow">→</span><span class="to">1</span></div>
        <div class="note">下次开会对一遍</div>
      </div>
    </div>`,
  },
  "封面-竖版-1080x1440": {
    w: 1080, h: 1440,
    html: `<style>
      .wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 80px;text-align:center}
      .logo{font-size:96px}
      h1{font-size:150px;margin-top:26px}
      .bar{width:120px;margin:40px auto 36px}
      .tag{font-size:46px}
      .card{width:760px;border-radius:48px;padding:50px 40px 46px;margin-top:64px}
      .k{font-size:40px}
      .nums{font-size:280px;gap:40px;margin:26px 0 14px}
      .arrow{font-size:140px}
      .note{font-size:36px}
      .chip{font-size:32px;padding:12px 28px;margin-top:56px}
      .foot{font-size:30px;margin-top:26px}
    </style>
    <div class="wrap">
      <div class="logo">🎙️</div>
      <h1>散会即开工</h1>
      <div class="bar"></div>
      <div class="tag">把会上定的事变成任务，<br>跨会议一直跟到做完</div>
      <div class="card">
        <div class="k">逾期任务</div>
        <div class="nums"><span class="from">7</span><span class="arrow">→</span><span class="to">1</span></div>
        <div class="note">下次开会对一遍</div>
      </div>
      <div class="chip">MOI 知识库 + 智能体</div>
      <div class="foot">MatrixNEXT 2026 · 创意赛道 · 会议变行动</div>
    </div>`,
  },
};

await launchChrome();
const p = await Page.open(9223);
for (const [name, c] of Object.entries(covers)) {
  await p.send("Emulation.setDeviceMetricsOverride", { width: c.w, height: c.h, deviceScaleFactor: 1, mobile: false });
  await p.goto("data:text/html;charset=utf-8," + encodeURIComponent(CSS + `<style>body{width:${c.w}px;height:${c.h}px}</style>` + c.html));
  await sleep(400);
  await p.shot(path.join(OUT, `${name}.png`));
  console.log("✓", name);
}
await p.close();
process.exit(0);
