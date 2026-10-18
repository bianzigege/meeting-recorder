// 网页版自动录屏的各个镜头。bun shots.ts <输出目录> [镜头编号…],不写编号就全录。
// 镜头编号对应 MatrixNEXT大赛/演示视频分镜.md 里标「自动录屏」的镜。
import { Rec, W, H, sleep } from "./rec.ts";
import path from "node:path";

const OUT = process.argv[2] || "out";
const only = process.argv.slice(3);
const M3 = "20261026-100000";
const CARD = (n: string) => path.join(OUT, "字卡", n);
// Mac 版本机页面。录这类镜头前先 promo/demo-mode.sh on 切到示例会议库,录完 off 切回来
const MAC = "http://localhost:3456";

// ---------- 准备状态(走网页版自己的接口) ----------
const resolveReviews = (r: Rec, accept: boolean) => r.eval(`(async () => {
  const rv = await (await fetch('/api/meetings/${M3}/reviews')).json();
  for (const x of rv) if (!x.resolved) await fetch('/api/meetings/${M3}/reviews/' + x.actionId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accept: ${accept} }) });
  activeTab = 'actions'; await openMeeting('${M3}', true); await loadBriefing(); return rv.length;
})()`);
const confirmM3 = (r: Rec) => r.eval(`(async () => {
  await fetch('/api/meetings/${M3}/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
  activeTab = 'actions'; await openMeeting('${M3}', true); await loadBriefing();
})()`);
const scrollTo = (r: Rec, y: number) => r.eval(`window.scrollTo(0, ${y})`);
const scrollY = (r: Rec): Promise<number> => r.eval(`window.scrollY`);

