// 会议录音 → 转写 → 纪要 的本地服务端(Bun)
// 启动: bun run server.ts   然后打开 http://localhost:3456
// 双击 会议录音纪要.app 会自动启动本服务并打开窗口

import Anthropic from "@anthropic-ai/sdk";
import * as core from "./shared/core.js";
import { COMMON_RULES, DEFAULT_TEMPLATES, type Template } from "./templates.ts";
import { Database } from "bun:sqlite";
import { mkdir, readdir, readFile, writeFile, rm, rename, stat, cp, copyFile, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const MEETINGS_DIR = process.env.MEETINGS_DIR ? path.resolve(process.env.MEETINGS_DIR) : path.join(ROOT, "meetings"); // 可指到别处(示例数据 / 线上版)
const CONFIG_PATH = path.join(ROOT, "config.json");
const TRANSCRIBE_BIN = path.join(ROOT, "bin", "transcribe");
const TRANSCRIBE_SRC = path.join(ROOT, "native", "transcribe.swift");
const RECORDER_APP = path.join(ROOT, "bin", "录制助手.app");
const RECORDER_BIN = path.join(RECORDER_APP, "Contents", "MacOS", "recorder");
const RECORDER_SRC = path.join(ROOT, "native", "record.swift");
// 录制助手写文件的地方。放在 Library 里是为了不触发"访问桌面文件夹"的权限弹窗,录完再搬进 meetings/
const REC_WORK_DIR = path.join(os.homedir(), "Library", "Application Support", "MeetingRecorder");
const PORT = Number(process.env.PORT || 3456);
const APP_MODE = process.env.APP_MODE === "1"; // 由 .app 启动:窗口关掉后自动退出

// ---------- 配置 ----------
// 优先级:config.json(网页里保存的) > 环境变量 / .env > 默认值
type Config = {
  // 转写
  transcribeProvider: "local" | "api"; // local = macOS 自带语音识别(离线,免费);api = Whisper 兼容接口
  transcribeBaseUrl: string;
  transcribeApiKey: string;
  transcribeModel: string;
  transcribeLanguage: string; // zh / en / 留空自动(仅 api 支持自动)
  // 纪要
  summaryProvider: "cli" | "api" | "openai"; // cli = 本机登录的 Claude Code 账号;api = Anthropic API Key;openai = OpenAI 兼容接口(MOI Genesis 等)
  claudeCliPath: string; // 留空自动查找
  claudeCliModel: string; // opus / sonnet / 完整模型名
  anthropicApiKey: string;
  anthropicBaseUrl: string;
  claudeModel: string;
  openaiBaseUrl: string; // OpenAI 兼容接口地址,如 https://token.moi.matrixorigin.cn/v1
  openaiApiKey: string;
  openaiModel: string;
  summaryPrompt: string;
  myName: string; // 逐字稿里代替「我」的名字
  // 自动化("1" 开 / "0" 关)
  autoTranscribe: string; // 录制、导入后自动转写
  autoAnalyze: string; // 转写完自动用「默认勾选」的模板分析
  autoImportVoiceMemos: string; // 自动导入新的语音备忘录
  autoTitle: string; // 没起标题的,转写完让 Claude 根据内容起一个
  discardShort: string; // 少于 5 秒的录制自动放进最近删除
  backupDir: string; // 备份到哪个文件夹,空 = 不备份
  backupScope: string; // text = 只备份文字;audio = 文字 + 音频;all = 全部(含视频)
  voiceMemosSince: string; // 只自动导入这个时间(毫秒)之后录的备忘录
  autoExtractActions: string; // 转写完自动提取行动项
  remindEnabled: string; // 每天按时提醒到期 / 逾期的任务(macOS 通知)
  remindHour: string; // 几点提醒(0-23)
};

const DEFAULT_SUMMARY_PROMPT = `你是一位专业的会议记录员。根据下面的会议转写文本,输出一份结构化的中文会议纪要,使用 Markdown 格式,包含以下部分:

## 会议概要
用 2-4 句话概括这次会议讨论了什么、达成了什么。

## 讨论要点
按议题分条列出,每条写清楚背景、各方观点和结论。

## 决议事项
明确已经拍板的决定。没有就写"无"。

## 待办事项
用表格列出:事项 | 负责人 | 截止时间。转写里没提到的负责人/时间写"待定"。

## 遗留问题
还没讨论清楚、需要下次跟进的问题。

要求:
- 只依据转写内容,不要编造。转写可能没有标点、有口误、重复、语气词,整理时要自行断句并去掉冗余。
- 人名、项目名、数字要和原文保持一致。
- 如果转写内容太短或根本不像会议,直接说明情况。
- 直接输出纪要正文,不要使用任何工具,不要加开场白和结尾。`;

function envDefaults(): Config {
  return {
    transcribeProvider: (process.env.TRANSCRIBE_PROVIDER as Config["transcribeProvider"]) || "local",
    transcribeBaseUrl: process.env.TRANSCRIBE_BASE_URL || "https://api.groq.com/openai/v1",
    transcribeApiKey: process.env.TRANSCRIBE_API_KEY || process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || "",
    transcribeModel: process.env.TRANSCRIBE_MODEL || "whisper-large-v3-turbo",
    transcribeLanguage: process.env.TRANSCRIBE_LANGUAGE || "zh",
    summaryProvider: (process.env.SUMMARY_PROVIDER as Config["summaryProvider"]) || "cli",
    claudeCliPath: process.env.CLAUDE_CLI_PATH || "",
    claudeCliModel: process.env.CLAUDE_CLI_MODEL || "opus",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "",
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || "",
    claudeModel: process.env.CLAUDE_MODEL || "claude-opus-5-5",
    openaiBaseUrl: process.env.GENESIS_BASE_URL || process.env.OPENAI_BASE_URL || "https://token.moi.matrixorigin.cn/v1",
    openaiApiKey: process.env.GENESIS_API_KEY || "",
    openaiModel: process.env.GENESIS_MODEL || "qwen3.8-flash",
    summaryPrompt: DEFAULT_SUMMARY_PROMPT,
    myName: "",
    autoTranscribe: "1",
    autoAnalyze: "0",
    autoImportVoiceMemos: "0",
    autoExtractActions: "1",
    remindEnabled: "1",
    remindHour: "9",
    autoTitle: "1",
    discardShort: "1",
    backupDir: "",
    backupScope: "text",
    voiceMemosSince: "0",
  };
}

async function loadConfig(): Promise<Config> {
  const base = envDefaults();
  if (!existsSync(CONFIG_PATH)) return base;
  try {
    const saved = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    const merged: Config = { ...base };
    for (const k of Object.keys(base) as (keyof Config)[]) {
      if (typeof saved[k] === "string" && saved[k] !== "") (merged as any)[k] = saved[k];
    }
    return merged;
  } catch {
    return base;
  }
}

async function saveConfig(patch: Record<string, unknown>) {
  let saved: Record<string, string> = {};
  if (existsSync(CONFIG_PATH)) {
    try { saved = JSON.parse(await readFile(CONFIG_PATH, "utf8")); } catch {}
  }
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === "string") saved[k] = v;
  }
  await writeFile(CONFIG_PATH, JSON.stringify(saved, null, 2));
}

// 返回给前端时把密钥打码
function maskConfig(c: Config) {
  const mask = (s: string) => (s ? s.slice(0, 6) + "…" + s.slice(-4) : "");
  return {
    ...c,
    transcribeApiKey: mask(c.transcribeApiKey),
    anthropicApiKey: mask(c.anthropicApiKey),
    openaiApiKey: mask(c.openaiApiKey),
    hasTranscribeKey: !!c.transcribeApiKey,
    hasAnthropicKey: !!c.anthropicApiKey,
    hasOpenaiKey: !!c.openaiApiKey,
    localTranscribeAvailable: process.platform === "darwin" && (existsSync(TRANSCRIBE_BIN) || existsSync(TRANSCRIBE_SRC)),
    claudeCliFound: findClaudeCli(c.claudeCliPath) || "",
  };
}

// ---------- 会议存储(每个会议一个文件夹) ----------
type Meta = {
  id: string;
  title: string;
  createdAt: string;
  durationSec: number;
  audioFile: string; // 播放 / 没有分轨时转写用的文件
  status: "recording" | "recorded" | "transcribing" | "transcribed" | "summarizing" | "done" | "error";
  error?: string;
  // 以下是原生录制才有的
  mode?: "both" | "audio" | "screen";
  hasVideo?: boolean;
  tracks?: { mic?: string; system?: string }; // 分轨音频,转写时分别标「我」「嘉宾」
  markers?: number[]; // 手动打点(秒)
  warnings?: string[];
  source?: { type: "voicememo"; id: string }; // 从语音备忘录导入的,记下原录音 id 防止重复导入
  speakerNames?: { mic?: string; system?: string }; // 「我」「嘉宾」显示成什么名字
  mediaRemoved?: boolean; // 录音文件已删除,只保留文字
  titleAuto?: boolean; // 标题是自动生成的占位(没手动起过),转写完可以让 Claude 起一个
  deletedAt?: string; // 在「最近删除」里
  transcribeModel?: string;
  claudeModel?: string;
};

function meetingDir(id: string) {
  if (!/^[\w-]+$/.test(id)) throw new Error("非法 id");
  return path.join(MEETINGS_DIR, id);
}

async function readMeta(id: string): Promise<Meta> {
  return JSON.parse(await readFile(path.join(meetingDir(id), "meta.json"), "utf8"));
}

async function writeMeta(meta: Meta) {
  await writeFile(path.join(meetingDir(meta.id), "meta.json"), JSON.stringify(meta, null, 2));
  scheduleBackup();
}

async function readTextIfExists(p: string) {
  return existsSync(p) ? readFile(p, "utf8") : "";
}

// ---------- 最近删除 / 存储 ----------
// 删除先移到 meetings/.trash,30 天后自动清掉;期间可以恢复
const TRASH_DIR = path.join(MEETINGS_DIR, ".trash");
const TRASH_DAYS = 30;
// 删掉的语音备忘录记一下,自动导入时不再导入
const VM_IGNORE_PATH = path.join(MEETINGS_DIR, ".ignored-voicememos.json");

async function loadVmIgnore(): Promise<string[]> {
  try { return JSON.parse(await readFile(VM_IGNORE_PATH, "utf8")); } catch { return []; }
}
async function setVmIgnored(uid: string, ignored: boolean) {
  const list = new Set(await loadVmIgnore());
  if (ignored) list.add(uid); else list.delete(uid);
  await mkdir(MEETINGS_DIR, { recursive: true });
  await writeFile(VM_IGNORE_PATH, JSON.stringify([...list]));
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const f of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, f.name);
    total += f.isDirectory() ? await dirSize(p) : (await stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

function trashDir(id: string) {
  if (!/^[\w-]+$/.test(id)) throw new Error("非法 id");
  return path.join(TRASH_DIR, id);
}

// duringFinalize:录制收尾时把太短的录音放进最近删除,这时 activeRec 还指着它
async function trashMeeting(id: string, duringFinalize = false) {
  if (activeRec?.id === id && !duringFinalize) throw new Error("这条正在录制,先停止录制再删除");
  const meta = await readMeta(id);
  // 还在排队的任务取消掉
  for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].meetingId === id && jobs[i].state === "queued") jobs.splice(i, 1);
  if (jobs.some((j) => j.meetingId === id && j.state === "running")) throw new Error("这条正在转写或分析,等处理完再删除");
  await mkdir(TRASH_DIR, { recursive: true });
  const dest = trashDir(id);
  await rm(dest, { recursive: true, force: true });
  await rename(meetingDir(id), dest);
  meta.deletedAt = new Date().toISOString();
  await writeFile(path.join(dest, "meta.json"), JSON.stringify(meta, null, 2));
  if (meta.source?.type === "voicememo") await setVmIgnored(meta.source.id, true);
}

async function listTrash() {
  const out: (Meta & { size: number })[] = [];
  for (const id of await readdir(TRASH_DIR).catch(() => [] as string[])) {
    try {
      const meta: Meta = JSON.parse(await readFile(path.join(trashDir(id), "meta.json"), "utf8"));
      out.push({ ...meta, size: await dirSize(trashDir(id)) });
    } catch {}
  }
  return out.sort((a, b) => (b.deletedAt || "").localeCompare(a.deletedAt || ""));
}

async function restoreMeeting(id: string) {
  const src = trashDir(id);
  const meta: Meta = JSON.parse(await readFile(path.join(src, "meta.json"), "utf8"));
  if (existsSync(meetingDir(id))) throw new Error("已经有同名记录,无法恢复");
  await rename(src, meetingDir(id));
  delete meta.deletedAt;
  await writeMeta(meta);
  if (meta.source?.type === "voicememo") await setVmIgnored(meta.source.id, false);
  return meta;
}

async function purgeTrash(onlyExpired = true) {
  const cutoff = Date.now() - TRASH_DAYS * 86400_000;
  for (const m of await listTrash()) {
    if (!onlyExpired || (m.deletedAt && Date.parse(m.deletedAt) < cutoff)) await rm(trashDir(m.id), { recursive: true, force: true });
  }
}
purgeTrash().catch(() => {});
setInterval(() => purgeTrash().catch(() => {}), 6 * 3600_000);

