// 生成放进 MOI 知识库的文档:bun web/kb-build.ts → web/kb/*.md
// 每场会议一份(会议信息、纪要、本场任务、带时间点的逐字稿),外加一份任务总表(演示初始状态)。
// 网页版提问时会把访客当前的任务状态随问题一起发给智能体,所以总表只是给在 MOI 里直接提问的人兜底。
import { readdir, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import * as core from "../shared/core.js";

const WEB = import.meta.dir;
const SAMPLES = path.resolve(WEB, "..", "samples", "meetings");
const OUT = path.join(WEB, "kb");
const TODAY = "2026-10-27";
const PROJECT = "橙子美妆 TikTok 直播代运营";
const ROLES: Record<string, string> = { 周姐: "项目负责人", 小林: "运营执行" };

const readJson = async (p: string, d: any) => (existsSync(p) ? JSON.parse(await readFile(p, "utf8")) : d);
const md = (iso: string) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
const clock = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Bangkok" });
const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "/").replace(/\n/g, " ");

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const ids = (await readdir(SAMPLES)).filter((d) => /^\d{8}-\d{6}/.test(d)).sort();
const meetings = [];
for (const id of ids) {
  const dir = path.join(SAMPLES, id);
  const meta = await readJson(path.join(dir, "meta.json"), null);
  meetings.push({
    id, meta,
    transcript: await readFile(path.join(dir, "transcript.txt"), "utf8"),
    minutes: existsSync(path.join(dir, "results", "minutes.md")) ? await readFile(path.join(dir, "results", "minutes.md"), "utf8") : "",
    actions: await readJson(path.join(dir, "actions.json"), []),
  });
}
const refOf = new Map(meetings.map((m, i) => [m.id, `M${i + 1}`]));

const files: string[] = [];
for (const [i, m] of meetings.entries()) {
  const ref = `M${i + 1}`;
  const people = Object.values(m.meta.speakerNames || {}).map((n: any) => `${n}(${ROLES[n] || "参会人"})`).join("、");
  const rows = m.actions.map((a: any) => `| ${cell(a.text)} | ${cell(a.owner || "待定")} | ${cell(a.due || a.dueText || "待定")} | ${core.STATUS_CN[a.status as keyof typeof core.STATUS_CN] || a.status} | ${a.source ? `${core.fmtTime(a.source.t)} 「${cell(a.source.quote)}」` : ""} |`);
  const doc = [
    `# ${ref} 会议记录:${m.meta.title}`,
    "",
    `- 会议编号:${ref}(同一项目的第 ${i + 1} 场会议,共 ${meetings.length} 场)`,
    `- 项目:${PROJECT}`,
    `- 时间:${core.meetingDateLine(m.meta.createdAt)} ${clock(m.meta.createdAt)}(曼谷时间),时长 ${core.fmtTime(m.meta.durationSec)}`,
    `- 参会人:${people}`,
    "",
    "## 会议纪要",
    "",
    m.minutes.trim() || "(无)",
    "",
    "## 本场会议定下的任务",
    "",
    rows.length ? "| 任务 | 负责人 | 截止 | 状态(演示初始) | 原话出处 |\n|---|---|---|---|---|\n" + rows.join("\n") : "(本场没有提取到任务)",
    "",
    "## 逐字稿(行首是会议内的时间点 mm:ss)",
    "",
    m.transcript.trim(),
    "",
  ].join("\n");
  const name = `${ref}-${md(m.meta.createdAt).replace("/", "月")}日-${m.meta.title}.md`;
  await writeFile(path.join(OUT, name), doc);
  files.push(name);
}

// 任务总表
const all = meetings.flatMap((m) => m.actions.map((a: any) => ({ ...a, ref: refOf.get(m.id), title: m.meta.title, at: m.meta.createdAt })));
const order: Record<string, number> = { doing: 0, todo: 1, pending: 2, done: 3, dropped: 4 };
all.sort((a, b) => order[a.status] - order[b.status] || String(a.due || "9").localeCompare(String(b.due || "9")));
const table = [
  `# 任务总表:${PROJECT}`,
  "",
  `- 状态截至 ${TODAY}(第三场会议的第二天),是网页演示版打开时的初始状态。`,
  "- 「待确认」是 AI 从第三场会议里新提取、还没人确认的任务。",
  "- 出处写成「会议编号 时间点」,例如 M2 00:48 表示第二场会议第 0 分 48 秒。",
  "",
  "| 任务 | 负责人 | 截止 | 状态 | 定下它的会议 | 出处 | 备注 |",
  "|---|---|---|---|---|---|---|",
  ...all.map((a) => `| ${cell(a.text)} | ${cell(a.owner || "待定")} | ${cell(a.due || "待定")} | ${core.STATUS_CN[a.status as keyof typeof core.STATUS_CN] || a.status} | ${a.ref}「${cell(a.title)}」${md(a.at)} | ${a.source ? `${a.ref} ${core.fmtTime(a.source.t)}` : ""} | ${cell(a.note || "")} |`),
  "",
].join("\n");
await writeFile(path.join(OUT, "任务总表.md"), table);
files.push("任务总表.md");
console.log(files.map((f) => `web/kb/${f}`).join("\n"));
