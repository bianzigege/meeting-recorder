// 成片:粗剪(AI 配音旁白)+ 会议原声 + 烧中英双语字幕。bun final.ts <视频素材目录> [粗剪版本 v4]
// 先跑 roughcut.ts 和 subs.ts(subs.ts 会生成 /tmp/sanhui-subs-<版本>.ass)。→ <目录>/成片/散会即开工-演示视频.mp4
// 会议原声:第 8 镜点原话后垫周姐那句(旁白念完抬起来,「一听就清楚」之后真能听到);第 12 镜压低垫在旁白下面。
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const SRC = process.argv[2];
const VER = process.argv[3] || "v4";
const CUT = path.join(SRC, "粗剪");
const video = path.join(CUT, `散会即开工-粗剪${VER}-TTS旁白占位.mp4`);
const ass = `/tmp/sanhui-subs-${VER}.ass`;
if (!existsSync(ass)) throw new Error(`没有 ${ass},先跑 bun subs.ts <目录> ${VER}`);
const OUT_DIR = path.join(SRC, "成片");
mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, "散会即开工-演示视频.mp4");

const axis = readFileSync(path.join(CUT, `粗剪${VER}-时间轴.md`), "utf8");
const shot: Record<number, { start: number; len: number; vo: number }> = {};
for (const m of axis.matchAll(/^\| (\d+) \| (\d+):([\d.]+) \| ([\d.]+) 秒 \| \d+ 秒 \| ([\d.]+) 秒 \|/gm)) shot[+m[1]] = { start: +m[2] * 60 + +m[3], len: +m[4], vo: +m[5] };
const LEAD = 0.3;

// 原声:at = 本镜里点原话后开始播的时间;quietUntil 之前压低(让旁白),之后正常音量;在本镜结束前淡出
const clips = [
  { n: 8, file: "镜08-第三场0035-周姐改脚本.m4a", at: 2.1, low: 0.18, high: 0.9, quietUntil: LEAD + shot[8].vo + 0.15 },
  { n: 12, file: "镜12-第三场0003-小林样品到了.m4a", at: 3.5, low: 0.16, high: 0.16, quietUntil: 99 },
];
const args = ["-i", video];
const fl: string[] = [];
clips.forEach((c, i) => {
  const s = shot[c.n];
  const startAbs = s.start + c.at;
  const dur = Math.min(s.len - c.at - 0.1, 12);
  const q = Math.max(0, c.quietUntil - c.at);
  args.push("-i", path.join(SRC, "会议原声", c.file));
  fl.push(`[${i + 1}:a]atrim=0:${dur.toFixed(2)},asetpts=PTS-STARTPTS,aresample=48000,` +
    `volume='if(lt(t,${q.toFixed(2)}),${c.low},${c.low}+(${c.high}-${c.low})*min(1,(t-${q.toFixed(2)})/0.35))':eval=frame,` +
    `afade=t=in:d=0.15,afade=t=out:st=${Math.max(0, dur - 0.6).toFixed(2)}:d=0.6,adelay=${Math.round(startAbs * 1000)}|${Math.round(startAbs * 1000)}[m${i}]`);
});
fl.push(`[0:a]aresample=48000[vo]`);
fl.push(`[vo]${clips.map((_, i) => `[m${i}]`).join("")}amix=inputs=${clips.length + 1}:normalize=0:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`);
// 分两步:音轨单独合成再和画面合并。放在同一条滤镜链里时,原声要延时七十多秒,和慢速视频编码一起跑会被丢成静音
const wav = "/tmp/sanhui-final-audio.wav";
const run = (a: string[]) => { const x = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", ...a]); if (x.exitCode) throw new Error("合成失败:" + x.stderr.toString().slice(-600)); };
if (process.env.DEBUG) console.log(args.join(" "), "\n", fl.join(";\n"));
run([...args, "-filter_complex", fl.join(";"), "-map", "[aout]", "-ar", "48000", wav]);
run(["-i", video, "-i", wav, "-filter_complex", `[0:v]ass=${ass}[vout]`, "-map", "[vout]", "-map", "1:a",
  "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out]);
const d = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration,size", "-of", "csv=p=0", out]).stdout.toString().trim();
console.log(`✓ ${out}\n  时长,大小: ${d}`);
process.exit(0);