// 只删原件:keep = "audio" 删视频留音频;"text" 删所有录音文件,只留文字
async function stripMedia(id: string, keep: "audio" | "text") {
  if (activeRec?.id === id) throw new Error("正在录制");
  if (jobs.some((j) => j.meetingId === id && (j.state === "running" || j.state === "queued") && j.kind === "transcribe")) throw new Error("正在转写,等转写完再删");
  const meta = await readMeta(id);
  const dir = meetingDir(id);
  if (keep === "audio") {
    if (!meta.hasVideo || !meta.audioFile) throw new Error("这条没有视频");
    const src = path.join(dir, meta.audioFile);
    const out = meta.audioFile === "audio.m4a" ? "audio-only.m4a" : "audio.m4a";
    try {
      await run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-vn", "-c:a", "copy", path.join(dir, out)]);
    } catch {
      await run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-vn", "-c:a", "aac", "-b:a", "128k", path.join(dir, out)]);
    }
    await rm(src, { force: true });
    meta.audioFile = out;
    meta.hasVideo = false;
  } else {
    const files = [meta.audioFile, meta.tracks?.mic, meta.tracks?.system].filter(Boolean) as string[];
    for (const f of files) await rm(path.join(dir, f), { force: true });
    meta.audioFile = "";
    meta.hasVideo = false;
    meta.mediaRemoved = true;
  }
  await writeMeta(meta);
  return meta;
}

async function listMeetings() {
  await mkdir(MEETINGS_DIR, { recursive: true });
  const ids = await readdir(MEETINGS_DIR);
  const metas: Meta[] = [];
  for (const id of ids) {
    try { metas.push(await readMeta(id)); } catch {}
  }
  return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function idFromDate(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const base = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  let id = base;
  for (let i = 2; existsSync(path.join(MEETINGS_DIR, id)); i++) id = `${base}-${i}`;
  return id;
}


// ---------- 子进程 ----------
async function run(cmd: string[], opts: { env?: Record<string, string | undefined>; stdin?: string } = {}) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: opts.stdin != null ? new TextEncoder().encode(opts.stdin) : undefined, env: opts.env as any });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (code !== 0) throw new Error(`${path.basename(cmd[0])} 失败(exit ${code}): ${(err || out).slice(-800)}`);
  return out;
}

async function probeDuration(file: string): Promise<number> {
  try {
    const out = await run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    return Math.round(parseFloat(out.trim()) || 0);
  } catch {
    return 0;
  }
}

// 浏览器能直接播放的格式;其他格式(aiff / wma / amr / mkv …)导入时转成 m4a / mp4
const PLAYABLE = new Set(["mp3", "m4a", "mp4", "m4v", "mov", "wav", "webm", "ogg", "oga", "opus", "flac", "aac"]);

async function hasVideoStream(file: string) {
  try {
    const out = await run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries", "stream=codec_type,disposition=attached_pic", "-of", "csv=p=0", file]);
    // 封面图(attached_pic=1)不算画面
    return out.split("\n").some((l) => l.startsWith("video") && !l.endsWith(",1"));
  } catch {
    return false;
  }
}

// 返回整理后的文件名和是否有画面
async function normalizeMedia(dir: string, file: string): Promise<{ file: string; hasVideo: boolean }> {
  const src = path.join(dir, file);
  const ext = path.extname(file).slice(1).toLowerCase();
  const video = await hasVideoStream(src);
  if (PLAYABLE.has(ext)) return { file, hasVideo: video };
  if (video) {
    try {
      await run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", path.join(dir, "media.mp4")]);
      await rm(src, { force: true });
      return { file: "media.mp4", hasVideo: true };
    } catch {
      await rm(path.join(dir, "media.mp4"), { force: true }); // 画面编码 mp4 装不下,只留声音
    }
  }
  const out = file === "audio.m4a" ? "audio-conv.m4a" : "audio.m4a";
  await run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-vn", "-c:a", "aac", "-b:a", "128k", path.join(dir, out)]);
  await rm(src, { force: true });
  return { file: out, hasVideo: false };
}

function fmtTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ---------- 专有名词词库 ----------
// glossary.json: [{ term: "TSP", aliases: ["PSP", "踢艾斯批"] }]
type GlossaryEntry = { term: string; aliases: string[] };
const GLOSSARY_PATH = path.join(ROOT, "glossary.json");

async function loadGlossary(): Promise<GlossaryEntry[]> {
  try {
    const data = JSON.parse(await readFile(GLOSSARY_PATH, "utf8"));
    return Array.isArray(data) ? data.filter((g) => g && typeof g.term === "string" && g.term.trim()) : [];
  } catch {
    return [];
  }
}

async function saveGlossary(list: unknown) {
  const clean: GlossaryEntry[] = (Array.isArray(list) ? list : [])
    .map((g: any) => ({
      term: String(g?.term || "").trim(),
      aliases: (Array.isArray(g?.aliases) ? g.aliases : []).map((a: any) => String(a).trim()).filter(Boolean),
    }))
    .filter((g) => g.term);
  await writeFile(GLOSSARY_PATH, JSON.stringify(clean, null, 2));
  return clean;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function applyGlossary(text: string, glossary: GlossaryEntry[]) {
  for (const g of glossary) {
    for (const alias of g.aliases) {
      if (!alias || alias === g.term) continue;
      // 纯英文数字的错写按整词、不分大小写匹配,避免把单词中间的字母换掉
      const re = /^[\w\s.-]+$/.test(alias)
        ? new RegExp(`(?<![A-Za-z0-9])${escapeRe(alias)}(?![A-Za-z0-9])`, "gi")
        : new RegExp(escapeRe(alias), "g");
      text = text.replace(re, g.term);
    }
  }
  return text;
}

function glossaryNote(glossary: GlossaryEntry[]) {
  if (!glossary.length) return "";
  const items = glossary.map((g) => (g.aliases.length ? `${g.term}(可能被误识别为:${g.aliases.join("、")})` : g.term));
  return `专有名词表(转写中发音相近的错词请按此纠正):${items.join(";")}`;
}

// ---------- 说话人改名 ----------
// 把逐字稿里「我:」「嘉宾:」换成真实名字;名字同时加进词库,方便识别和纠错
async function renameSpeakers(meta: Meta, names: { mic?: unknown; system?: unknown }) {
  const clean = (v: unknown) => String(v ?? "").replace(/[:\n\[\]]/g, "").trim().slice(0, 40);
  const next = { mic: clean(names.mic), system: clean(names.system) };
  const map = new Map<string, string>();
  for (const key of ["mic", "system"] as TrackKey[]) {
    const from = speakerLabel(meta, key), to = next[key] || SPEAKER[key];
    if (from !== to) map.set(from, to);
  }
  meta.speakerNames = { ...(next.mic ? { mic: next.mic } : {}), ...(next.system ? { system: next.system } : {}) };
  if (!Object.keys(meta.speakerNames).length) meta.speakerNames = undefined;

  if (map.size) {
    const dir = meetingDir(meta.id);
    // 一次替换,两个名字互换也不会串
    const re = new RegExp(`^(\\[\\d+:\\d{2}\\] )(${[...map.keys()].map(escapeRe).join("|")}):`, "gm");
    const txt = await readTextIfExists(path.join(dir, "transcript.txt"));
    if (txt) await writeFile(path.join(dir, "transcript.txt"), txt.replace(re, (_, ts, who) => `${ts}${map.get(who)}:`));
    const jsonPath = path.join(dir, "transcript.json");
    if (existsSync(jsonPath)) {
      try {
        const data = JSON.parse(await readFile(jsonPath, "utf8"));
        for (const seg of data.segments || []) if (map.has(seg.speaker)) seg.speaker = map.get(seg.speaker);
        await writeFile(jsonPath, JSON.stringify(data, null, 2));
      } catch {}
    }
  }

  const people = [next.mic, ...next.system.split(/[、,，]/)].map((n) => n.trim()).filter((n) => n.length >= 2);
  if (people.length) {
    const glossary = await loadGlossary();
    const missing = people.filter((n) => !glossary.some((g) => g.term === n));
    if (missing.length) await saveGlossary([...glossary, ...missing.map((term) => ({ term, aliases: [] }))]);
  }
}

// ---------- 字幕(SRT) ----------
// 以 transcript.txt 为准(可能手动改过);精确时间优先用 transcript.json。
// 识别出来的一段常常十几秒,按标点切成一行不超过 20 个字的短句,时间按字数分配。
function srtTime(sec: number) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

function splitSubtitle(text: string, max = 20): string[] {
  const parts = text.split(/(?<=[,!?;\s，。！？；：、])/).filter((t) => t.trim());
  const out: string[] = [];
  let cur = "";
  for (const part of parts) {
    if ((cur + part).length <= max) { cur += part; continue; }
    if (cur) out.push(cur);
    cur = part;
    while (cur.length > max) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur) out.push(cur);
  // 行尾的逗号句号字幕里不需要;中间的空格(中英文之间)保留
  return out.map((l) => l.trim().replace(/[,;:，。；：、]+$/, ""));
}

async function buildSrt(meta: Meta, withSpeaker: boolean) {
  const dir = meetingDir(meta.id);
  const lines = (await readTextIfExists(path.join(dir, "transcript.txt"))).split("\n")
    .map((l) => /^\[(\d+):(\d{2})\]\s*(.*)$/.exec(l)).filter(Boolean) as RegExpExecArray[];
  if (!lines.length) throw new Error("还没有带时间戳的逐字稿,先转写");
  let precise: Segment[] = [];
  try { precise = JSON.parse(await readFile(path.join(dir, "transcript.json"), "utf8")).segments || []; } catch {}
  const usePrecise = precise.length === lines.length && precise.every((s, i) => Math.floor(s.start) === Number(lines[i][1]) * 60 + Number(lines[i][2]));

  const cues: { start: number; end: number; text: string }[] = [];
  lines.forEach((m, i) => {
    let body = m[3];
    let who = "";
    const sp = /^([^:：\s]{1,20})[:：](.*)$/.exec(body);
    if (sp && (meta.tracks?.mic || meta.tracks?.system)) { who = sp[1]; body = sp[2]; }
    const start = usePrecise ? precise[i].start : Number(m[1]) * 60 + Number(m[2]);
    const nextStart = i + 1 < lines.length ? (usePrecise ? precise[i + 1].start : Number(lines[i + 1][1]) * 60 + Number(lines[i + 1][2])) : start + 30;
    // 这句大概要说多久:中文约 4 字/秒,不超过下一句开始
    const spoken = Math.max(1.5, body.length / 4);
    const end = Math.min(usePrecise && precise[i].end > start ? precise[i].end : start + spoken, Math.max(nextStart, start + 0.5));
    const pieces = splitSubtitle(body);
    const total = pieces.reduce((n, p) => n + p.length, 0) || 1;
    let t = start;
    pieces.forEach((p, k) => {
      const d = ((end - start) * p.length) / total;
      cues.push({ start: t, end: t + d, text: (withSpeaker && who && k === 0 ? `${who}：` : "") + p });
      t += d;
    });
  });
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n");
}

// ---------- 转写 ----------
type Segment = { start: number; end: number; text: string; speaker?: string; track?: "mic" | "system" };
const SPEAKER = { mic: "我", system: "嘉宾" } as const;
type TrackKey = keyof typeof SPEAKER;
const speakerLabel = (meta: Meta, key: TrackKey) => meta.speakerNames?.[key]?.trim() || SPEAKER[key];

// 方案 A:macOS 自带语音识别(SpeechAnalyzer,macOS 26+),离线、免费
async function ensureTranscribeBin() {
  if (existsSync(TRANSCRIBE_BIN)) return;
  if (!existsSync(TRANSCRIBE_SRC)) throw new Error("找不到 native/transcribe.swift");
  console.log("首次使用,正在编译本地转写程序…");
  await mkdir(path.dirname(TRANSCRIBE_BIN), { recursive: true });
  await run(["swiftc", "-O", "-o", TRANSCRIBE_BIN, TRANSCRIBE_SRC]);
}

function toLocale(lang: string) {
  const l = (lang || "zh").trim();
  if (l.includes("-")) return l;
  return ({ zh: "zh-CN", en: "en-US", ja: "ja-JP", ko: "ko-KR", de: "de-DE", fr: "fr-FR", es: "es-ES" } as Record<string, string>)[l] || "zh-CN";
}

async function transcribeLocal(cfg: Config, dir: string, audioFile: string): Promise<{ text: string; segments: Segment[] }> {
  await ensureTranscribeBin();
  // 浏览器录的 webm/opus 系统播放器不认,统一转成 16k 单声道 wav
  // aresample async + first_pts=0:开头没声音的空白也补成静音,分轨之间时间戳才对得上
  const wav = path.join(dir, `${path.parse(audioFile).name}-16k.wav`);
  await run(["ffmpeg", "-y", "-loglevel", "error", "-i", path.join(dir, audioFile), "-vn", "-af", "aresample=async=1:first_pts=0", "-ac", "1", "-ar", "16000", wav]);
  try {
    // 词库里的专有名词提示给识别器
    const terms = (await loadGlossary()).map((g) => g.term);
    const termsFile = path.join(dir, ".terms.txt");
    if (terms.length) await writeFile(termsFile, terms.join("\n"));
    const out = await run([TRANSCRIBE_BIN, wav, toLocale(cfg.transcribeLanguage), ...(terms.length ? [termsFile] : [])])
      .finally(() => rm(termsFile, { force: true }));
    const segments: Segment[] = out
      .split("\n")
      .filter((l) => l.trim().startsWith("{"))
      .map((l) => JSON.parse(l))
      .map((s) => ({ start: Number(s.start || 0), end: Number(s.end || 0), text: String(s.text || "").trim() }))
      .filter((s) => s.text);
    return { text: segments.map((s) => s.text).join("\n"), segments };
  } finally {
    await rm(wav, { force: true });
  }
}

// 方案 B:OpenAI 兼容的 /audio/transcriptions 接口(Groq / OpenAI / 硅基流动 / 本地 whisper.cpp server)
async function prepareChunks(dir: string, audioFile: string): Promise<string[]> {
  const chunksDir = path.join(dir, "chunks");
  await rm(chunksDir, { recursive: true, force: true });
  await mkdir(chunksDir, { recursive: true });
  await run([
    "ffmpeg", "-y", "-loglevel", "error", "-i", path.join(dir, audioFile),
    "-vn", "-af", "aresample=async=1:first_pts=0", "-ac", "1", "-ar", "16000", "-b:a", "48k",
    "-f", "segment", "-segment_time", "600", "-reset_timestamps", "1",
    path.join(chunksDir, "part-%03d.mp3"),
  ]);
  const files = (await readdir(chunksDir)).filter((f) => f.endsWith(".mp3")).sort();
  return files.map((f) => path.join(chunksDir, f));
}

async function transcribeApiFile(cfg: Config, file: string, offsetSec: number): Promise<{ text: string; segments: Segment[] }> {
  const form = new FormData();
  form.append("file", new File([await Bun.file(file).arrayBuffer()], path.basename(file), { type: "audio/mpeg" }));
  form.append("model", cfg.transcribeModel);
  form.append("response_format", "verbose_json");
  if (cfg.transcribeLanguage) form.append("language", cfg.transcribeLanguage);

  const res = await fetch(`${cfg.transcribeBaseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: cfg.transcribeApiKey ? { Authorization: `Bearer ${cfg.transcribeApiKey}` } : {},
    body: form,
  });
  if (!res.ok) throw new Error(`转写接口 ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("json")) return { text: (await res.text()).trim(), segments: [] };
  const data: any = await res.json();
  const segments: Segment[] = Array.isArray(data.segments)
    ? data.segments.map((s: any) => ({ start: offsetSec + Number(s.start || 0), end: offsetSec + Number(s.end || 0), text: String(s.text || "").trim() }))
    : [];
  return { text: String(data.text || "").trim(), segments };
}

async function transcribeApi(cfg: Config, dir: string, audioFile: string) {
  if (!cfg.transcribeApiKey && !/localhost|127\.0\.0\.1/.test(cfg.transcribeBaseUrl)) throw new Error("没有配置转写 API Key");
  try {
    const chunks = await prepareChunks(dir, audioFile);
    const segments: Segment[] = [];
    const texts: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const r = await transcribeApiFile(cfg, chunks[i], i * 600);
      texts.push(r.text);
      segments.push(...r.segments);
    }
    return { text: texts.join("\n"), segments };
  } finally {
    await rm(path.join(dir, "chunks"), { recursive: true, force: true });
  }
}

