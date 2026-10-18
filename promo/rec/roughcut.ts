// 粗剪:TTS 旁白占位 + 现有录屏和字卡 + 你要录的镜头用占位卡,按分镜拼成一条,定节奏用。
// bun roughcut.ts <视频素材目录> <分镜.md>
// 旁白从分镜文件的「录音稿」读;每镜时长取分镜时长,旁白念不完就定格画面顺延。
import { Page, sleep } from "./cdp.ts";
import { launchChrome } from "./rec.ts";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const SRC = process.argv[2];
const STORY = process.argv[3];
const OUT = path.join(SRC, "粗剪");
const TMP = "/tmp/sanhui-roughcut";
mkdirSync(OUT, { recursive: true }); mkdirSync(TMP, { recursive: true }); mkdirSync(path.join(OUT, "旁白-TTS"), { recursive: true });
const EDGE = `${process.env.HOME}/Desktop/泰语学习/bianzi-thai/.venv/bin/edge-tts`;
const VOICE = "zh-CN-YunyangNeural", RATE = "+10%";
const VER = process.env.VER || "v3"; // 粗剪版本号,写进输出文件名
const LEAD = 0.3, TAIL = 0.45; // 旁白在镜头开始后 0.3 秒进;念完至少留 0.45 秒

const run = (args: string[]) => { const r = Bun.spawnSync(args); if (r.exitCode) throw new Error(args.slice(0, 3).join(" ") + " 失败:" + r.stderr.toString().slice(-500)); return r.stdout.toString(); };
const dur = (f: string) => +run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).trim();

