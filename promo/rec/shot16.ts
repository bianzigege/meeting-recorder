// 镜 16:MOI 控制台。知识库页(4 份文档)→ 智能体详情(绑定知识库),说到 Genesis 时右上角浮出模型卡。
// bun shot16.ts <视频素材目录>   素材:<目录>/MOI控制台/知识库.png、智能体详情.png(内置浏览器里放大 3 倍分块截图拼的整页)
// → <目录>/录屏/镜16-MOI控制台.mp4(10 秒)
import { Page, sleep } from "./cdp.ts";
import { launchChrome } from "./rec.ts";
import { writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const SRC = process.argv[2];
const IMG = (n: string) => path.join(SRC, "MOI控制台", n + ".png");
const OUT = path.join(SRC, "录屏", "镜16-MOI控制台.mp4");
const TMP = "/tmp/sanhui-shot16";
const BADGE = path.join(SRC, "字卡", "角标-示例数据.png");
for (const n of ["知识库", "智能体详情"]) if (!existsSync(IMG(n))) throw new Error("缺少 " + IMG(n));
Bun.spawnSync(["mkdir", "-p", TMP]);

const CSS = `<meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{width:1920px;height:1080px;background:#eef1f6;font-family:"PingFang SC",sans-serif;overflow:hidden;position:relative}
.win{position:absolute;background:#fff;border-radius:22px;box-shadow:0 30px 80px -30px rgba(15,23,42,.35);border:1.5px solid #e5e7eb;overflow:hidden}
.bar{height:46px;background:#f8fafc;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:9px;padding:0 18px}
.bar i{width:13px;height:13px;border-radius:50%;background:#e5e7eb}
.bar span{margin-left:14px;font-size:19px;color:#6b7280}
.win img{display:block;width:100%}
.chip{position:absolute;display:inline-flex;align-items:center;gap:12px;background:#7c3aed;color:#fff;font-size:30px;font-weight:600;padding:10px 24px;border-radius:999px;box-shadow:0 10px 30px -12px rgba(124,58,237,.6)}
.chip small{font-size:24px;font-weight:500;opacity:.9}
.card{position:absolute;right:70px;top:250px;background:rgba(255,255,255,.98);border:2px solid #ddd6fe;border-radius:28px;padding:28px 40px;box-shadow:0 18px 50px -18px rgba(15,23,42,.35)}
.card .k{font-size:30px;color:#6b7280}
.card .v{font-size:54px;font-weight:700;margin-top:8px;color:#1c1f24}
.card .v b{color:#7c3aed}
</style>`;
const pages: Record<string, string> = {
  A: `${CSS}<div class="chip" style="left:80px;top:62px">MOI 控制台 <small>知识库：三场会议 + 任务总表</small></div>
      <div class="win" style="left:80px;top:150px;width:1760px"><div class="bar"><i></i><i></i><i></i><span>moi.matrixorigin.cn · 知识库</span></div><img src="file://${IMG("知识库")}"></div>`,
  B: `${CSS}<div class="chip" style="left:250px;top:40px">MOI 控制台 <small>智能体「散会即开工助手」绑定知识库</small></div>
      <div class="win" style="left:250px;top:122px;width:1420px"><div class="bar"><i></i><i></i><i></i><span>moi.matrixorigin.cn · 智能体详情</span></div><img src="file://${IMG("智能体详情")}"></div>`,
  G: `${CSS}<style>body{background:transparent}</style><div class="card"><div class="k">提任务、写纪要</div><div class="v"><b>Genesis</b> 模型</div><div class="k" style="margin-top:6px">qwen3.8-flash</div></div>`,
};

await launchChrome();
const p = await Page.open(9223);
await p.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
for (const [k, html] of Object.entries(pages)) {
  const f = path.join(TMP, k + ".html");
  writeFileSync(f, `<!doctype html>${html}`);
  await p.send("Emulation.setDefaultBackgroundColorOverride", k === "G" ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {});
  await p.goto("file://" + f);
  await sleep(700);
  await p.shot(path.join(TMP, k + ".png"));
}
await p.close();

// A 0–5.2 秒,0.4 秒淡入 B,B 到 10 秒;Genesis 卡第 6.3 秒淡入(旁白说到「提任务和写纪要用的是 Genesis 模型」)
const run = (a: string[]) => { const r = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", ...a]); if (r.exitCode) throw new Error(r.stderr.toString().slice(-400)); };
run(["-loop", "1", "-t", "5.2", "-i", path.join(TMP, "A.png"), "-loop", "1", "-t", "5.2", "-i", path.join(TMP, "B.png"), "-loop", "1", "-t", "10", "-i", path.join(TMP, "G.png"), "-loop", "1", "-t", "10", "-i", BADGE,
  "-filter_complex",
  "[0:v]fps=30,format=yuv420p[a];[1:v]fps=30,format=yuv420p[b];[a][b]xfade=transition=fade:duration=0.4:offset=4.8[ab];" +
  "[2:v]fps=30,format=rgba,fade=t=in:st=6.3:d=0.4:alpha=1[g];[ab][g]overlay=0:0:shortest=1[v1];[v1][3:v]overlay=W-w-24:20:shortest=1,format=yuv420p[o]",
  "-map", "[o]", "-t", "10", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-movflags", "+faststart", OUT]);
console.log("✓ " + OUT);
process.exit(0);