// 没戴耳机时,扬声器里嘉宾的声音会被麦克风再录一遍。
// 「我」的一句话如果和同一时间「嘉宾」的话几乎一样,就当回声删掉。
function bigrams(t: string) {
  const c = t.replace(/[\s\p{P}]/gu, "").toLowerCase();
  const set = new Set<string>();
  for (let i = 0; i < c.length - 1; i++) set.add(c.slice(i, i + 2));
  return set;
}
// 「我」这句话里有多大比例的内容,在同一时间段的「嘉宾」里也出现了
function coveredBy(mine: string, guest: string) {
  const A = bigrams(mine), B = bigrams(guest);
  if (!A.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / A.size;
}
function dropEcho(segments: Segment[]) {
  const guest = segments.filter((s) => s.track === "system");
  if (!guest.length) return;
  for (let i = segments.length - 1; i >= 0; i--) {
    const me = segments[i];
    if (me.track !== "mic") continue;
    const end = Math.max(me.end, me.start);
    const near = guest.filter((g) => g.start <= end + 3 && Math.max(g.end, g.start) >= me.start - 3).map((g) => g.text).join("");
    // 自己说的话混着回声时覆盖率低,会保留
    if (near && coveredBy(me.text, near) >= 0.7) segments.splice(i, 1);
  }
}

async function transcribeMeeting(id: string) {
  const cfg = await loadConfig();
  const dir = meetingDir(id);
  const meta = await readMeta(id);
  meta.status = "transcribing";
  meta.error = undefined;
  await writeMeta(meta);
  const transcribeFile = (file: string) =>
    cfg.transcribeProvider === "api" ? transcribeApi(cfg, dir, file) : transcribeLocal(cfg, dir, file);
  try {
    let r: { text: string; segments: Segment[] };
    const tracks = meta.mediaRemoved ? [] : (Object.entries(meta.tracks || {}).filter(([, f]) => f) as [TrackKey, string][]);
    if (tracks.length) {
      // 分轨录制:每条音轨单独转写,按时间合并,标上说话人
      const segments: Segment[] = [];
      for (const [key, file] of tracks) {
        const t = await transcribeFile(file);
        const segs = t.segments.length ? t.segments : t.text ? [{ start: 0, end: 0, text: t.text }] : [];
        segments.push(...segs.map((s) => ({ ...s, speaker: speakerLabel(meta, key), track: key })));
      }
      segments.sort((a, b) => a.start - b.start);
      dropEcho(segments);
      r = { text: segments.map((s) => `${s.speaker}:${s.text}`).join("\n"), segments };
    } else {
      if (!meta.audioFile) throw new Error(meta.mediaRemoved ? "录音文件已经删除,不能重新转写" : "这条记录没有声音(仅录屏模式),无法转写");
      r = await transcribeFile(meta.audioFile);
    }
    // 词库纠错:把常见错写替换成正确写法
    const glossary = await loadGlossary();
    r.segments = r.segments.map((seg) => ({ ...seg, text: applyGlossary(seg.text, glossary) }));
    r.text = applyGlossary(r.text, glossary);
    const timed = r.segments.length
      ? r.segments.map((s) => `[${fmtTime(s.start)}] ${s.speaker ? s.speaker + ":" : ""}${s.text}`).join("\n")
      : r.text;
    await writeFile(path.join(dir, "transcript.txt"), timed);
    await writeFile(path.join(dir, "transcript.json"), JSON.stringify(r, null, 2));
    meta.status = "transcribed";
    meta.transcribeModel = cfg.transcribeProvider === "api" ? cfg.transcribeModel : "macOS 本地识别";
    await writeMeta(meta);
  } catch (e: any) {
    meta.status = "error";
    meta.error = String(e?.message || e);
    await writeMeta(meta);
    throw e;
  }
}

// ---------- 纪要 ----------
// 方案 A:本机的 Claude Code 命令行(用你登录的 Claude 账号,不需要 API Key)
function findClaudeCli(configured: string): string | null {
  if (configured && existsSync(configured)) return configured;
  const fromPath = Bun.which("claude");
  if (fromPath) return fromPath;
  const home = os.homedir();
  const candidates = [
    path.join(home, ".local", "bin", "claude"),
    path.join(home, ".claude", "local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

function cliEnv() {
  // 去掉"正在 Claude Code 里"的标记,否则嵌套启动会被拒绝
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

async function claudeCliStatus(cfg: Config): Promise<{ found: string | null; loggedIn: boolean; message: string; cmd?: string }> {
  const bin = findClaudeCli(cfg.claudeCliPath);
  if (!bin) return { found: null, loggedIn: false, message: "没找到 claude 命令。请先安装 Claude Code,或在设置里填写路径。" };
  try {
    // 未登录时 exit code 是 1,但 stdout 里仍有 JSON,所以不走 run()
    const p = Bun.spawn([bin, "auth", "status", "--json"], { stdout: "pipe", stderr: "pipe", env: cliEnv() as any });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    if (!out.trim()) throw new Error(err.slice(-300) || "没有输出");
    let ok = false;
    try { ok = JSON.parse(out).loggedIn === true; } catch { ok = /logged in/i.test(out) && !/not logged in/i.test(out); }
    const cmd = bin === Bun.which("claude") ? "claude" : `"${bin}"`;
    return { found: bin, loggedIn: ok, message: ok ? "已登录" : `未登录。请打开「终端」运行一次:${cmd} auth login`, cmd };
  } catch (e: any) {
    return { found: bin, loggedIn: false, message: `无法检测登录状态:${String(e?.message || e).slice(0, 200)}` };
  }
}

async function summarizeWithCli(cfg: Config, system: string, prompt: string, onDelta: (t: string) => void): Promise<string> {
  const bin = findClaudeCli(cfg.claudeCliPath);
  if (!bin) throw new Error("没找到 claude 命令,请在设置里填写路径或切换到 API 模式");
  const p = Bun.spawn(
    [
      // 不能用 --bare:它只认 ANTHROPIC_API_KEY,不读账号登录。
      // 改用下面几项隔离:只加载临时目录里的设置(=不跑你的 hooks / 插件)、不连 MCP、不加载技能、不给工具
      bin, "-p", "--setting-sources", "project", "--strict-mcp-config", "--disable-slash-commands",
      "--no-session-persistence", "--tools", "",
      "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--model", cfg.claudeCliModel || "opus",
      "--system-prompt", system,
    ],
    { stdin: new TextEncoder().encode(prompt), stdout: "pipe", stderr: "pipe", env: cliEnv() as any, cwd: os.tmpdir() },
  );
  let streamed = "";
  let finalText = "";
  let errorText = "";
  const reader = p.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === "stream_event") {
        const ev = msg.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          streamed += ev.delta.text;
          onDelta(ev.delta.text);
        }
      } else if (msg.type === "result") {
        if (msg.is_error) errorText = String(msg.result || msg.error || "claude 返回错误");
        else if (typeof msg.result === "string") finalText = msg.result;
      }
    }
  }
  const stderr = await new Response(p.stderr).text();
  const code = await p.exited;
  if (errorText) throw new Error(`Claude Code: ${errorText}`);
  if (code !== 0) throw new Error(`claude 退出码 ${code}: ${stderr.slice(-500)}`);
  return finalText || streamed;
}

// 方案 B:Anthropic API
async function summarizeWithApi(cfg: Config, system: string, prompt: string, onDelta: (t: string) => void): Promise<string> {
  if (!cfg.anthropicApiKey) throw new Error("没有配置 Anthropic API Key");
  const client = new Anthropic({
    apiKey: cfg.anthropicApiKey,
    ...(cfg.anthropicBaseUrl ? { baseURL: cfg.anthropicBaseUrl } : {}),
  });
  const msgStream = client.messages.stream({
    model: cfg.claudeModel,
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  let text = "";
  for await (const event of msgStream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      text += event.delta.text;
      onDelta(event.delta.text);
    }
  }
  const final = await msgStream.finalMessage();
  if (final.stop_reason === "refusal") throw new Error(`模型拒绝生成: ${final.stop_details?.explanation ?? "无说明"}`);
  if (final.stop_reason === "max_tokens") text += "\n\n> (内容过长被截断)";
  return text;
}

// 方案 C:OpenAI 兼容接口(MOI Genesis、DeepSeek、硅基流动等),走 /chat/completions 流式
async function summarizeWithOpenAI(cfg: Config, system: string, prompt: string, onDelta: (t: string) => void): Promise<string> {
  if (!cfg.openaiApiKey) throw new Error("没有配置 OpenAI 兼容接口的 API Key");
  const base = (cfg.openaiBaseUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("没有配置 OpenAI 兼容接口的 Base URL");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.openaiApiKey}` },
    body: JSON.stringify({
      model: cfg.openaiModel,
      stream: true,
      max_tokens: 16000,
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    }),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    let msg = body.slice(0, 300);
    try { msg = JSON.parse(body)?.error?.message || msg; } catch {}
    throw new Error(`接口 ${res.status}: ${msg}`);
  }
  let text = "";
  let finish = "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let msg: any;
      try { msg = JSON.parse(data); } catch { continue; }
      const choice = msg.choices?.[0];
      const delta = choice?.delta?.content;
      if (typeof delta === "string" && delta) { text += delta; onDelta(delta); }
      if (choice?.finish_reason) finish = choice.finish_reason;
    }
  }
  if (!text) throw new Error("接口没有返回内容");
  if (finish === "length") text += "\n\n> (内容过长被截断)";
  return text;
}

// 统一入口:按设置选调用方式。fast = 小任务(起标题)尽量用便宜模型
function summarize(cfg: Config, system: string, prompt: string, onDelta: (t: string) => void, fast = false): Promise<string> {
  if (cfg.summaryProvider === "api") return summarizeWithApi(cfg, system, prompt, onDelta);
  if (cfg.summaryProvider === "openai") return summarizeWithOpenAI(cfg, system, prompt, onDelta);
  return summarizeWithCli(fast ? { ...cfg, claudeCliModel: "haiku" } : cfg, system, prompt, onDelta);
}

function summaryModelLabel(cfg: Config): string {
  if (cfg.summaryProvider === "api") return cfg.claudeModel;
  if (cfg.summaryProvider === "openai") return `${cfg.openaiModel} (${cfg.openaiBaseUrl.replace(/^https?:\/\//, "").split("/")[0]})`;
  return `Claude Code (${cfg.claudeCliModel})`;
}

// ---------- 模板 ----------
const TEMPLATES_PATH = path.join(ROOT, "templates.json");

async function defaultTemplates(): Promise<Template[]> {
  // 老版本在设置里改过纪要模板的,沿用到「会议纪要」模板
  const cfg = await loadConfig();
  return DEFAULT_TEMPLATES.map((t) =>
    t.id === "minutes" && cfg.summaryPrompt !== DEFAULT_SUMMARY_PROMPT ? { ...t, prompt: cfg.summaryPrompt } : { ...t },
  );
}

async function loadTemplates(): Promise<Template[]> {
  try {
    const list = JSON.parse(await readFile(TEMPLATES_PATH, "utf8"));
    if (Array.isArray(list) && list.length) return list;
  } catch {}
  return defaultTemplates();
}

async function saveTemplates(list: unknown) {
  const seen = new Set<string>();
  const clean: Template[] = (Array.isArray(list) ? list : [])
    .map((t: any) => ({
      id: String(t?.id || "").trim(),
      name: String(t?.name || "").trim(),
      format: t?.format === "mindmap" ? ("mindmap" as const) : ("markdown" as const),
      prompt: String(t?.prompt || "").trim(),
      defaultOn: !!t?.defaultOn,
    }))
    .filter((t) => /^[\w-]+$/.test(t.id) && t.name && t.prompt && !seen.has(t.id) && seen.add(t.id));
  if (!clean.length) throw new Error("至少保留一个模板");
  await writeFile(TEMPLATES_PATH, JSON.stringify(clean, null, 2));
  return clean;
}

// 每个模板的结果存成 results/<模板id>.md;老版本的 summary.md 当作「会议纪要」
function resultPath(dir: string, templateId: string) {
  if (!/^[\w-]+$/.test(templateId)) throw new Error("非法模板 id");
  return path.join(dir, "results", `${templateId}.md`);
}

async function readResults(dir: string) {
  const results: Record<string, string> = {};
  const rdir = path.join(dir, "results");
  if (existsSync(rdir)) {
    for (const f of await readdir(rdir)) if (f.endsWith(".md")) results[f.slice(0, -3)] = await readFile(path.join(rdir, f), "utf8");
  }
  if (!results.minutes && existsSync(path.join(dir, "summary.md"))) results.minutes = await readFile(path.join(dir, "summary.md"), "utf8");
  return results;
}

function buildPrompt(meta: Meta, transcript: string, glossary: GlossaryEntry[]) {
  const notes: string[] = [];
  if (meta.tracks?.mic || meta.tracks?.system) {
    const me = speakerLabel(meta, "mic"), guest = speakerLabel(meta, "system");
    notes.push(`说话人:「${me}」${me !== "我" ? "(模板里说的「我」)" : ""}是主讲人本人(麦克风),「${guest}」${guest !== "嘉宾" ? "(模板里说的「嘉宾」)" : ""}是线上会议里其他人的声音${guest.includes("、") ? ",这几位嘉宾的声音在同一条音轨里,转写分不出具体是谁,请根据上下文判断" : ""}。`);
  }
  if (meta.markers?.length) notes.push(`主讲人录制时手动打点的重要时刻:${meta.markers.map(fmtTime).join("、")}。这些时间点附近的内容请重点处理,不要遗漏。`);
  const g = glossaryNote(glossary);
  if (g) notes.push(g);
  return `会议标题:${meta.title}\n时长:${fmtTime(meta.durationSec)}\n${notes.join("\n")}\n\n<transcript>\n${transcript}\n</transcript>`;
}

// 按模板依次调用 Claude。网页的流式分析和后台队列都走这里
type AnalysisEvent =
  | { type: "start"; templateId: string; name: string }
  | { type: "delta"; templateId: string; text: string }
  | { type: "done"; templateId: string; text: string }
  | { type: "error"; templateId: string; message: string };

async function runAnalysis(id: string, templateIds: string[], onEvent: (e: AnalysisEvent) => void = () => {}) {
  const cfg = await loadConfig();
  const dir = meetingDir(id);
  const meta = await readMeta(id);
  try {
    const transcript = await readTextIfExists(path.join(dir, "transcript.txt"));
    if (!transcript.trim()) throw new Error("还没有转写文本,请先转写");
    const all = await loadTemplates();
    const chosen = templateIds.map((tid) => all.find((t) => t.id === tid)).filter(Boolean) as Template[];
    if (!chosen.length) throw new Error("请至少勾选一个模板");

    meta.status = "summarizing";
    meta.error = undefined;
    await writeMeta(meta);
    await mkdir(path.join(dir, "results"), { recursive: true });
    const prompt = buildPrompt(meta, transcript, await loadGlossary());

    const failed: string[] = [];
    for (const t of chosen) {
      onEvent({ type: "start", templateId: t.id, name: t.name });
      try {
        const system = `${t.prompt}\n\n${COMMON_RULES}`;
        const onDelta = (text: string) => onEvent({ type: "delta", templateId: t.id, text });
        let text = await summarize(cfg, system, prompt, onDelta);
        if (t.format === "mindmap") text = text.replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/m, "$1").trim();
        await writeFile(resultPath(dir, t.id), text);
        onEvent({ type: "done", templateId: t.id, text });
      } catch (e: any) {
        const msg = e instanceof Anthropic.APIError ? `Claude API ${e.status}: ${e.message}` : String(e?.message || e);
        failed.push(`${t.name}:${msg}`);
        onEvent({ type: "error", templateId: t.id, message: msg });
      }
    }

    meta.status = failed.length === chosen.length ? "error" : "done";
    meta.error = failed.length ? failed.join("\n") : undefined;
    meta.claudeModel = summaryModelLabel(cfg);
    await writeMeta(meta);
    return { failed };
  } catch (e: any) {
    meta.status = "error";
    meta.error = String(e?.message || e);
    await writeMeta(meta).catch(() => {});
    throw e;
  }
}

// 网页点「分析所选」:SSE 流式返回
function analyzeMeeting(id: string, templateIds: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        const { failed } = await runAnalysis(id, templateIds, ({ type, ...data }) => send(type, data));
        send("finish", { failed });
      } catch (e: any) {
        send("error", { message: String(e?.message || e) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}

// ---------- 自动起标题 ----------
const GENERIC_NAME = /^(新录音|新建录音|录音|语音|recording|new recording|audio|video|voice|record|untitled|未命名|屏幕录制|screen ?recording|录屏|会议录制|zoom|meeting|img|vid|mvi|dji|pxl|dsc|gopr|mov|rec)[\s_\-\d.:()()年月日时分秒]*$|^[\s_\-\d.:]+$/i;
const isPlaceholderTitle = (m: Meta) => !!m.titleAuto || /^会议 \d{8}-\d{6}(-\d+)?$/.test(m.title);

// force = 用户在详情页点「起标题」
async function autoTitle(id: string, force = false) {
  const cfg = await loadConfig();
  const meta = await readMeta(id);
  if (!force && (cfg.autoTitle !== "1" || !isPlaceholderTitle(meta))) return;
  const transcript = (await readTextIfExists(path.join(meetingDir(id), "transcript.txt"))).trim();
  if (transcript.length < 30) { if (force) throw new Error("逐字稿内容太少,起不出标题"); return; } // 内容太少起不出像样的标题
  const system = "根据会议逐字稿起一个中文标题:8 到 16 个字,说清楚聊的主题,不要书名号、引号、日期和「会议」「分享」这类泛词。只输出标题本身。";
  const prompt = `${glossaryNote(await loadGlossary())}\n\n<transcript>\n${transcript.slice(0, 8000)}\n</transcript>`;
  // 起标题用小模型,快、省额度
  const raw = await summarize(cfg, system, prompt, () => {}, true);
  const title = raw.split("\n").map((l) => l.trim()).find(Boolean)?.replace(/^[#*"'「『《\s]+|[」』》"'*。.\s]+$/g, "").slice(0, 30);
  if (!title) { if (force) throw new Error("没有得到标题"); return; }
  const latest = await readMeta(id); // 期间用户可能自己改过
  if (!force && !isPlaceholderTitle(latest)) return;
  latest.title = title;
  latest.titleAuto = undefined;
  await writeMeta(latest);
  console.log(`自动起标题:${id} → ${title}`);
  return title;
}

// ---------- 后台任务队列 ----------
// 转写和分析一个一个来,避免本机识别和 Claude 同时抢资源;录制、导入、批量分析都往这里排
type Job = {
  id: string;
  meetingId: string;
  kind: "transcribe" | "analyze";
  templateIds?: string[];
  state: "queued" | "running" | "done" | "error";
  error?: string;
  addedAt: number;
  finishedAt?: number;
};
const jobs: Job[] = [];
let queueRunning = false;

function enqueue(meetingId: string, kind: Job["kind"], templateIds?: string[]) {
  // 同一条记录同一种任务已经在排队,就不重复加
  const dup = jobs.find((j) => j.meetingId === meetingId && j.kind === kind && j.state === "queued");
  if (dup) { if (templateIds) dup.templateIds = templateIds; return dup; }
  const job: Job = { id: crypto.randomUUID().slice(0, 8), meetingId, kind, templateIds, state: "queued", addedAt: Date.now() };
  jobs.push(job);
  runQueue();
  return job;
}

async function defaultTemplateIds() {
  return (await loadTemplates()).filter((t) => t.defaultOn).map((t) => t.id);
}

async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    let job: Job | undefined;
    while ((job = jobs.find((j) => j.state === "queued"))) {
      job.state = "running";
      try {
        if (!existsSync(meetingDir(job.meetingId))) throw new Error("记录已删除");
        if (job.kind === "transcribe") {
          await transcribeMeeting(job.meetingId);
          await autoTitle(job.meetingId).catch((e) => console.error("自动起标题失败:", e?.message || e));
          const cfg = await loadConfig();
          if (cfg.autoExtractActions === "1") {
            await extractActions(job.meetingId).catch((e) => console.error("自动提取行动项失败:", e?.message || e));
            await reviewActions(job.meetingId).catch((e) => console.error("旧任务对照失败:", e?.message || e));
          }
          if (cfg.autoAnalyze === "1") {
            const ids = await defaultTemplateIds();
            if (ids.length) enqueue(job.meetingId, "analyze", ids);
          }
        } else {
          const { failed } = await runAnalysis(job.meetingId, job.templateIds?.length ? job.templateIds : await defaultTemplateIds());
          if (failed.length) throw new Error(failed.join("\n"));
        }
        job.state = "done";
      } catch (e: any) {
        job.state = "error";
        job.error = String(e?.message || e);
        console.error(`任务失败 ${job.kind} ${job.meetingId}:`, job.error);
      }
      job.finishedAt = Date.now();
    }
  } finally {
    queueRunning = false;
  }
  // 完成超过 10 分钟的任务从列表里清掉
  const cutoff = Date.now() - 10 * 60_000;
  for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].finishedAt && jobs[i].finishedAt! < cutoff) jobs.splice(i, 1);
}

// ---------- 语音备忘录 ----------
// 「语音备忘录」App 的录音在这个文件夹,标题、时间、时长在 CloudRecordings.db 里。
// 只读:数据库复制一份再查,录音文件复制进 meetings/,原文件一律不动。
const VM_DIR = path.join(os.homedir(), "Library", "Group Containers", "group.com.apple.VoiceMemos.shared", "Recordings");
const CORE_DATA_EPOCH = 978307200; // 2001-01-01,Core Data 的时间起点

type VoiceMemo = {
  uid: string;
  title: string;
  date: string;
  durationSec: number;
  folder?: string;
  file: string;
  available: boolean; // false = 只在 iCloud 上,还没下载到这台 Mac
  importedAs?: string;
  deleted?: boolean; // 导入过、后来在这边删掉了
  customTitle?: boolean; // 在语音备忘录里手动改过名字
};

function vmAccessError(e: any) {
  if (e?.code === "EPERM" || e?.code === "EACCES") {
    return new Error("没有权限读取语音备忘录。请在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」里打开「会议录音纪要」(列表里没有就点 + 号,到「个人 → 应用程序」里选它),然后在菜单栏图标里退出、重新打开一次 App。");
  }
  return e;
}

async function listVoiceMemos(): Promise<VoiceMemo[]> {
  if (!existsSync(VM_DIR)) throw new Error("没有找到语音备忘录的录音。请先在 Mac 上打开一次「语音备忘录」App;想同步 iPhone 的录音,要在两边都打开 iCloud 里的「语音备忘录」。");
  const imported = new Map<string, string>();
  for (const m of await listMeetings()) if (m.source?.type === "voicememo") imported.set(m.source.id, m.id);
  const ignored = new Set(await loadVmIgnore());

  const tmp = path.join(os.tmpdir(), "meeting-recorder-vm");
  await mkdir(tmp, { recursive: true });
  let rows: any[] = [];
  try {
    for (const f of ["CloudRecordings.db", "CloudRecordings.db-wal", "CloudRecordings.db-shm"]) {
      const src = path.join(VM_DIR, f);
      await rm(path.join(tmp, f), { force: true });
      if (existsSync(src)) await cp(src, path.join(tmp, f));
    }
    const db = new Database(path.join(tmp, "CloudRecordings.db"));
    try {
      rows = db.query(`
        SELECT r.ZUNIQUEID AS uid, r.ZPATH AS file, r.ZCUSTOMLABEL AS label, r.ZENCRYPTEDTITLE AS title,
               r.ZDURATION AS duration, r.ZDATE AS date, f.ZENCRYPTEDNAME AS folder
        FROM ZCLOUDRECORDING r LEFT JOIN ZFOLDER f ON f.Z_PK = r.ZFOLDER
        WHERE r.ZEVICTIONDATE IS NULL AND r.ZPATH IS NOT NULL
        ORDER BY r.ZDATE DESC`).all();
    } finally {
      db.close();
    }
  } catch (e: any) {
    if (e?.code === "EPERM" || e?.code === "EACCES") throw vmAccessError(e);
    // 数据库结构变了(系统升级)就退回到直接列文件
    console.error("读取语音备忘录数据库失败,改为直接列文件:", e?.message || e);
    rows = [];
    for (const f of (await readdir(VM_DIR)).filter((f) => /\.(m4a|qta)$/i.test(f))) {
      const st = await stat(path.join(VM_DIR, f));
      rows.push({ uid: f, file: f, title: f.replace(/\.[^.]+$/, ""), duration: 0, date: st.mtimeMs / 1000 - CORE_DATA_EPOCH });
    }
  }

  return rows.map((r) => {
    const date = new Date((Number(r.date) + CORE_DATA_EPOCH) * 1000);
    const file = path.isAbsolute(r.file) ? r.file : path.join(VM_DIR, r.file);
    return {
      uid: String(r.uid),
      title: String(r.label || r.title || `语音备忘录 ${date.toLocaleString("zh-CN")}`),
      customTitle: !!r.label,
      date: date.toISOString(),
      durationSec: Math.round(Number(r.duration) || 0),
      folder: r.folder || undefined,
      file,
      available: existsSync(file),
      importedAs: imported.get(String(r.uid)),
      deleted: !imported.has(String(r.uid)) && ignored.has(String(r.uid)),
    };
  });
}

async function importVoiceMemo(memo: VoiceMemo) {
  if (memo.importedAs) return readMeta(memo.importedAs);
  if (memo.deleted) await setVmIgnored(memo.uid, false); // 手动重新导入
  if (!memo.available) throw new Error(`「${memo.title}」还在 iCloud 上,先在「语音备忘录」里点开播放一下,等它下载到这台 Mac 再导入。`);
  const id = idFromDate(new Date(memo.date));
  const dir = meetingDir(id);
  await mkdir(dir, { recursive: true });
  const ext = (path.extname(memo.file).slice(1) || "m4a").toLowerCase();
  try {
    await cp(memo.file, path.join(dir, `audio.${ext}`));
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw vmAccessError(e);
  }
  const meta: Meta = {
    id,
    title: memo.title,
    titleAuto: !memo.customTitle || undefined,
    createdAt: memo.date,
    durationSec: memo.durationSec || (await probeDuration(path.join(dir, `audio.${ext}`))),
    audioFile: `audio.${ext}`,
    status: "recorded",
    source: { type: "voicememo", id: memo.uid },
  };
  await writeMeta(meta);
  await afterNewMedia(id);
  return meta;
}

// 自动导入:每分钟看一次有没有新的备忘录(文件夹没变化就不读数据库)
let vmLastSig = "";
let vmLastError = "";
async function pollVoiceMemos() {
  const cfg = await loadConfig();
  if (cfg.autoImportVoiceMemos !== "1" || !existsSync(VM_DIR)) return;
  try {
    const sig = (await Promise.all(["", "CloudRecordings.db-wal"].map(async (f) => {
      try { return (await stat(path.join(VM_DIR, f))).mtimeMs; } catch { return 0; }
    }))).join("|");
    if (sig === vmLastSig) return;
    const since = Number(cfg.voiceMemosSince) || Date.now();
    let pending = false;
    for (const m of await listVoiceMemos()) {
      if (m.importedAs || m.deleted || !m.available || new Date(m.date).getTime() < since) continue;
      // 刚同步下来、文件还在写入的,下一轮再导入
      if (Date.now() - (await stat(m.file)).mtimeMs < 30_000) { pending = true; continue; }
      const meta = await importVoiceMemo(m);
      console.log("已自动导入语音备忘录:", meta.title);
    }
    if (!pending) vmLastSig = sig;
    vmLastError = "";
  } catch (e: any) {
    vmLastError = String(e?.message || e);
  }
}
setInterval(() => pollVoiceMemos().catch(() => {}), 60_000);

// ---------- 全文搜索 ----------
// 个人用量下直接扫文件就够快,不用建索引
async function searchMeetings(q: string) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const match = (line: string) => { const l = line.toLowerCase(); return terms.every((t) => l.includes(t)); };
  const snippet = (line: string) => {
    const l = line.toLowerCase();
    const at = Math.max(0, l.indexOf(terms[0]));
    const from = Math.max(0, at - 40);
    return (from > 0 ? "…" : "") + line.slice(from, at + 80).trim() + (at + 80 < line.length ? "…" : "");
  };
  const templates = await loadTemplates();
  const out: any[] = [];
  for (const meta of await listMeetings()) {
    const dir = meetingDir(meta.id);
    const hits: { where: string; tab: string; text: string; t?: number }[] = [];
    if (match(meta.title)) hits.push({ where: "标题", tab: "", text: meta.title });
    for (const line of (await readTextIfExists(path.join(dir, "transcript.txt"))).split("\n")) {
      if (!match(line)) continue;
      const ts = /^\[(\d+):(\d{2})\]/.exec(line);
      hits.push({ where: "转写原文", tab: "transcript", text: snippet(line.replace(/^\[\d+:\d{2}\]\s*/, "")), t: ts ? Number(ts[1]) * 60 + Number(ts[2]) : undefined });
    }
    for (const [tid, text] of Object.entries(await readResults(dir))) {
      const name = templates.find((t) => t.id === tid)?.name || tid;
      for (const line of text.split("\n")) if (match(line)) hits.push({ where: name, tab: tid, text: snippet(line.replace(/^[#>*\-\s|]+/, "").replace(/\*\*/g, "")) });
    }
    if (hits.length) out.push({ id: meta.id, title: meta.title, createdAt: meta.createdAt, count: hits.length, hits: hits.slice(0, 6) });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 50);
}

// ---------- 问资料库(跨会议提问) ----------
// 逐字稿总量不大时全部交给 Claude;太多就先让它看目录挑出相关的几场,再读这几场的全文。
const ASK_ALL_LIMIT = 120_000; // 字
const ASK_PER_MEETING_LIMIT = 60_000;

const ASK_SYSTEM = core.ASK_SYSTEM;

// ---------- 行动项(会议变行动) ----------
// 每场会议一个 actions.json:AI 从逐字稿里提取「谁 / 做什么 / 什么时候」,先进「待确认」,人确认后才算正式任务。
// 提示词和纯逻辑在 shared/core.js,网页演示版也用同一份。
type ActionStatus = "pending" | "todo" | "doing" | "done" | "dropped";
type ActionItem = {
  id: string;
  text: string; // 做什么
  owner: string; // 谁,空 = 待定
  due: string | null; // YYYY-MM-DD,null = 待定
  dueText?: string; // 原话里的时间表述,如「下周三」「月底前」
  status: ActionStatus; // pending = AI 提取、还没确认
  source: { t: number; quote: string } | null; // 来源:逐字稿秒数 + 原话
  confidence?: number;
  note?: string;
  createdAt: string;
  updatedAt: string;
  doneAt?: string;
};

const { normalizeDue, parseTimestamp, extractJsonArray, newActionId, localDate, shiftDate } = core;

function actionsPath(id: string) { return path.join(meetingDir(id), "actions.json"); }

async function readActions(id: string): Promise<ActionItem[]> {
  try {
    const list = JSON.parse(await readFile(actionsPath(id), "utf8"));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

async function writeActions(id: string, list: ActionItem[]) {
  await writeFile(actionsPath(id), JSON.stringify(list, null, 2));
}

const patchAction = (a: ActionItem, body: any): ActionItem => core.patchAction(a, body, new Date().toISOString());

async function extractActions(id: string): Promise<{ added: number; items: ActionItem[] }> {
  const cfg = await loadConfig();
  const meta = await readMeta(id);
  const transcript = (await readTextIfExists(path.join(meetingDir(id), "transcript.txt"))).trim();
  if (transcript.length < 30) throw new Error("逐字稿内容太少,提不出行动项");
  const names = [cfg.myName, meta.speakerNames?.mic, meta.speakerNames?.system].filter(Boolean) as string[];
  const existing = await readActions(id);
  const known = existing.filter((a) => a.status !== "pending").map((a) => a.text);
  const prompt = core.buildExtractPrompt({ createdAt: meta.createdAt, names, glossary: glossaryNote(await loadGlossary()), transcript, known });
  const arr = extractJsonArray(await summarize(cfg, core.ACTIONS_SYSTEM, prompt, () => {}));
  const { fresh, items } = core.mergeExtracted(existing, arr, new Date().toISOString());
  await writeActions(id, items);
  console.log(`行动项提取:${id} 新增 ${fresh.length} 条(模型返回 ${arr.length} 条)`);
  return { added: fresh.length, items };
}

// 所有会议的行动项(全局看板用),附上会议标题
async function listAllActions() {
  const out: (ActionItem & { meetingId: string; meetingTitle: string; meetingAt: string })[] = [];
  for (const m of await listMeetings()) {
    for (const a of await readActions(m.id)) out.push({ ...a, meetingId: m.id, meetingTitle: m.title, meetingAt: m.createdAt });
  }
  return out;
}

// ---------- 会前汇报 ----------
// 开会前看一眼:上次会议定的事做完几件、谁逾期了。给网页卡片、菜单栏「要录吗」面板和复制到群里用。
async function briefing() {
  return core.briefingFrom(await listMeetings(), await listAllActions(), localDate());
}

// ---------- 旧任务完成识别 ----------
// 新会议转写完,把之前没完成的任务拿去和逐字稿对一遍:谁说「那个弄完了」,就标成完成候选,人确认后才改状态。
type Review = {
  actionId: string; meetingId: string; // 任务属于哪场会议
  text: string; owner: string;
  suggested: "done" | "doing" | "dropped";
  t: number | null; quote: string; confidence?: number;
  resolved?: "accepted" | "ignored";
  createdAt: string;
};
function reviewsPath(id: string) { return path.join(meetingDir(id), "reviews.json"); }
async function readReviews(id: string): Promise<Review[]> {
  try { const l = JSON.parse(await readFile(reviewsPath(id), "utf8")); return Array.isArray(l) ? l : []; } catch { return []; }
}
async function writeReviews(id: string, list: Review[]) { await writeFile(reviewsPath(id), JSON.stringify(list, null, 2)); }

async function reviewActions(id: string): Promise<{ added: number; reviews: Review[] }> {
  const cfg = await loadConfig();
  const transcript = (await readTextIfExists(path.join(meetingDir(id), "transcript.txt"))).trim();
  if (transcript.length < 30) throw new Error("逐字稿内容太少");
  const open = core.pickOpenForReview(await listAllActions(), id);
  if (!open.length) return { added: 0, reviews: await readReviews(id) };
  const prompt = core.buildReviewPrompt({ open, glossary: glossaryNote(await loadGlossary()), transcript });
  const arr = extractJsonArray(await summarize(cfg, core.REVIEW_SYSTEM, prompt, () => {}));
  const { fresh, reviews } = core.mergeReviews(await readReviews(id), arr, open, new Date().toISOString());
  await writeReviews(id, reviews);
  console.log(`旧任务对照:${id} 对照 ${open.length} 条,提到 ${fresh.length} 条`);
  return { added: fresh.length, reviews };
}

async function resolveReview(id: string, actionId: string, accept: boolean, newMeetingTitle: string) {
  const reviews = await readReviews(id);
  const r = reviews.find((x) => x.actionId === actionId);
  if (!r) throw new Error("没有这条候选");
  if (accept) {
    const list = await readActions(r.meetingId);
    const i = list.findIndex((a) => a.id === actionId);
    if (i >= 0) {
      list[i] = patchAction(list[i], { status: r.suggested, note: core.reviewNote(newMeetingTitle, r.quote) });
      await writeActions(r.meetingId, list);
    }
  }
  r.resolved = accept ? "accepted" : "ignored";
  await writeReviews(id, reviews);
  return reviews;
}

// ---------- 到期提醒 ----------
// 每天到点扫一遍所有未完成任务:逾期、今天到期、明天到期,合成一条 macOS 通知。
const REMIND_STATE_PATH = path.join(ROOT, "reminders.json");

async function dueDigest() {
  return core.dueDigestFrom(await listAllActions(), localDate());
}

async function notifyMac(title: string, message: string, subtitle = "") {
  if (process.platform !== "darwin") return false;
  const esc = (x: string) => x.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 200);
  const script = `display notification "${esc(message)}" with title "${esc(title)}"${subtitle ? ` subtitle "${esc(subtitle)}"` : ""} sound name "default"`;
  const p = Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) console.error("通知失败:", await new Response(p.stderr).text());
  return code === 0;
}

function digestMessage(d: Awaited<ReturnType<typeof dueDigest>>) {
  const line = (a: ActionItem) => `${a.owner || "待定"}:${a.text.slice(0, 18)}`;
  const parts: string[] = [];
  if (d.overdue.length) parts.push(`逾期 ${d.overdue.length}`);
  if (d.today.length) parts.push(`今天 ${d.today.length}`);
  if (d.tomorrow.length) parts.push(`明天 ${d.tomorrow.length}`);
  const top = [...d.overdue, ...d.today, ...d.tomorrow].slice(0, 3).map(line).join(";");
  return { subtitle: parts.join(" · "), message: top || "没有到期的任务" };
}

async function sendDueReminder(force = false) {
  const cfg = await loadConfig();
  const d = await dueDigest();
  const total = d.overdue.length + d.today.length + d.tomorrow.length;
  if (!force && !total) return { sent: false, ...d };
  const { subtitle, message } = digestMessage(d);
  const sent = await notifyMac("散会即开工 · 任务提醒", message, subtitle);
  if (sent) {
    const now = new Date().toISOString();
    for (const a of [...d.overdue, ...d.today, ...d.tomorrow]) {
      const list = await readActions(a.meetingId);
      const i = list.findIndex((x) => x.id === a.id);
      if (i >= 0) { (list[i] as any).lastRemindedAt = now; await writeActions(a.meetingId, list); }
    }
  }
  void cfg;
  return { sent, ...d };
}

async function reminderTick() {
  const cfg = await loadConfig();
  if (cfg.remindEnabled !== "1") return;
  const hour = Math.min(23, Math.max(0, Number(cfg.remindHour) || 9));
  if (new Date().getHours() < hour) return;
  let state: { lastDailyRun?: string } = {};
  try { state = JSON.parse(await readFile(REMIND_STATE_PATH, "utf8")); } catch {}
  const today = localDate();
  if (state.lastDailyRun === today) return;
  const r = await sendDueReminder();
  await writeFile(REMIND_STATE_PATH, JSON.stringify({ lastDailyRun: today, lastResult: { sent: r.sent, overdue: r.overdue.length, today: r.today.length, tomorrow: r.tomorrow.length } }));
  console.log(`任务提醒:${r.sent ? "已发送" : "没有到期任务"}(逾期 ${r.overdue.length} / 今天 ${r.today.length} / 明天 ${r.tomorrow.length})`);
}
setTimeout(() => reminderTick().catch((e) => console.error("任务提醒失败:", e?.message || e)), 20_000);
setInterval(() => reminderTick().catch((e) => console.error("任务提醒失败:", e?.message || e)), 10 * 60_000);

type AskTurn = { q: string; a: string };

async function askLibrary(question: string, history: AskTurn[], onEvent: (type: string, data: unknown) => void) {
  const cfg = await loadConfig();
  const call = (system: string, prompt: string, onDelta: (t: string) => void) => summarize(cfg, system, prompt, onDelta);

  const all: { ref: string; meta: Meta; transcript: string; brief: string }[] = [];
  for (const meta of await listMeetings()) {
    const dir = meetingDir(meta.id);
    const transcript = await readTextIfExists(path.join(dir, "transcript.txt"));
    if (!transcript.trim()) continue;
    const results = await readResults(dir);
    const brief = (results.abstract || results.minutes || results.tidy || transcript).slice(0, 600);
    all.push({ ref: "", meta, transcript, brief });
  }
  if (!all.length) throw new Error("资料库里还没有转写过的记录");
  // 按时间从旧到新编号,方便 Claude 理解先后
  all.sort((a, b) => a.meta.createdAt.localeCompare(b.meta.createdAt)).forEach((m, i) => (m.ref = `M${i + 1}`));
  const header = (m: (typeof all)[number]) => `${m.ref}「${m.meta.title}」${new Date(m.meta.createdAt).toLocaleDateString("zh-CN")} 时长 ${fmtTime(m.meta.durationSec)}`;
  const historyText = history.slice(-3).map((t) => `用户之前问:${t.q}\n你之前答:${t.a}`).join("\n\n");

  // 任务清单:所有会议的行动项,标上定下它的那场会议编号和时间戳,问「谁负责 / 做没做 / 哪次会定的」时直接可答
  const refById = new Map(all.map((m) => [m.meta.id, m.ref]));
  const tasks = core.formatTasksBlock(await listAllActions(), refById, localDate());
  const tasksBlock = tasks.block;

  let chosen = all;
  const total = all.reduce((n, m) => n + m.transcript.length, 0);
  if (total > ASK_ALL_LIMIT) {
    onEvent("stage", { text: `资料库共 ${all.length} 场,先挑出相关的会议…` });
    const catalog = all.map((m) => `${header(m)}\n${m.brief.replace(/\s+/g, " ")}`).join("\n\n");
    const pick = await call(
      "你帮用户从会议目录里挑出和问题相关的会议。只输出编号,用逗号分隔,最多 6 个,例如:M3,M7。一个都不相关就输出:无。目录后面可能附有任务清单,问题如果是关于某个任务的,把定下它的那场会议也挑上。",
      `${historyText ? historyText + "\n\n" : ""}问题:${question}\n\n会议目录:\n${catalog}${tasksBlock ? "\n\n" + tasksBlock : ""}`,
      () => {},
    );
    const refs = new Set(pick.match(/M\d+/g) || []);
    chosen = all.filter((m) => refs.has(m.ref));
    if (!chosen.length && !tasksBlock) {
      onEvent("sources", { sources: [] });
      const text = "资料库里没有找到和这个问题相关的会议。";
      onEvent("delta", { text });
      return text;
    }
  }

  // 任务清单里引用到的会议也要进出处列表,点 [[M2 13:05]] 才跳得过去
  const cited = new Set([...chosen.map((m) => m.ref), ...tasks.cited]);
  onEvent("sources", { sources: all.filter((m) => cited.has(m.ref)).map((m) => ({ ref: m.ref, id: m.meta.id, title: m.meta.title, createdAt: m.meta.createdAt })) });
  const docs = chosen.map((m) => {
    const t = m.transcript.length > ASK_PER_MEETING_LIMIT ? m.transcript.slice(0, ASK_PER_MEETING_LIMIT) + "\n(后面内容过长已省略)" : m.transcript;
    return `<meeting ref="${m.ref}">\n${header(m)}\n${t}\n</meeting>`;
  }).join("\n\n");
  const glossary = glossaryNote(await loadGlossary());
  const prompt = `${glossary ? glossary + "\n\n" : ""}${tasksBlock ? tasksBlock + "\n\n" : ""}${docs}\n\n${historyText ? historyText + "\n\n" : ""}现在的问题:${question}`;
  return call(ASK_SYSTEM, prompt, (t) => onEvent("delta", { text: t }));
}

// ---------- 备份 ----------
// 把 meetings/ 同步到备份文件夹(默认 iCloud 云盘)。增量:只复制新的和改过的文件。
// 彻底删除的记录(不在 meetings 也不在最近删除里)备份里也删掉,保持一致。
const ICLOUD_DIR = path.join(os.homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs");
const TEXT_EXT = new Set([".json", ".txt", ".md", ".srt"]);
const VIDEO_FILES = (m: Meta) => (m.hasVideo && m.audioFile ? [m.audioFile] : []);
let backupState: { running: boolean; lastAt?: string; lastError?: string; copied?: number; bytes?: number } = { running: false };
let backupTimer: ReturnType<typeof setTimeout> | null = null;

function defaultBackupDir() {
  return existsSync(ICLOUD_DIR) ? path.join(ICLOUD_DIR, "会议录音纪要备份") : path.join(os.homedir(), "Documents", "会议录音纪要备份");
}

// 某条记录里哪些文件要备份
async function backupFiles(dir: string, meta: Meta, scope: string) {
  const out: string[] = [];
  const video = new Set(VIDEO_FILES(meta));
  const walk = async (rel: string) => {
    for (const f of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
      const r = rel ? `${rel}/${f.name}` : f.name;
      if (f.isDirectory()) { await walk(r); continue; }
      if (f.name.startsWith(".") || f.name.endsWith("-16k.wav")) continue;
      const isText = TEXT_EXT.has(path.extname(f.name).toLowerCase());
      if (isText || scope === "all" || (scope === "audio" && !video.has(r))) out.push(r);
    }
  };
  await walk("");
  return out;
}

async function syncDir(srcDir: string, destDir: string, files: string[]) {
  let copied = 0, bytes = 0;
  for (const rel of files) {
    const src = path.join(srcDir, rel), dest = path.join(destDir, rel);
    const a = await stat(src).catch(() => null);
    if (!a) continue;
    const b = await stat(dest).catch(() => null);
    // 复制时保留的修改时间会丢掉毫秒以下的精度,留 2 秒余量
    if (b && b.size === a.size && b.mtimeMs + 2000 >= a.mtimeMs) continue;
    await mkdir(path.dirname(dest), { recursive: true });
    // 注意:Bun 的 cp 带 preserveTimestamps 时不会覆盖已存在的文件(也不报错),所以分两步
    await copyFile(src, dest);
    await utimes(dest, a.atime, a.mtime);
    copied++; bytes += a.size;
  }
  return { copied, bytes };
}

async function runBackup() {
  const cfg = await loadConfig();
  if (!cfg.backupDir || backupState.running) return backupState;
  backupState = { ...backupState, running: true, lastError: undefined };
  try {
    const root = cfg.backupDir;
    await mkdir(path.join(root, "meetings"), { recursive: true });
    let copied = 0, bytes = 0;
    const keep = new Set<string>();
    for (const meta of await listMeetings()) {
      const files = await backupFiles(meetingDir(meta.id), meta, cfg.backupScope);
      const r = await syncDir(meetingDir(meta.id), path.join(root, "meetings", meta.id), files);
      copied += r.copied; bytes += r.bytes;
      keep.add(meta.id);
    }
    for (const t of await listTrash()) keep.add(t.id); // 最近删除里的先留着,30 天后跟着清
    for (const id of await readdir(path.join(root, "meetings")).catch(() => [] as string[])) {
      if (/^[\w-]+$/.test(id) && !keep.has(id)) await rm(path.join(root, "meetings", id), { recursive: true, force: true });
    }
    // 词库和模板也备份;config.json 里有密钥,不备份
    for (const f of ["glossary.json", "templates.json"]) {
      if (existsSync(path.join(ROOT, f))) await cp(path.join(ROOT, f), path.join(root, f));
    }
    await writeFile(path.join(root, "说明.txt"), `这是「会议录音纪要」的备份,由程序自动维护。\n恢复:在应用的「设置 → 备份」里点「从备份恢复」。\n最近一次备份:${new Date().toLocaleString("zh-CN")}\n`);
    backupState = { running: false, lastAt: new Date().toISOString(), copied, bytes };
    if (copied) console.log(`备份完成:复制 ${copied} 个文件`);
  } catch (e: any) {
    backupState = { ...backupState, running: false, lastError: String(e?.message || e) };
    console.error("备份失败:", backupState.lastError);
  }
  return backupState;
}

// 有改动后 1 分钟再备份,连着改不会反复跑;另外每 30 分钟兜底一次
function scheduleBackup() {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => { backupTimer = null; runBackup().catch(() => {}); }, 60_000);
}
setInterval(() => runBackup().catch(() => {}), 30 * 60_000);

// 从备份恢复:本机没有的记录拷回来(已有的不覆盖)
async function restoreFromBackup() {
  const cfg = await loadConfig();
  if (!cfg.backupDir) throw new Error("还没有设置备份位置");
  let restored = 0;
  for (const id of await readdir(path.join(cfg.backupDir, "meetings")).catch(() => [] as string[])) {
    if (!/^[\w-]+$/.test(id) || existsSync(meetingDir(id)) || existsSync(trashDir(id))) continue;
    await cp(path.join(cfg.backupDir, "meetings", id), meetingDir(id), { recursive: true });
    // 只备份了文字的话,录音文件不在了
    const meta = await readMeta(id);
    if (meta.audioFile && !existsSync(path.join(meetingDir(id), meta.audioFile))) {
      meta.audioFile = ""; meta.hasVideo = false; meta.mediaRemoved = true;
      await writeMeta(meta);
    }
    restored++;
  }
  return restored;
}

// 新录音进来之后:按设置决定要不要自动转写
async function afterNewMedia(id: string) {
  const cfg = await loadConfig();
  if (cfg.autoTranscribe === "1") enqueue(id, "transcribe");
}

// ---------- 原生录制(录制助手.app) ----------
type RecStatus = {
  state: "starting" | "recording" | "paused" | "finished" | "error";
  pid?: number;
  elapsed?: number;
  markers?: number[];
  warnings?: string[];
  error?: string;
  files?: { screen?: string; system?: string; mic?: string };
  durationSec?: number;
};
type ActiveRec = { id: string; workDir: string; launchedAt: number };
let activeRec: ActiveRec | null = null;
let lastRecError = "";
let lastRecNotice = ""; // 录制结束后给网页的提示,比如「太短,已放进最近删除」
let finalizing = false;

async function ensureRecorderApp() {
  if (process.platform !== "darwin") throw new Error("原生录制只支持 macOS");
  const fresh = existsSync(RECORDER_BIN) && (await stat(RECORDER_BIN)).mtimeMs >= (await stat(RECORDER_SRC)).mtimeMs;
  if (fresh) return;
  console.log("正在编译录制助手…");
  await run(["bash", path.join(ROOT, "native", "build-recorder.sh")]);
}

// 用 open 启动,系统会把录屏 / 麦克风权限算在「录制助手」头上,而不是终端或 bun
async function launchRecorder(args: string[], wait = false) {
  await ensureRecorderApp();
  await run(["open", "-n", "-g", ...(wait ? ["-W"] : []), RECORDER_APP, "--args", ...args]);
}

async function readRecStatus(workDir: string): Promise<RecStatus | null> {
  try { return JSON.parse(await readFile(path.join(workDir, "status.json"), "utf8")); } catch { return null; }
}

function pidAlive(pid?: number) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function listSources() {
  await mkdir(REC_WORK_DIR, { recursive: true });
  const out = path.join(REC_WORK_DIR, "sources.json");
  await rm(out, { force: true });
  await launchRecorder(["--list", "--out", out], true);
  const data = JSON.parse(await readTextIfExists(out) || "{}");
  if (data.error === "no-permission") {
    throw new Error("需要屏幕录制权限:打开「系统设置 → 隐私与安全性 → 屏幕与系统录音」,打开「录制助手」后再点刷新。");
  }
  if (data.error) throw new Error(data.error);
  return data;
}

async function startRecording(body: any) {
  if (activeRec) throw new Error("已经在录制中");
  const mode = ["both", "audio", "screen"].includes(body.mode) ? body.mode : "both";
  const id = idFromDate(new Date());
  const workDir = path.join(REC_WORK_DIR, "recordings", id);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await mkdir(meetingDir(id), { recursive: true });
  const meta: Meta = {
    id,
    title: String(body.title || "").trim() || `会议 ${id}`,
    titleAuto: !String(body.title || "").trim() || /会议 \d{1,2}:\d{2}$/.test(String(body.title)),
    createdAt: new Date().toISOString(),
    durationSec: 0,
    audioFile: "",
    status: "recording",
    mode,
    markers: [],
  };
  const cfg = await loadConfig();
  const guest = String(body.guest || "").trim();
  if (cfg.myName.trim() || guest) await renameSpeakers(meta, { mic: cfg.myName, system: guest });
  await writeMeta(meta);

  const args = ["--out", workDir, "--mode", mode];
  if (body.windowId && mode !== "audio") args.push("--window", String(Number(body.windowId)));
  else if (body.displayId) args.push("--display", String(Number(body.displayId)));
  if (body.mic === false) args.push("--no-mic");
  try {
    await launchRecorder(args);
  } catch (e) {
    await rm(meetingDir(id), { recursive: true, force: true });
    throw e;
  }
  activeRec = { id, workDir, launchedAt: Date.now() };
  lastRecError = "";
  lastRecNotice = "";
  return meta;
}

async function signalRecorder(sig: "SIGUSR1" | "SIGUSR2" | "SIGINT") {
  if (!activeRec) throw new Error("当前没有在录制");
  const st = await readRecStatus(activeRec.workDir);
  if (!st?.pid || !pidAlive(st.pid)) throw new Error("录制助手还没启动好");
  process.kill(st.pid, sig);
}

async function moveFile(from: string, to: string) {
  try { await rename(from, to); } catch { await cp(from, to); await rm(from, { force: true }); }
}

// 录制结束:搬文件、合成播放用的文件、写 meta、自动转写
async function finalizeRecording(rec: ActiveRec, st: RecStatus) {
  const dir = meetingDir(rec.id);
  const meta = await readMeta(rec.id);
  const files = st.files || {};
  for (const f of Object.values(files)) if (f) await moveFile(path.join(rec.workDir, f), path.join(dir, f));

  const audios = [files.system, files.mic].filter(Boolean) as string[];
  const audioInputs = audios.flatMap((f) => ["-i", path.join(dir, f)]);
  // 每条音轨先补齐开头的空白,再混音;normalize=0 保持原音量
  const mixFilter = audios.length > 1
    ? audios.map((_, i) => `[${i + (files.screen ? 1 : 0)}:a]aresample=async=1:first_pts=0[a${i}]`).join(";") +
      ";" + audios.map((_, i) => `[a${i}]`).join("") + `amix=inputs=${audios.length}:duration=longest:normalize=0[a]`
    : `[${files.screen ? 1 : 0}:a]aresample=async=1:first_pts=0[a]`;

  if (files.screen) {
    const media = "media.mp4";
    if (audios.length) {
      await run(["ffmpeg", "-y", "-loglevel", "error", "-i", path.join(dir, files.screen), ...audioInputs,
        "-filter_complex", mixFilter, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", path.join(dir, media)]);
      await rm(path.join(dir, files.screen), { force: true }); // 画面已经原样拷进 media.mp4
    } else {
      await run(["ffmpeg", "-y", "-loglevel", "error", "-i", path.join(dir, files.screen), "-c", "copy", "-movflags", "+faststart", path.join(dir, media)]);
      await rm(path.join(dir, files.screen), { force: true });
    }
    meta.audioFile = media;
    meta.hasVideo = true;
  } else if (audios.length) {
    await run(["ffmpeg", "-y", "-loglevel", "error", ...audioInputs, "-filter_complex", mixFilter,
      "-map", "[a]", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", path.join(dir, "audio.m4a")]);
    meta.audioFile = "audio.m4a";
  }

  meta.tracks = { ...(files.mic ? { mic: files.mic } : {}), ...(files.system ? { system: files.system } : {}) };
  meta.markers = st.markers || [];
  meta.warnings = st.warnings?.length ? st.warnings : undefined;
  meta.durationSec = Math.round(st.durationSec || st.elapsed || 0) || (meta.audioFile ? await probeDuration(path.join(dir, meta.audioFile)) : 0);
  meta.status = "recorded";
  if (!meta.audioFile) {
    meta.status = "error";
    meta.error = "没有录到任何内容。" + (st.warnings || []).join(" ");
  }
  await writeMeta(meta);
  await rm(rec.workDir, { recursive: true, force: true });

  // 误触快捷键之类录下的几秒钟:放进「最近删除」,不进列表
  const cfg = await loadConfig();
  if (cfg.discardShort === "1" && meta.status !== "error" && meta.durationSec < 5) {
    await trashMeeting(rec.id, true);
    lastRecNotice = `这次只录了 ${meta.durationSec} 秒,当作误触,已放进「最近删除」。需要的话可以在那里恢复。`;
    return;
  }

  // 有声音就自动转写
  if (audios.length) await afterNewMedia(rec.id);
}

async function failRecording(rec: ActiveRec, msg: string) {
  lastRecError = msg;
  try {
    const meta = await readMeta(rec.id);
    meta.status = "error";
    meta.error = msg;
    await writeMeta(meta);
  } catch {}
  // 一点内容都没录到的话,把空记录删掉
  const dir = meetingDir(rec.id);
  const left = existsSync(dir) ? (await readdir(dir)).filter((f) => f !== "meta.json") : [];
  if (!left.length) await rm(dir, { recursive: true, force: true });
  await rm(rec.workDir, { recursive: true, force: true });
}

// 不管网页开没开,都在后台盯着录制助手(用户可能从菜单栏点停止)
async function pollRecording() {
  if (!activeRec || finalizing) return;
  const rec = activeRec;
  const st = await readRecStatus(rec.workDir);
  if (st?.state === "finished") {
    finalizing = true;
    try { await finalizeRecording(rec, st); }
    catch (e: any) { await failRecording(rec, "处理录制文件失败:" + String(e?.message || e)); }
    finally { activeRec = null; finalizing = false; }
  } else if (st?.state === "error") {
    activeRec = null;
    await failRecording(rec, st.error || "录制出错");
  } else if (st?.pid && !pidAlive(st.pid)) {
    activeRec = null;
    await failRecording(rec, "录制助手意外退出");
  } else if (!st && Date.now() - rec.launchedAt > 90_000) {
    activeRec = null;
    await failRecording(rec, "录制助手没有启动");
  }
}
setInterval(() => pollRecording().catch((e) => console.error(e)), 1000);

async function recordingStatus() {
  if (!activeRec) return { active: false, error: lastRecError || undefined, notice: lastRecNotice || undefined };
  const st = await readRecStatus(activeRec.workDir);
  return {
    active: true,
    id: activeRec.id,
    state: finalizing ? "processing" : st?.state || "starting",
    elapsed: st?.elapsed || 0,
    markers: st?.markers || [],
    warnings: st?.warnings || [],
  };
}

// 服务重启时接上还在进行的录制
async function recoverRecordings() {
  for (const m of await listMeetings()) {
    if (m.status !== "recording") continue;
    const rec: ActiveRec = { id: m.id, workDir: path.join(REC_WORK_DIR, "recordings", m.id), launchedAt: Date.now() };
    const st = await readRecStatus(rec.workDir);
    if (st && (st.state === "finished" || pidAlive(st.pid)) && !activeRec) activeRec = rec;
    else await failRecording(rec, "录制中断(服务重启时录制助手已不在运行)");
  }
}
recoverRecordings().catch((e) => console.error(e));

// 前端用到的第三方库直接从 node_modules 提供,离线也能用
const VENDOR: Record<string, string> = {
  "/vendor/d3.js": "d3/dist/d3.min.js",
  "/vendor/markmap-lib.js": "markmap-lib/dist/browser/index.iife.js",
  "/vendor/markmap-view.js": "markmap-view/dist/browser/index.js",
};

// ---------- 应用模式:窗口关掉后自动退出 ----------
let lastPing = 0;
if (APP_MODE) {
  setInterval(() => {
    if (activeRec) return; // 录制中不退出
    if (lastPing && Date.now() - lastPing > 30_000) {
      console.log("窗口已关闭,服务退出");
      process.exit(0);
    }
  }, 5_000);
}

// ---------- HTTP ----------
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

// 视频要支持 Range 请求,播放器才能拖动进度条
async function serveFileWithRange(req: Request, filePath: string) {
  const file = Bun.file(filePath);
  const size = file.size;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") || "");
  if (!m) return new Response(file, { headers: { "Accept-Ranges": "bytes" } });
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1] && m[2] ? Number(m[2]) : size - 1;
  end = Math.min(end, size - 1);
  if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
      "Content-Type": file.type,
    },
  });
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const method = req.method;

  if (parts[1] === "ping") {
    lastPing = Date.now();
    return json({ ok: true, appMode: APP_MODE });
  }

  if (parts[1] === "settings") {
    if (method === "GET") return json(maskConfig(await loadConfig()));
    if (method === "POST") {
      const body = await req.json();
      for (const k of ["transcribeApiKey", "anthropicApiKey", "openaiApiKey"]) {
        if (typeof body[k] === "string" && body[k].includes("…")) delete body[k];
      }
      const before = await loadConfig();
      // 换了备份位置,之前的「上次备份」记录就不算数了
      if (typeof body.backupDir === "string" && body.backupDir !== before.backupDir) backupState = { running: false };
      if (body.autoImportVoiceMemos === "1" && before.autoImportVoiceMemos !== "1") {
        body.voiceMemosSince = String(Date.now());
        vmLastSig = "";
      }
      await saveConfig(body);
      return json(maskConfig(await loadConfig()));
    }
  }

  if (parts[1] === "claude-status" && method === "GET") {
    return json(await claudeCliStatus(await loadConfig()));
  }

  // 打开系统设置里的隐私页面(只允许这几个)
  if (parts[1] === "open-privacy" && method === "POST") {
    const pane = ({ files: "Privacy_AllFiles", screen: "Privacy_ScreenCapture", mic: "Privacy_Microphone" } as Record<string, string>)[url.searchParams.get("pane") || ""];
    if (!pane) return json({ error: "未知页面" }, 400);
    await run(["open", `x-apple.systempreferences:com.apple.preference.security?${pane}`]);
    return json({ ok: true });
  }

  if (parts[1] === "voicememos") {
    if (method === "GET") {
      const cfg = await loadConfig();
      return json({ memos: await listVoiceMemos(), autoImport: cfg.autoImportVoiceMemos === "1", lastError: vmLastError || undefined });
    }
    if (parts[2] === "import" && method === "POST") {
      const body = await req.json();
      const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(String));
      const memos = (await listVoiceMemos()).filter((m) => ids.has(m.uid));
      const imported: Meta[] = [], errors: string[] = [];
      for (const m of memos) {
        try { imported.push(await importVoiceMemo(m)); } catch (e: any) { errors.push(String(e?.message || e)); }
      }
      return json({ imported, errors });
    }
  }

  // 批量删除(移到最近删除)
  if (parts[1] === "delete" && method === "POST") {
    const body = await req.json();
    const errors: string[] = [];
    let done = 0;
    for (const id of (Array.isArray(body.ids) ? body.ids : []).map(String)) {
      try { await trashMeeting(id); done++; } catch (e: any) { errors.push(String(e?.message || e)); }
    }
    return json({ done, errors });
  }

  if (parts[1] === "backup") {
    if (method === "GET") {
      const cfg = await loadConfig();
      return json({ ...backupState, dir: cfg.backupDir, scope: cfg.backupScope, suggested: defaultBackupDir(), icloud: existsSync(ICLOUD_DIR) });
    }
    if (parts[2] === "run" && method === "POST") return json(await runBackup());
    if (parts[2] === "restore" && method === "POST") return json({ restored: await restoreFromBackup() });
    if (parts[2] === "reveal" && method === "POST") {
      const cfg = await loadConfig();
      if (cfg.backupDir && existsSync(cfg.backupDir)) await run(["open", cfg.backupDir]);
      return json({ ok: true });
    }
  }

  if (parts[1] === "trash") {
    const tid = parts[2];
    if (!tid && method === "GET") return json(await listTrash());
    if (!tid && method === "DELETE") { await purgeTrash(false); return json({ ok: true }); }
    if (tid && parts[3] === "restore" && method === "POST") return json(await restoreMeeting(tid));
    if (tid && !parts[3] && method === "DELETE") { await rm(trashDir(tid), { recursive: true, force: true }); return json({ ok: true }); }
  }

  // 导出:直接存进「下载」文件夹并在访达里选中(浏览器面板里下载可能被拦)
  if (parts[1] === "export" && method === "POST") {
    const body = await req.json();
    const name = String(body.name || "导出").replace(/[\/\\:*?"<>|\n]/g, "_").slice(0, 120);
    let data: Buffer;
    if (typeof body.dataUrl === "string" && body.dataUrl.startsWith("data:")) data = Buffer.from(body.dataUrl.split(",")[1] || "", "base64");
    else if (body.srt) data = Buffer.from(await buildSrt(await readMeta(String(body.srt)), !!body.speaker), "utf8");
    else data = Buffer.from(String(body.content ?? ""), "utf8");
    const downloads = path.join(os.homedir(), "Downloads");
    const ext = path.extname(name);
    let target = path.join(downloads, name);
    for (let i = 2; existsSync(target); i++) target = path.join(downloads, `${path.basename(name, ext)} (${i})${ext}`);
    await writeFile(target, data);
    await run(["open", "-R", target]).catch(() => {});
    return json({ path: target });
  }

  if (parts[1] === "queue") {
    if (method === "GET") return json(jobs);
    if (method === "POST") {
      const body = await req.json();
      const kind = body.kind === "transcribe" ? "transcribe" : "analyze";
      const ids: string[] = (Array.isArray(body.meetingIds) ? body.meetingIds : []).map(String).filter((id: string) => existsSync(meetingDir(id)));
      const templateIds = Array.isArray(body.templateIds) ? body.templateIds.map(String) : undefined;
      return json(ids.map((id) => enqueue(id, kind, templateIds)));
    }
  }

  if (parts[1] === "ask" && method === "POST") {
    const body = await req.json();
    const question = String(body.question || "").trim();
    const history: AskTurn[] = (Array.isArray(body.history) ? body.history : [])
      .map((t: any) => ({ q: String(t?.q || ""), a: String(t?.a || "").slice(0, 4000) })).filter((t: AskTurn) => t.q);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        try {
          if (!question) throw new Error("请输入问题");
          const text = await askLibrary(question, history, send);
          send("done", { text });
        } catch (e: any) {
          send("error", { message: e instanceof Anthropic.APIError ? `Claude API ${e.status}: ${e.message}` : String(e?.message || e) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  }

  if (parts[1] === "search" && method === "GET") {
    return json(await searchMeetings(url.searchParams.get("q") || ""));
  }

  if (parts[1] === "glossary") {
    if (method === "GET") return json(await loadGlossary());
    if (method === "PUT") return json(await saveGlossary(await req.json()));
  }

  if (parts[1] === "templates") {
    if (method === "GET") return json({ templates: await loadTemplates(), defaults: await defaultTemplates() });
    if (method === "PUT") return json(await saveTemplates(await req.json()));
    if (method === "DELETE") { await rm(TEMPLATES_PATH, { force: true }); return json(await loadTemplates()); }
  }

  if (parts[1] === "record") {
    const action = parts[2];
    if (action === "sources" && method === "GET") return json(await listSources());
    if (action === "status" && method === "GET") return json(await recordingStatus());
    if (action === "start" && method === "POST") return json(await startRecording(await req.json()));
    const sig = ({ pause: "SIGUSR1", mark: "SIGUSR2", stop: "SIGINT" } as const)[action as "pause" | "mark" | "stop"];
    if (sig && method === "POST") {
      await signalRecorder(sig);
      return json({ ok: true });
    }
  }

  if (parts[1] === "actions" && method === "GET") {
    return json(await listAllActions());
  }

  if (parts[1] === "briefing" && method === "GET") {
    return json(await briefing());
  }

  if (parts[1] === "reminders") {
    if (method === "GET") return json(await dueDigest());
    if (method === "POST") return json(await sendDueReminder(true));
  }

  if (parts[1] === "meetings") {
    const id = parts[2];
    const action = parts[3];

    if (!id && method === "GET") {
      const active = jobs.filter((j) => j.state === "queued" || j.state === "running");
      const list = await listMeetings();
      const sizes = await Promise.all(list.map((m) => dirSize(meetingDir(m.id))));
      return json(list.map((m, i) => {
        const j = active.find((x) => x.meetingId === m.id);
        return { ...m, size: sizes[i], ...(j ? { job: { kind: j.kind, state: j.state } } : {}) };
      }));
    }

    if (!id && method === "POST") {
      const form = await req.formData();
      const audio = form.get("audio");
      if (!(audio instanceof File)) return json({ error: "缺少音频" }, 400);
      const newMeetingId = idFromDate(new Date());
      const dir = meetingDir(newMeetingId);
      await mkdir(dir, { recursive: true });
      const ext = (audio.name.split(".").pop() || "webm").toLowerCase().replace(/[^a-z0-9]/g, "") || "webm";
      await Bun.write(path.join(dir, `audio.${ext}`), audio);
      let audioFile = `audio.${ext}`, hasVideo = false;
      try {
        ({ file: audioFile, hasVideo } = await normalizeMedia(dir, audioFile));
      } catch (e: any) {
        await rm(dir, { recursive: true, force: true });
        return json({ error: "无法识别这个文件的格式:" + String(e?.message || e).slice(0, 200) }, 400);
      }
      const meta: Meta = {
        id: newMeetingId,
        title: String(form.get("title") || `会议 ${newMeetingId}`),
        // 文件名是「新录音 3」「IMG_7982」「屏幕录制 2026-10-12」这类没有意义的,也让 Claude 起标题
        titleAuto: !String(form.get("title") || "").trim() || GENERIC_NAME.test(String(form.get("title"))) || undefined,
        createdAt: new Date().toISOString(),
        durationSec: Number(form.get("durationSec")) || (await probeDuration(path.join(dir, audioFile))),
        audioFile,
        hasVideo: hasVideo || undefined,
        status: "recorded",
      };
      await writeMeta(meta);
      await afterNewMedia(newMeetingId);
      return json(meta);
    }

    if (id && !action && method === "GET") {
      const meta = await readMeta(id);
      const dir = meetingDir(id);
      const job = jobs.find((j) => j.meetingId === id && (j.state === "queued" || j.state === "running"));
      const mediaFiles = [meta.audioFile, meta.tracks?.mic, meta.tracks?.system].filter(Boolean) as string[];
      let mediaSize = 0, videoSize = 0;
      for (const f of mediaFiles) {
        const sz = (await stat(path.join(dir, f)).catch(() => ({ size: 0 }))).size;
        mediaSize += sz;
        if (f === meta.audioFile && meta.hasVideo) videoSize = sz;
      }
      return json({
        ...meta,
        size: await dirSize(dir),
        mediaSize,
        videoSize,
        job: job ? { kind: job.kind, state: job.state } : undefined,
        transcript: await readTextIfExists(path.join(dir, "transcript.txt")),
        results: await readResults(dir),
      });
    }

    if (id && !action && method === "DELETE") {
      await trashMeeting(id);
      return json({ ok: true });
    }

    if (id && action === "title" && method === "POST") {
      const title = await autoTitle(id, true);
      return json({ title });
    }

    if (id && action === "strip" && method === "POST") {
      const body = await req.json();
      return json(await stripMedia(id, body.keep === "text" ? "text" : "audio"));
    }

    if (id && !action && method === "PATCH") {
      const meta = await readMeta(id);
      const body = await req.json();
      if (typeof body.title === "string" && body.title.trim() && body.title.trim() !== meta.title) { meta.title = body.title.trim(); meta.titleAuto = undefined; }
      if (body.speakerNames && typeof body.speakerNames === "object") await renameSpeakers(meta, body.speakerNames);
      await writeMeta(meta);
      return json(meta);
    }

    if (id && action === "srt" && method === "GET") {
      const meta = await readMeta(id);
      const srt = await buildSrt(meta, url.searchParams.get("speaker") === "1");
      const name = encodeURIComponent(`${meta.title}.srt`);
      return new Response(srt, { headers: { "Content-Type": "application/x-subrip; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${name}` } });
    }

    if (id && action === "audio" && method === "GET") {
      const meta = await readMeta(id);
      if (!meta.audioFile) return json({ error: "没有媒体文件" }, 404);
      return serveFileWithRange(req, path.join(meetingDir(id), meta.audioFile));
    }

    if (id && action === "transcribe" && method === "POST") {
      return json(enqueue(id, "transcribe"));
    }

    if (id && action === "analyze" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      return analyzeMeeting(id, Array.isArray(body.templateIds) ? body.templateIds.map(String) : []);
    }

    if (id && action === "actions") {
      const aid = parts[4];
      if (!aid && method === "GET") return json(await readActions(id));
      if (!aid && method === "POST") {
        const body = await req.json().catch(() => ({}));
        if (body.extract) return json(await extractActions(id));
        if (body.confirm) {
          const ids: string[] | null = Array.isArray(body.ids) ? body.ids.map(String) : null;
          const list = (await readActions(id)).map((a) =>
            a.status === "pending" && (!ids || ids.includes(a.id)) ? { ...a, status: "todo" as ActionStatus, updatedAt: new Date().toISOString() } : a);
          await writeActions(id, list);
          return json(list);
        }
        const text = String(body.text || "").trim();
        if (!text) return json({ error: "缺少任务内容" }, 400);
        const now = new Date().toISOString();
        const item: ActionItem = { id: newActionId(), text, owner: String(body.owner || "").trim(), due: normalizeDue(body.due), status: "todo", source: null, createdAt: now, updatedAt: now };
        const list = (await readActions(id)).concat(item);
        await writeActions(id, list);
        return json(item);
      }
      if (aid && method === "PATCH") {
        const body = await req.json();
        const list = await readActions(id);
        const i = list.findIndex((a) => a.id === aid);
        if (i < 0) return json({ error: "没有这条行动项" }, 404);
        list[i] = patchAction(list[i], body);
        await writeActions(id, list);
        return json(list[i]);
      }
      if (aid && method === "DELETE") {
        const list = await readActions(id);
        await writeActions(id, list.filter((a) => a.id !== aid));
        return json({ ok: true });
      }
    }

    if (id && action === "reviews") {
      const aid = parts[4];
      if (!aid && method === "GET") return json(await readReviews(id));
      if (!aid && method === "POST") return json(await reviewActions(id));
      if (aid && method === "POST") {
        const body = await req.json().catch(() => ({}));
        const meta = await readMeta(id);
        return json(await resolveReview(id, aid, !!body.accept, meta.title));
      }
    }

    if (id && action === "transcript" && method === "PUT") {
      const body = await req.json();
      await writeFile(path.join(meetingDir(id), "transcript.txt"), String(body.transcript || ""));
      return json({ ok: true });
    }
  }

  return json({ error: "not found" }, 404);
}

// 只允许本机访问:同一 Wi-Fi 下的其他设备连不上;
// 其他网站在浏览器里偷偷请求本地服务(CSRF / DNS 重绑定)也拦掉
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
function forbidden(req: Request) {
  if (!ALLOWED_HOSTS.has(req.headers.get("host") || "")) return true;
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ""))) return true;
  return false;
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 255, // 转写长录音可能要几分钟
  async fetch(req) {
    if (forbidden(req)) return new Response("forbidden", { status: 403 });
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(req, url);
    } catch (e: any) {
      return json({ error: String(e?.message || e) }, 500);
    }
    const vendor = VENDOR[url.pathname];
    if (vendor) return new Response(Bun.file(path.join(ROOT, "node_modules", vendor)), { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    const p = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.join(PUBLIC_DIR, path.normalize(p));
    if (!filePath.startsWith(PUBLIC_DIR)) return new Response("forbidden", { status: 403 });
    const f = Bun.file(filePath);
    if (await f.exists()) return new Response(f);
    return new Response("not found", { status: 404 });
  },
});

console.log(`会议录音工具已启动: http://localhost:${PORT}${APP_MODE ? "(应用模式)" : ""}`);
console.log(`录音保存在: ${MEETINGS_DIR}`);