// ---------- 读分镜 ----------
const md = readFileSync(STORY, "utf8");
const lines: Record<number, string> = {};
for (const m of md.split("## 录音稿")[1].split(/\n## /)[0].matchAll(/^(\d+)\. (.+)$/gm)) lines[+m[1]] = m[2].trim(); // 只读「录音稿」这一节
const slots: Record<number, number> = {};
for (const m of md.matchAll(/^\| (\d+) \| (\d+):(\d{2})–(\d+):(\d{2}) \|/gm)) slots[+m[1]] = (+m[4] * 60 + +m[5]) - (+m[2] * 60 + +m[3]);

// ---------- 镜头素材 ----------
type Piece = { file: string; from?: number; to?: number; fit?: boolean };
const R = (n: string) => path.join(SRC, "录屏", n + ".mp4");
const C = (n: string) => path.join(SRC, "字卡", n + ".mp4");
// 你录的镜头放在 <视频素材>/你录的/镜05.mov(.mp4) 这样的名字,有就用,没有就用占位卡;截图(png/jpg)也行,会做成 12 秒定格
const MINE = (n: number) => {
  const f = ["mov", "mp4", "m4v", "png", "jpg"].map((e) => path.join(SRC, "你录的", `镜${String(n).padStart(2, "0")}.${e}`)).find((f) => existsSync(f));
  if (!f || !/\.(png|jpg)$/.test(f)) return f;
  const v = path.join(TMP, `你录的-镜${n}.mp4`);
  run(["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-t", "12", "-i", f, "-vf", "fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0xf5f6f8,format=yuv420p", "-c:v", "libx264", "-crf", "18", v]);
  return v;
};
const P = (n: number) => MINE(n) || path.join(TMP, `占位-镜${n}.mp4`);
// 第 11 镜:设置里的任务提醒录屏打底,你截的真通知(你录的/镜11-通知.png)在旁白说到「弹通知」时从右边滑进来
// 录屏期间 macOS 不显示通知横幅,只能这样拼;合成结果另存一份到 录屏/,方便你在剪辑软件里直接用
function shot11(): string {
  const mine = MINE(11), base = R("镜11-任务提醒"), note = path.join(SRC, "你录的", "镜11-通知.png");
  if (mine) return mine;
  if (!existsSync(base)) return P(11);
  if (!existsSync(note)) return base;
  const out = R("镜11-任务提醒-加通知");
  const T0 = 2.6, D = 0.45, RAD = 12; // 第 2.6 秒滑入,0.45 秒到位;截图圆角半径(截图像素)
  const round = `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(abs(W/2-X),W/2-${RAD})*gt(abs(H/2-Y),H/2-${RAD}),if(lte(hypot(${RAD}-(W/2-abs(W/2-X)),${RAD}-(H/2-abs(H/2-Y))),${RAD}),255,0),255)'`;
  const slide = (dx: number) => `x='main_w-overlay_w-24+${dx}+(overlay_w+24)*pow(1-min(max((t-${T0})/${D},0),1),3)'`;
  run(["ffmpeg", "-y", "-loglevel", "error", "-i", base, "-loop", "1", "-i", note, "-filter_complex",
    `[1:v]format=rgba,${round},scale=iw*1.35:-1:flags=lanczos,pad=iw+60:ih+60:30:30:color=black@0,split[n][s];` +
    `[s]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.32,boxblur=14:3[sh];` +
    `[0:v][sh]overlay=${slide(0)}:y=54:shortest=1:enable='gte(t,${T0})'[v1];[v1][n]overlay=${slide(0)}:y=46:shortest=1:enable='gte(t,${T0})',format=yuv420p[o]`,
    "-map", "[o]", "-an", "-t", dur(base).toFixed(3), "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-movflags", "+faststart", out]); // 循环的截图会把长度拖长,按底片截齐
  return out;
}
const plan: Record<number, Piece[]> = {
  1: [{ file: R("镜01-会前汇报逾期7") }],
  2: [{ file: R("镜02-九条候选标记完成"), fit: true }],
  3: [{ file: C("镜03-问题") }],
  4: [{ file: C("镜04-片名") }, { file: R("镜04-网页版全景"), to: 10 }],
  5: [{ file: P(5) }],
  6: [{ file: P(6), fit: true, to: MINE(6) ? undefined : 4 }, { file: R("镜06-逐字稿"), to: 6 }],
  7: [{ file: R("镜07-待确认任务"), to: 12 }],
  8: [{ file: R("镜08-点原话回放") }],
  9: [{ file: R("镜09-改日期并确认") }],
  10: [{ file: R("镜10-认领消息") }],
  11: [{ file: shot11() }],
  12: [{ file: R("镜12-下次开会对照") }],
  13: [{ file: R("镜13-看板逾期剩1") }],
  14: [{ file: R("镜14-15-问资料库MOI智能体"), to: 15.3 }],
  15: [{ file: R("镜14-15-问资料库MOI智能体"), from: 15.3 }],
  16: [{ file: P(16) }],
  17: [{ file: C("镜17-网址") }],
};
const placeholders: Record<number, string> = {
  5: "Mac 右上角弹窗「腾讯会议 好像在开会」<br>第一行要有「📊 上次会议…」",
  6: "菜单栏红点计时 3 秒 → 点停止",
  11: "macOS 右上角通知「散会即开工 · 任务提醒」",
  16: "MOI 控制台:知识库 4 份文档「处理成功」<br>→ 智能体「散会即开工助手」详情页",
};

// ---------- 占位卡 ----------
await launchChrome();
const page = await Page.open(9223);
await page.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
for (const [n, text] of Object.entries(placeholders)) {
  if (!plan[+n].some((p) => p.file === P(+n)) || MINE(+n)) continue; // 已经有素材的镜头不做占位卡
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;width:1920px;height:1080px;background:#e5e7eb;font-family:"PingFang SC",sans-serif;display:flex;align-items:center;justify-content:center}
  .b{width:1500px;height:760px;border:6px dashed #9ca3af;border-radius:40px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:36px;color:#374151}
  .t{font-size:44px;color:#6b7280;letter-spacing:.1em}.d{font-size:64px;font-weight:600;line-height:1.5}</style>
  <div class="b"><div class="t">待你录制 · 第 ${n} 镜</div><div class="d">${text}</div></div>`;
  await page.goto("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await sleep(250);
  const png = path.join(TMP, `占位-镜${n}.png`);
  await page.shot(png);
  run(["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-t", "12", "-i", png, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "20", P(+n)]);
}
await page.close();

// ---------- TTS ----------
const tts: Record<number, { file: string; len: number }> = {};
for (const [n, text] of Object.entries(lines)) {
  const h = createHash("md5").update(VOICE + RATE + text).digest("hex").slice(0, 8);
  const f = path.join(OUT, "旁白-TTS", `镜${String(n).padStart(2, "0")}-${h}.mp3`);
  if (!existsSync(f)) run([EDGE, "--voice", VOICE, `--rate=${RATE}`, "--text", text, "--write-media", f]);
  tts[+n] = { file: f, len: dur(f) };
}

// ---------- 逐镜合成画面(定长,不够定格,超了快放或裁掉) ----------
const segs: string[] = [];
const timeline: { n: number; start: number; len: number; slot: number; vo: number; over: number }[] = [];
let t = 0;
for (const n of Object.keys(plan).map(Number).sort((a, b) => a - b)) {
  const slot = slots[n];
  const vo = tts[n]?.len || 0;
  const len = Math.max(slot, +(LEAD + vo + TAIL).toFixed(2));
  // 先把这一镜的几段素材各自裁好
  const parts: string[] = [];
  let used = 0;
  plan[n].forEach((pc, i) => {
    const src = pc.file;
    const full = dur(src);
    const from = pc.from || 0;
    const to = Math.min(pc.to ?? full, full);
    let d = to - from;
    const last = i === plan[n].length - 1;
    const target = last ? len - used : d;
    const f = path.join(TMP, `seg${n}-${i}.mp4`);
    let vf = "fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0xf5f6f8,setsar=1";
    if (last && d > target && pc.fit && d / target <= 1.35) vf = `setpts=PTS*${(target / d).toFixed(4)},` + vf; // 快放到合适长度
    if (last && d < target) vf += `,tpad=stop_mode=clone:stop_duration=${(target - d).toFixed(3)}`; // 不够就定格
    run(["ffmpeg", "-y", "-loglevel", "error", "-ss", String(from), "-t", String(d), "-i", src, "-an", "-vf", vf, "-t", target.toFixed(3), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", f]);
    used += target;
    parts.push(f);
  });
  segs.push(...parts);
  timeline.push({ n, start: +t.toFixed(2), len: +len.toFixed(2), slot, vo: +vo.toFixed(2), over: +(len - slot).toFixed(2) });
  t += len;
}
const list = path.join(TMP, "segs.txt");
writeFileSync(list, segs.map((s) => `file '${s}'`).join("\n"));
const video = path.join(TMP, "video.mp4");
run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", video]);

// ---------- 旁白轨 ----------
const total = dur(video);
const inputs: string[] = [], filters: string[] = [];
timeline.forEach((s, i) => {
  if (!tts[s.n]) return;
  inputs.push("-i", tts[s.n].file);
  const ms = Math.round((s.start + LEAD) * 1000);
  filters.push(`[${inputs.length / 2}:a]aresample=48000,adelay=${ms}|${ms}[a${i}]`);
});
const labels = timeline.filter((s) => tts[s.n]).map((_, i) => `[a${i}]`).join("");
const out = path.join(OUT, `散会即开工-粗剪${VER}-TTS旁白占位.mp4`);
run(["ffmpeg", "-y", "-loglevel", "error", "-i", video, ...inputs, "-filter_complex", `${filters.join(";")};${labels}amix=inputs=${filters.length}:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,apad,atrim=0:${total.toFixed(3)}[aout]`,
  "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out]);

// ---------- 时间轴 + 字幕 ----------
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const srtT = (s: number) => { const ms = Math.round(s * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`; };
const srt = timeline.filter((s) => lines[s.n]).map((s, i) => `${i + 1}\n${srtT(s.start + LEAD)} --> ${srtT(s.start + LEAD + s.vo)}\n${lines[s.n]}\n`).join("\n");
writeFileSync(path.join(OUT, `粗剪${VER}-旁白字幕.srt`), srt);
const rows = timeline.map((s) => `| ${s.n} | ${fmt(s.start)} | ${s.len.toFixed(1)} 秒 | ${s.slot} 秒 | ${s.vo.toFixed(1)} 秒 | ${s.over > 0.05 ? `**超 ${s.over.toFixed(1)} 秒**` : "—"} | ${plan[s.n].some((p) => p.file.includes("占位")) ? "占位,待你录" : plan[s.n].some((p) => p.file.includes("你录的")) ? "用了「你录的」里的素材" : ""} |`);
writeFileSync(path.join(OUT, `粗剪${VER}-时间轴.md`), [
  `# 粗剪 ${VER} 时间轴(TTS 旁白占位)`, "",
  `- 成片总长 **${fmt(total)}**(分镜计划 2:56)。旁白声音:${VOICE},语速 ${RATE},只是占位。`,
  "- 「超」表示这一镜旁白念不完,画面定格顺延了;录真声时这几镜可以念快一点,或者删几个字。", "",
  "| 镜 | 开始 | 本镜时长 | 分镜计划 | TTS 旁白 | 超出 | 备注 |", "|---|---|---|---|---|---|---|", ...rows, ""].join("\n"));
console.log(`✓ ${out}\n  总长 ${fmt(total)}`);
for (const s of timeline) if (s.over > 0.05) console.log(`  镜 ${s.n} 超 ${s.over.toFixed(1)} 秒(旁白 ${s.vo.toFixed(1)} 秒 / 计划 ${s.slot} 秒)`);
process.exit(0);
