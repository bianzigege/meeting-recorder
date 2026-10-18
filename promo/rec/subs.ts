// 中英双语字幕草稿:按粗剪时间轴(TTS 旁白)排时间,每条两行,中文在上、英文在下。
// bun subs.ts <视频素材目录> [版本号 v3]
//   → 录音会议/promo/字幕/散会即开工-双语字幕-草稿.srt
//   → <视频素材>/粗剪/粗剪<版本>-双语字幕草稿.srt、散会即开工-粗剪<版本>-双语字幕预览.mp4(烧进画面,看断句和节奏)
// 真声录好后要按真声重新对时间;断句和译文可以沿用。英文用词以 promo/产品知识包.md 的术语表为准。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const SRC = process.argv[2];
const VER = process.argv[3] || "v3";
const CUT = path.join(SRC, "粗剪");
const LEAD = 0.3; // 和 roughcut.ts 一致:旁白在镜头开始后 0.3 秒进

// 每镜的字幕:[中文, English]。中文一行不超过 16 个字
const CUES: Record<number, [string, string][]> = {
  1: [["上次会议定了八件事，七件显示逾期", "Last meeting set 8 tasks. 7 show as overdue."]],
  2: [["其实大部分早就做完了", "Most were actually done long ago —"], ["只是没人回来更新", "nobody came back to update them."]],
  3: [["会上定的事，散会就忘", "Decisions are forgotten the moment the meeting ends."], ["纪要没人写，写了也没人看", "No one writes the minutes, and no one reads them."], ["谁负责、做完没", "Who owns it? Is it done?"], ["最后都得去翻群聊", "You end up digging through group chats."]],
  4: [["这是散会即开工", "This is Sanhui (Meeting → Action)."], ["AI 写纪要，现在谁都会", "Any AI can write minutes now."], ["它做的是下一步", "Sanhui does the next step:"], ["把会上定的事变成任务", "it turns decisions into tasks"], ["再跨会议一直跟到做完", "and follows them across meetings until they're done."]],
  5: [["会议软件一开麦", "When your meeting app turns on the mic,"], ["右上角就会问你要不要录", "a prompt in the corner asks if you want to record"], ["顺带告诉你，上次定的事做完了几件", "and tells you how many tasks from last time are done."]],
  6: [["录音分成你和对方两条声音", "Audio is split into two tracks: you and the others."], ["在你自己的电脑上离线转成文字", "It's transcribed offline on your own computer."], ["录音不出电脑", "The audio never leaves your Mac."]],
  7: [["散会后，AI 把任务挑出来", "After the meeting, AI picks out the tasks:"], ["谁做、做什么、什么时候交", "who, what, and by when,"], ["每条带着原话", "each with the original quote."], ["我拿自己一场二十二分钟的会试过", "I tried it on a 22-minute meeting of my own:"], ["四十六秒，提出七件事", "46 seconds, 7 tasks."]],
  8: [["点原话，就从录音里那一句开始播", "Click the original quote to play from that exact line."], ["当时谁怎么说的，一听就清楚", "You hear exactly who said what."]],
  9: [["AI 提出来的，先放在待确认", "AI suggestions go to Pending review first."], ["负责人、日期都能改", "You can change the owner and the date."], ["你点了确认才算数", "Nothing counts until you confirm it."]],
  10: [["确认完，按负责人分好组", "Once confirmed, tasks are grouped by owner"], ["生成一条认领消息，复制到群里", "into a claim message you paste into the group chat,"], ["各人认领各人的", "so everyone claims their own."]],
  11: [["之后每天早上九点，电脑会弹通知", "Every morning at 9, your Mac sends a notification"], ["提醒哪些已经逾期、哪些今天到期", "about what's overdue and what's due today."]],
  12: [["到了下次开会，转写一完成", "At the next meeting, once transcription finishes,"], ["它会把之前没做完的事", "it checks the earlier open tasks"], ["和新录音对一遍", "against the new recording."], ["比如小林说样品到了、照片发群里了", "Say Xiaolin mentions the samples arrived and the photos are posted —"], ["它就提示把这件标成完成", "it suggests marking that task done."]],
  13: [["对完一遍，逾期从七件剩下一件", "After one pass, overdue drops from 7 to 1."], ["剩下的这件，会上确实没人提", "And the one left really wasn't mentioned."]],
  14: [["想追问，就打开问资料库", "Want to dig deeper? Open Ask the library."], ["我问：小林手上还有什么没做完？", "I ask: what does Xiaolin still have open?"], ["问题会交给 MOI 上的智能体", "The question goes to an agent on MOI."], ["它先去知识库里检索，再整理回答", "It searches the knowledge base, then writes the answer."]],
  15: [["回答里每一句都标了", "Every sentence in the answer is tagged"], ["是哪场会、第几分钟", "with the meeting and the minute."], ["点一下，就回到录音里那一句", "Click it to jump back to that line in the recording."]],
  16: [["这背后用的是 MOI", "Under the hood, it's MOI:"], ["三场会议存进知识库", "the three meetings live in a knowledge base,"], ["智能体查着知识库来回答", "the agent answers by searching it,"], ["提任务和写纪要", "and task extraction and minutes"], ["用的是 Genesis 模型", "run on Genesis models."]],
  17: [["散会即开工，网页版打开就能试", "Sanhui: open the web version and try it now."], ["地址在屏幕上", "The link is on screen."]],
};

