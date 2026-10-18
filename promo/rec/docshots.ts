// 说明文档配图:网页版演示状态下的整页截图(无光标、无角标),2560×1600。
// bun docshots.ts <输出目录> [视频素材目录]   视频素材目录用来裁 Mac 弹窗(你录的/镜05.mp4)、拷通知截图(你录的/镜11-通知.png)
// 问资料库那张会真的调用 MOI 智能体,要等半分钟左右。
import { Page, sleep } from "./cdp.ts";
import { launchChrome, SITE } from "./rec.ts";
import { mkdirSync, existsSync, copyFileSync } from "node:fs";
import path from "node:path";

const OUT = process.argv[2] || "docshots";
const SRC = process.argv[3];
const W = 1280, H = 800, DPR = 2;
const M3 = "20261026-100000";
mkdirSync(OUT, { recursive: true });

await launchChrome();
const p = await Page.open(9223);
await p.device(W, H, DPR, false);
await p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });

async function fresh() {
  await p.goto(SITE);
  await p.eval("localStorage.clear()");
  await p.goto(SITE);
  await sleep(2500);
  await p.eval(`(() => { const s = document.createElement("style"); s.textContent = ".demo-banner{display:none!important}textarea{font-family:-apple-system,'PingFang SC','Apple Color Emoji',sans-serif!important}"; document.head.appendChild(s); })()`);
}
const resolveReviews = (accept: boolean) => p.eval(`(async () => {
  const rv = await (await fetch('/api/meetings/${M3}/reviews')).json();
  for (const x of rv) if (!x.resolved) await fetch('/api/meetings/${M3}/reviews/' + x.actionId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accept: ${accept} }) });
  activeTab = 'actions'; await openMeeting('${M3}', true); await loadBriefing();
})()`);
const confirmM3 = () => p.eval(`(async () => {
  await fetch('/api/meetings/${M3}/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
  activeTab = 'actions'; await openMeeting('${M3}', true); await loadBriefing();
})()`);
const scrollToEl = (sel: string, offset = 110) => p.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - ${offset}); })()`);
const click = (sel: string) => p.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
const shot = async (name: string) => { await sleep(600); await p.shot(path.join(OUT, name + ".png")); console.log("✓", name); };

// 1 下次开会对照:旧任务里「说做完了」的候选
await fresh();
await scrollToEl("#reviewList", 150);
await shot("图1-下次开会对照旧任务");

// 2 待确认任务:谁 / 做什么 / 什么时候 / 原话
await fresh();
await resolveReviews(false); await sleep(800);
await scrollToEl("#actList", 150);
await shot("图2-待确认任务");

// 3 认领消息
await confirmM3(); await sleep(800);
await p.eval("window.scrollTo(0, 0)");
await click("#btnClaim"); await sleep(800);
await shot("图3-认领消息");

// 4 任务看板
await fresh();
await resolveReviews(true); await confirmM3(); await sleep(800);
await click("#btnBoard"); await sleep(1500);
await shot("图4-任务看板");

// 5 问资料库:真的交给 MOI 智能体
await p.eval(`(() => { const d = document.querySelector("dialog[open]"); if (d) d.close(); })()`);
await click("#btnAsk"); await sleep(600);
await p.eval(`(() => { const i = document.querySelector("#askInput"); i.value = "小林手上还有什么没做完？"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
await click("#btnAskSend");
const t0 = Date.now();
while (Date.now() - t0 < 180_000) {
  await sleep(2000);
  const done = await p.eval(`(() => { const b = [...document.querySelectorAll('#askLog .ask-msg.bot')].pop(); return !!b && !b.classList.contains('cursor'); })()`);
  if (done) break;
}
console.log(`  MOI 智能体回答用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
await p.eval(`(() => { const l = document.getElementById("askLog"); l.scrollTop = l.scrollHeight; })()`); // 滚到底,露出「由 MOI 智能体…回答」那行
await shot("图5-问资料库-MOI智能体");
await p.close();

// 6、7 Mac 版:真弹窗(从第 5 镜裁)和真通知(你截的)
if (SRC) {
  const v = path.join(SRC, "你录的", "镜05.mp4");
  if (existsSync(v)) {
    const r = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-ss", "6", "-i", v, "-frames:v", "1", "-vf", "crop=1100:540:800:20,scale=iw*0.45:-1:flags=lanczos", path.join(OUT, "图6-Mac开会提醒弹窗.png")]);
    console.log(r.exitCode ? "✗ 图6 " + r.stderr : "✓ 图6-Mac开会提醒弹窗");
  }
  const n = path.join(SRC, "你录的", "镜11-通知.png");
  if (existsSync(n)) { copyFileSync(n, path.join(OUT, "图7-Mac任务提醒通知.png")); console.log("✓ 图7-Mac任务提醒通知"); }
}
process.exit(0);