const shots: Record<string, () => Promise<void>> = {
  // 镜 1:推近会前汇报卡片「逾期 7」
  async "01"() {
    const r = new Rec("镜01-会前汇报逾期7", OUT);
    await r.open();
    await r.hold(0.6);
    await r.zoomTo(r.focus(await r.rect("#briefCard"), 470), 1.3);
    await r.hold(4.1);
    await r.save();
  },
  // 镜 2:连点 9 条「标记完成」,逾期 7 → 1
  async "02"() {
    const r = new Rec("镜02-九条候选标记完成", OUT);
    await r.open();
    await r.hold(0.3);
    const btn = await r.center("#reviewList .rev-accept");
    await r.move(btn.x, btn.y, 0.5, 0.2);
    for (let i = 0; i < 9; i++) {
      const has = await r.eval(`!!document.querySelector('#reviewList .rev-accept')`);
      if (!has) break;
      const c = await r.center("#reviewList .rev-accept");
      if (Math.abs(c.x - r.cx) + Math.abs(c.y - r.cy) > 4) await r.move(c.x, c.y, 0.2, 0.05);
      await r.click(undefined, 0, { after: 0.12 });
    }
    await r.hold(0.3);
    await r.zoomTo(r.focus(await r.rect("#briefCard"), 470), 0.8);
    await r.hold(1.2);
    await r.save();
  },
  // 镜 4 后半:网页版全景,慢慢推近一点
  async "04"() {
    const r = new Rec("镜04-网页版全景", OUT);
    await r.open();
    await r.hold(0.8);
    await r.moveTo("#list li", 2, 1.2, 0.5);
    await r.moveTo("#list li", 1, 0.8, 0.5);
    await r.moveTo("#list li", 0, 0.8, 0.6);
    await r.moveTo('[data-tab="actions"]', 0, 1.2, 0.8);
    await r.moveTo("#reviewList .rev-row .act-text", 0, 1.0, 0.6);
    await r.hold(Math.max(0.5, 10 - r.now()));
    await r.save();
  },
  // 镜 6 后半:逐字稿阅读模式,两种颜色的说话人
  async "06"() {
    const r = new Rec("镜06-逐字稿", OUT);
    await r.open();
    await r.click('[data-tab="transcript"]', 0, { sec: 0.7, pause: 0.4, after: 0.6 });
    const top = (await r.rect("#trRead")).y + (await scrollY(r));
    const y0 = await scrollY(r);
    await r.anim(1.2, (t) => scrollTo(r, y0 + (top - 90 - y0) * t));
    await r.move(W * 0.55, H * 0.5, 0.6, 0.2);
    const y1 = await scrollY(r);
    await r.anim(3.0, (t) => scrollTo(r, y1 + 220 * t));
    await r.save();
  },
  // 镜 7:待确认任务列表,后半叠「22 分钟 | 46 秒 7 件事」
  async "07"() {
    const r = new Rec("镜07-待确认任务", OUT);
    await r.open(undefined, async (r) => { await resolveReviews(r, false); await sleep(800); });
    const top = (await r.rect("#actList")).y + (await scrollY(r)) - 120;
    await r.anim(1.2, (t) => scrollTo(r, top * t));
    await r.moveTo("#actList .act-row .act-text", 0, 0.8, 0.4);
    for (let i = 1; i < 5; i++) await r.moveTo("#actList .act-row .act-text", i, 0.55, 0.45);
    await r.hold(Math.max(0.5, 12 - r.now()));
    r.overlay(CARD("镜07-数字叠加.png"), 6, 12);
    await r.save();
  },
  // 镜 8:点「▶ 00:36 原话」,录音跳到那一句播放
  async "08"() {
    const r = new Rec("镜08-点原话回放", OUT);
    await r.open(undefined, async (r) => { await resolveReviews(r, false); await sleep(800); });
    await r.hold(0.6);
    await r.click("#actList .act-row .act-src", 0, { sec: 0.9, pause: 0.5, after: 0.2 });
    await r.real(6, { fps: 8 });
    await r.hold(1.2);
    await r.save();
  },
  // 镜 9:改截止日期,再「全部确认」
  async "09"() {
    const r = new Rec("镜09-改日期并确认", OUT);
    await r.open(undefined, async (r) => { await resolveReviews(r, false); await sleep(800); });
    await r.hold(0.5);
    await r.click("#actList .act-row .act-due", 1, { sec: 0.9, pause: 0.5, after: 0.5 });
    await r.eval(`(() => { const el = document.querySelectorAll('#actList .act-row .act-due')[1]; el.value = '2026-10-29'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await r.hold(1.4);
    await r.click("#btnConfirmAll", 0, { sec: 0.9, pause: 0.6, after: 0.3 });
    await r.real(1.5, { fps: 10 });
    await r.hold(Math.max(1, 10 - r.now()));
    await r.save();
  },
  // 镜 10:认领消息 → 复制
  async "10"() {
    const r = new Rec("镜10-认领消息", OUT);
    await r.open(undefined, async (r) => { await resolveReviews(r, false); await confirmM3(r); await sleep(800); });
    await r.hold(0.4);
    await r.click("#btnClaim", 0, { sec: 0.9, pause: 0.5, after: 0.3 });
    await r.zoomTo(r.focus(await r.rect("#claimDlg"), 900), 1.0);
    await r.hold(4.0);
    await r.click("#btnCopyClaim", 0, { sec: 0.8, pause: 0.5, after: 0.3 });
    await r.real(1.5, { fps: 10 });
    await r.hold(Math.max(1, 12 - r.now()));
    await r.save();
  },
  // 镜 11:Mac 版「设置 → 任务提醒」:每天 9 点提醒,现在逾期 7 条
  // 录屏时 macOS 会把通知横幅藏起来,录不到,所以这一镜拍设置里的提醒开关、时间和当前情况
  async "11"() {
    const r = new Rec("镜11-任务提醒", OUT);
    await r.open(MAC, async (r) => {
      await r.p.send("Page.reload", { ignoreCache: true });
      await sleep(2500);
      await r.eval(`document.querySelector("#btnSettings").click()`);
      await sleep(1500);
      await r.eval(`document.querySelector("[name=remindEnabled]").closest("fieldset").scrollIntoView({ block: "center" })`);
      await sleep(500);
    });
    const prev = await r.eval(`document.querySelector("#remindPreview").textContent`);
    if (!/逾期 7 条/.test(prev)) throw new Error("提醒预览不对(是不是没切到示例会议库?):" + prev);
    const box = await r.eval(`(() => { const b = document.querySelector("[name=remindEnabled]").closest("fieldset").getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
    await r.hold(1.0);
    await r.zoomTo(r.focus(box, 700), 1.2);
    const lab = await r.rect("[name=remindEnabled] + span");
    await r.move(lab.x + 150, lab.y + lab.h + 3, 0.8, 1.3); // 停在文字下方,不挡字
    await r.moveTo("[name=remindHour]", 0, 0.7, 1.3);
    const pv = await r.rect("#remindPreview");
    await r.move(pv.x + 118, pv.y + pv.h + 3, 0.7, 1.5); // 停在「逾期 7 条」正下方,不挡字
    await r.hold(Math.max(1, 10 - r.now()));
    await r.save();
  },
  // 镜 12:下次开会对出旧任务进展:点原话听一句 → 标记完成
  async "12"() {
    const r = new Rec("镜12-下次开会对照", OUT);
    await r.open();
    const list = await r.rect("#reviewList");
    await r.hold(0.8);
    await r.zoomTo(r.focus({ x: list.x, y: list.y, w: list.w, h: 260 }, 980), 1.2);
    await r.click("#reviewList .rev-row .act-src", 1, { sec: 0.9, pause: 0.5, after: 0.2 });
    await r.real(5.5, { fps: 8 });
    await r.click("#reviewList .rev-row .rev-accept", 1, { sec: 0.8, pause: 0.5, after: 0.3 });
    await r.real(1.5, { fps: 10 });
    await r.hold(Math.max(1, 15 - r.now()));
    await r.save();
  },
  // 镜 13:任务看板,逾期只剩 1 件
  async "13"() {
    const r = new Rec("镜13-看板逾期剩1", OUT);
    await r.open(undefined, async (r) => { await resolveReviews(r, true); await confirmM3(r); await sleep(800); });
    await r.click("#btnBoard", 0, { sec: 0.9, pause: 0.4, after: 0.3 });
    await r.real(1.0, { fps: 10 });
    await r.zoomTo(r.focus(await r.rect("#boardStats"), 960), 1.0);
    await r.hold(2.2);
    await r.zoomTo(r.focus(await r.rect("#boardList .act-row.overdue"), 900), 1.0);
    await r.moveTo("#boardList .act-row.overdue .act-text", 0, 0.7, 0.3);
    await r.hold(Math.max(1, 10 - r.now()));
    await r.save();
  },
  // 镜 14 + 15:问资料库(MOI 智能体)→ 点出处回到录音。一段录完,按时间点拆
  async "14"() {
    const r = new Rec("镜14-15-问资料库MOI智能体", OUT);
    await r.open(undefined, async (r) => { await resolveReviews(r, true); await confirmM3(r); await sleep(800); });
    await r.click("#btnAsk", 0, { sec: 0.9, pause: 0.4, after: 0.4 });
    await r.click("#askInput", 0, { sec: 0.6, pause: 0.2, after: 0.2 });
    await r.type("小林手上还有什么没做完？", 0.11);
    await r.hold(0.4);
    await r.click("#btnAskSend", 0, { sec: 0.6, pause: 0.4, after: 0.2 });
    const t0 = r.now();
    await r.real(150, { fps: 3, speed: 3, until: async () => r.eval(`(() => { const b = [...document.querySelectorAll('#askLog .ask-msg.bot')].pop(); return !!b && !b.classList.contains('cursor'); })()`) });
    r.overlay(CARD("角标-3倍速.png"), t0, r.now(), "W-w-24", "70");
    r.mark("回答出来");
    await r.hold(1.5);
    const h = await r.eval(`document.getElementById('askLog').scrollHeight - document.getElementById('askLog').clientHeight`);
    const s0 = await r.eval(`document.getElementById('askLog').scrollTop`);
    await r.anim(3.5, (t) => r.eval(`document.getElementById('askLog').scrollTop = ${s0} + (${h} - ${s0}) * ${t} * 0.6`));
    r.mark("镜15开始");
    const cites = await r.eval(`document.querySelectorAll('#askLog .ask-msg.bot a.cite').length`);
    if (!cites) throw new Error("回答里没有可点的出处:" + (await r.eval(`[...document.querySelectorAll('#askLog .ask-msg.bot')].pop()?.innerText.slice(0, 300)`)));
    await r.click("#askLog .ask-msg.bot a.cite", Math.min(1, cites - 1), { sec: 0.9, pause: 0.6, after: 0.3 });
    await r.real(4.5, { fps: 8 });
    await r.hold(1.0);
    await r.save();
  },
};

for (const [k, fn] of Object.entries(shots)) {
  if (only.length && !only.includes(k)) continue;
  try { await fn(); } catch (e) { console.error(`✗ 镜 ${k}:`, (e as Error).message); }
}
process.exit(0);
