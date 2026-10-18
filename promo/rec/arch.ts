// 说明文档的架构图:Mac 本地版 / MOI / 网页演示版 三栏。bun arch.ts <输出目录>  → 架构图.png(2400×1330)
import { Page, sleep } from "./cdp.ts";
import { launchChrome } from "./rec.ts";
import { mkdirSync } from "node:fs";
import path from "node:path";

const OUT = process.argv[2] || "docshots";
mkdirSync(OUT, { recursive: true });

const html = `<!doctype html><meta charset="utf-8"><style>
:root{--bg:#f5f6f8;--card:#fff;--text:#1c1f24;--muted:#6b7280;--line:#e5e7eb;--primary:#2563eb;--warn:#f59e0b;--ok:#16a34a;--moi:#7c3aed}
*{box-sizing:border-box;margin:0}
body{width:1200px;height:665px;background:var(--bg);font-family:"PingFang SC","Hiragino Sans GB",sans-serif;color:var(--text);padding:34px 36px;overflow:hidden}
h1{font-size:26px;font-weight:700;letter-spacing:.03em}
.sub{font-size:14px;color:var(--muted);margin-top:6px}
.grid{display:grid;grid-template-columns:1fr 100px 1fr 100px 1fr;margin-top:22px;align-items:stretch}
.col{background:var(--card);border:1.5px solid var(--line);border-radius:18px;padding:16px 16px 14px;display:flex;flex-direction:column;gap:8px}
.col.moi{border-color:#ddd6fe;background:#faf8ff}
.head{display:flex;align-items:baseline;gap:8px;margin-bottom:2px}
.head b{font-size:18px}
.head span{font-size:12.5px;color:var(--muted)}
.step{border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-size:13.5px;line-height:1.45;background:#fff}
.step small{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.step.k{border-color:#fde68a;background:#fffbeb}
.step.m{border-color:#ddd6fe}
.step.m b{color:var(--moi)}
.down{text-align:center;color:#9ca3af;font-size:13px;line-height:1;margin:-3px 0}
.gap{display:flex;flex-direction:column;justify-content:center;align-items:center;gap:90px}
.arrow{display:flex;flex-direction:column;align-items:center;font-size:12px;color:var(--muted);text-align:center;line-height:1.4;white-space:nowrap}
.arrow i{font-style:normal;font-size:26px;color:var(--moi);line-height:1}
.foot{margin-top:16px;display:flex;gap:10px;flex-wrap:wrap}
.chip{font-size:12.5px;color:#374151;background:#fff;border:1px solid var(--line);border-radius:999px;padding:5px 12px}
.chip b{color:var(--primary);font-weight:600}
</style>
<h1>🎙️ 散会即开工 · 架构</h1>
<div class="sub">同一套页面两种跑法：Mac 本地版负责录制和转写，网页版给评委直接试；AI 部分都接 MOI。</div>
<div class="grid">
  <div class="col">
    <div class="head"><b>Mac 本地版</b><span>Swift 菜单栏 + Bun 服务</span></div>
    <div class="step">会议软件一开麦就弹窗问要不要录<small>顺带一行会前汇报：上次定的事完成几件</small></div>
    <div class="down">↓</div>
    <div class="step">分轨录制：我 / 对方两条声音<small>ScreenCaptureKit</small></div>
    <div class="down">↓</div>
    <div class="step">本机离线转写 + 词库纠错<small>macOS SpeechAnalyzer，录音不出电脑</small></div>
    <div class="down">↓</div>
    <div class="step k">待确认任务：谁 · 做什么 · 何时 · 原话<small>人点确认才算数</small></div>
    <div class="down">↓</div>
    <div class="step">任务看板 · 认领消息 · 每天 9 点系统通知<small>下次开会自动对照旧任务</small></div>
  </div>
  <div class="gap">
    <div class="arrow"><i>→</i>只发文字<br>抽任务 · 写纪要</div>
    <div class="arrow"><i>→</i>示例会议<br>同步进知识库</div>
  </div>
  <div class="col moi">
    <div class="head"><b style="color:var(--moi)">MOI</b><span>矩阵起源</span></div>
    <div class="step m"><b>Genesis 模型</b> qwen3.8-flash<small>OpenAI 兼容接口，关闭思考，4–10 秒；抽任务、写纪要、对照旧任务</small></div>
    <div class="step m"><b>AI Studio 知识库</b> 橙子美妆示例<small>三场会议的逐字稿、纪要、任务 + 任务总表，bge-m3 向量化</small></div>
    <div class="down">↑ 检索</div>
    <div class="step m"><b>AI Studio 智能体</b> 散会即开工助手<small>绑定知识库，A2A 流式接口；先检索再回答，每句带会议和时间点</small></div>
  </div>
  <div class="gap">
    <div class="arrow"><i>←</i>分析 · 提取<br>对照旧任务</div>
    <div class="arrow"><i>←</i>问资料库<br>超时退回模型</div>
  </div>
  <div class="col">
    <div class="head"><b>网页演示版</b><span>评委入口</span></div>
    <div class="step">sanhui-kaigong.pages.dev<small>Cloudflare Pages，打开即用、不用登录</small></div>
    <div class="down">↓</div>
    <div class="step">同一套页面，浏览器里接管接口<small>三场示例会议；访客的改动只存在自己浏览器</small></div>
    <div class="down">↓</div>
    <div class="step">Pages Functions /demo-api<small>四个 AI 动作转给 MOI；Key 只在 Cloudflare 环境变量里，不进页面</small></div>
    <div class="down">↓</div>
    <div class="step k">问资料库：显示检索进度和命中文档<small>回答里的出处可点，跳回录音那一句</small></div>
  </div>
</div>
<div class="foot">
  <div class="chip"><b>共用</b> shared/core.js：提示词和任务逻辑三边共用</div>
  <div class="chip"><b>隐私</b> 原始录音只在本机，进 MOI 的只有文字</div>
  <div class="chip"><b>源码</b> github.com/bianzigege/meeting-recorder</div>
</div>`;

await launchChrome();
const p = await Page.open(9223);
await p.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 665, deviceScaleFactor: 2, mobile: false });
await p.goto("data:text/html;charset=utf-8," + encodeURIComponent(html));
await sleep(500);
await p.shot(path.join(OUT, "架构图.png"));
console.log("✓ 架构图");
await p.close();
process.exit(0);