// 读粗剪时间轴:每镜开始时间和 TTS 旁白长度
const axis = readFileSync(path.join(CUT, `粗剪${VER}-时间轴.md`), "utf8");
const shots: Record<number, { start: number; vo: number }> = {};
for (const m of axis.matchAll(/^\| (\d+) \| (\d+):([\d.]+) \| [\d.]+ 秒 \| \d+ 秒 \| ([\d.]+) 秒 \|/gm)) shots[+m[1]] = { start: +m[2] * 60 + +m[3], vo: +m[4] };

type Cue = { from: number; to: number; zh: string; en: string };
const cues: Cue[] = [];
const weight = (s: string) => s.replace(/[\s，。：；？！、]/g, "").length + 2; // 加一点基数,短句别太快闪过
for (const [n, list] of Object.entries(CUES)) {
  const s = shots[+n];
  if (!s) throw new Error(`时间轴里没有第 ${n} 镜`);
  const total = list.reduce((a, [zh]) => a + weight(zh), 0);
  let t = s.start + LEAD;
  for (const [zh, en] of list) {
    const d = (s.vo * weight(zh)) / total;
    cues.push({ from: t, to: t + d - 0.04, zh, en });
    t += d;
  }
  for (const [zh] of list) if (zh.replace(/\s/g, "").length > 16) console.warn(`第 ${n} 镜这一行超过 16 字:${zh}`);
}

const srtT = (s: number) => { const ms = Math.round(s * 1000); return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`; };
const srt = cues.map((c, i) => `${i + 1}\n${srtT(c.from)} --> ${srtT(c.to)}\n${c.zh}\n${c.en}\n`).join("\n");
const promoDir = path.join(import.meta.dir, "..", "字幕");
mkdirSync(promoDir, { recursive: true });
writeFileSync(path.join(promoDir, "散会即开工-双语字幕-草稿.srt"), srt);
writeFileSync(path.join(CUT, `粗剪${VER}-双语字幕草稿.srt`), srt);

// 烧字幕预览:中文白字、英文小一号米白;界面是浅色的,细描边压在界面文字上看不清,所以加半透明深色底
const assT = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${(s % 60).toFixed(2).padStart(5, "0")}`;
const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ZH,PingFang SC,54,&H00FFFFFF,&H00FFFFFF,&H60141414,&H00000000,1,0,0,0,100,100,1,0,3,9,0,2,80,80,60,1
Style: EN,Helvetica Neue,36,&H00D7EBF5,&H00D7EBF5,&H60141414,&H00000000,0,0,0,0,100,100,0,0,3,9,0,2,80,80,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${cues.map((c) => `Dialogue: 0,${assT(c.from)},${assT(c.to)},ZH,,0,0,0,,${c.zh}\\N{\\rEN}${c.en}`).join("\n")}
`;
const assFile = path.join("/tmp", `sanhui-subs-${VER}.ass`);
writeFileSync(assFile, ass);
const video = path.join(CUT, `散会即开工-粗剪${VER}-TTS旁白占位.mp4`);
const out = path.join(CUT, `散会即开工-粗剪${VER}-双语字幕预览.mp4`);
const r = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-i", video, "-vf", `ass=${assFile}`, "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-c:a", "copy", "-movflags", "+faststart", out]);
if (r.exitCode) throw new Error("烧字幕失败:" + r.stderr.toString().slice(-400));
console.log(`✓ ${cues.length} 条字幕\n  ${path.join(promoDir, "散会即开工-双语字幕-草稿.srt")}\n  ${out}`);
process.exit(0);
