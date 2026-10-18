// 网页演示版的云端函数(Cloudflare Pages Functions):问资料库、分析、提取行动项、对照旧任务。
// 模型走 MOI Genesis,Key 放在 Cloudflare 的环境变量 GENESIS_API_KEY 里,不进页面。
// 逐字稿和模板只用打包在 lib/seed.js 里的示例数据,访客只能传问题和自己浏览器里的任务状态,不能塞别的提示词。
import * as core from "../../../shared/core.js";
import seed from "../../lib/seed.js";

const TODAY = "2026-10-27"; // 和 demo.js 的演示时钟一致
const MAX_BODY = 64 * 1024;

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const str = (v, max) => String(v ?? "").slice(0, max);

async function llm(env, system, prompt, { stream = false, maxTokens = 2000 } = {}) {
  if (!env.GENESIS_API_KEY) throw new Error("服务端没有配置 MOI 的 Key");
  const req = () => fetch(`${env.GENESIS_BASE_URL || "https://token.moi.matrixorigin.cn/v1"}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GENESIS_API_KEY}` },
    body: JSON.stringify({
      model: env.GENESIS_MODEL || "qwen3.8-flash",
      stream,
      enable_thinking: false, // 关掉思考,几秒出结果
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    }),
  });
  // 模型网关偶尔回 5xx(实测见过 522),等一下再试,最多 3 次
  let res, lastErr = "";
  for (let i = 0; i < 3; i++) {
    try {
      res = await req();
      if (res.ok) return res;
      const t = await res.text().catch(() => "");
      lastErr = t.slice(0, 200);
      try { lastErr = JSON.parse(t).error?.message || lastErr; } catch {}
      lastErr = `模型接口 ${res.status}:${lastErr}`;
      if (res.status < 500) break;
    } catch (e) { lastErr = "连不上模型接口:" + String(e?.message || e); }
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  throw new Error(lastErr || "模型接口出错");
}

async function llmText(env, system, prompt, opts) {
  const d = await (await llm(env, system, prompt, opts)).json();
  return d.choices?.[0]?.message?.content || "";
}

// 把模型的流式输出一段段交给 onDelta,返回全文
async function readDeltas(res, onDelta) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "";
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
      let m;
      try { m = JSON.parse(data); } catch { continue; }
      const d = m.choices?.[0]?.delta?.content;
      if (typeof d === "string" && d) { text += d; await onDelta(d); }
    }
  }
  return text;
}

// 页面认的 SSE 格式:event: xxx / data: {...}
function sse(run) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const send = (event, data) => w.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  (async () => {
    try { await run(send); } catch (e) { await send("error", { message: String(e?.message || e) }); } finally { await w.close(); }
  })();
  return new Response(readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

const sampleMeeting = (id) => {
  const m = seed.meetings[String(id || "")];
  if (!m) throw Object.assign(new Error("没有这场示例会议"), { status: 404 });
  return m;
};
const meetingsAsc = () => Object.values(seed.meetings).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

function cleanTasks(list) {
  return (Array.isArray(list) ? list : []).slice(0, 200).map((a) => ({
    id: str(a?.id, 40), meetingId: str(a?.meetingId, 40), text: str(a?.text, 200), owner: str(a?.owner, 40),
    status: core.ACTION_STATUSES.includes(a?.status) ? a.status : "todo",
    due: core.normalizeDue(a?.due), doneAt: a?.doneAt ? str(a.doneAt, 30) : undefined, note: a?.note ? str(a.note, 200) : undefined,
    source: a?.source && Number.isFinite(a.source.t) ? { t: Math.max(0, Math.floor(a.source.t)), quote: str(a.source.quote, 80) } : null,
  })).filter((a) => a.text && seed.meetings[a.meetingId]);
}

function analysisPrompt(m) {
  const me = m.speakerNames.mic || "我", guest = m.speakerNames.system || "嘉宾";
  const note = `说话人:「${me}」${me !== "我" ? "(模板里说的「我」)" : ""}是主讲人本人(麦克风),「${guest}」${guest !== "嘉宾" ? "(模板里说的「嘉宾」)" : ""}是线上会议里其他人的声音。`;
  return `会议标题:${m.title}\n时长:${core.fmtTime(m.durationSec)}\n${note}\n\n<transcript>\n${m.transcript}\n</transcript>`;
}

// ---------- MOI 智能体(A2A) ----------
// 问资料库优先交给 MOI 上的「散会即开工助手」:它绑定了示例会议的知识库,自己检索再回答。
// 访客浏览器里的最新任务状态随问题一起发过去;智能体出错时退回直接调模型。
const AI_STUDIO = "https://api.moi.matrixorigin.cn/v5";

async function askAgent(env, text, send, docNames) {
  const res = await fetch(`${AI_STUDIO}/workspaces/${env.MOI_WORKSPACE_ID}/agents/${env.MOI_AGENT_ID}/a2a`, {
    method: "POST",
    headers: { "X-API-Key": env.GENESIS_API_KEY, "X-Workspace-ID": env.MOI_WORKSPACE_ID, "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: crypto.randomUUID(), method: "message/stream",
      params: { model: env.MOI_AGENT_MODEL || "deepseek-v4.1-flash", message: { kind: "message", role: "user", messageId: crypto.randomUUID(), parts: [{ kind: "text", text }] } },
    }),
  });
  if (!res.ok || !res.body) throw new Error(`MOI 智能体 ${res.status}:${(await res.text().catch(() => "")).slice(0, 160)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", streamed = "", finalText = "", searches = 0;
  const seen = new Set();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      // 先用字符串粗筛,大部分是心跳和「Working」状态帧,不必解析
      if (!/text_delta|tool_call"|RAG Chunks|Final Answer|"failed"|"canceled"|"error"/.test(frame)) continue;
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      let d;
      try { d = JSON.parse(line.slice(6)); } catch { continue; }
      if (d.error) throw new Error("MOI 智能体:" + (d.error.message || JSON.stringify(d.error)).slice(0, 160));
      const r = d.result || {}, md = r.metadata || {};
      const kind = md.eventKind;
      if (r.status?.state === "failed" || r.status?.state === "canceled") throw new Error("MOI 智能体没能完成这次回答");
      if (kind === "tool_call") { searches++; await send("stage", { text: `MOI 智能体正在检索知识库(第 ${searches} 次)…` }); }
      else if (r.kind === "artifact-update" && r.artifact?.name === "RAG Chunks") {
        const chunks = r.artifact.parts?.find((p) => p.kind === "data")?.data?.chunks || [];
        const hit = [...new Set(chunks.map((c) => docNames(String(c.chunk_id || "").split("_chunk_")[0])).filter(Boolean))];
        if (hit.length) await send("stage", { text: `在${hit.map((n) => `「${n}」`).join("")}里找到 ${chunks.length} 段相关记录,正在整理回答…` });
      } else if (kind === "text_delta") {
        const key = md.liveTextEventKey || md.eventCursor;
        if (key != null && seen.has(key)) continue;
        seen.add(key);
        for (const p of r.status?.message?.parts || []) if (p.kind === "text" && p.text) { streamed += p.text; await send("delta", { text: p.text }); }
      } else if (r.kind === "artifact-update" && r.artifact?.name === "Final Answer") {
        finalText = (r.artifact.parts || []).filter((p) => p.kind === "text").map((p) => p.text).join("");
      }
    }
  }
  // 智能体偶尔把出处包进反引号,去掉,页面才能把它变成可点的链接
  return (finalText || streamed).replace(/`(\[\[M\d+ \d{1,3}:\d{2}\]\])`/g, "$1");
}

const handlers = {
  async ask(body, env) {
    const question = str(body.question, 500).trim();
    if (!question) throw new Error("问题是空的");
    const history = (Array.isArray(body.history) ? body.history : []).slice(-3).map((t) => `用户之前问:${str(t?.q, 500)}\n你之前答:${str(t?.a, 3000)}`).join("\n\n");
    const list = meetingsAsc().map((m, i) => ({ ref: `M${i + 1}`, m }));
    const refById = new Map(list.map((x) => [x.m.id, x.ref]));
    const tasks = core.formatTasksBlock(cleanTasks(body.tasks), refById, TODAY);
    const docs = list.map(({ ref, m }) => `<meeting ref="${ref}">\n${ref}「${m.title}」${core.localDate(new Date(m.createdAt))} 时长 ${core.fmtTime(m.durationSec)}\n${m.transcript}\n</meeting>`).join("\n\n");
    const prompt = `${tasks.block ? tasks.block + "\n\n" : ""}${docs}\n\n${history ? history + "\n\n" : ""}现在的问题:${question}`;
    // 发给智能体的消息:当前日期 + 访客浏览器里的最新任务清单 + 最近几轮对话 + 问题(逐字稿在它的知识库里)
    const agentText = [
      `【当前日期】${TODAY}`,
      tasks.lines.length ? `【当前任务清单】(访问者浏览器里的最新状态,任务状态以此为准;方括号是定下它的会议编号和时间点)\n${tasks.lines.join("\n")}` : "",
      history ? `【之前的对话】\n${history}` : "",
      `【问题】${question}`,
    ].filter(Boolean).join("\n\n");
    const docNames = (fileId) => (seed.kbDocs || {})[fileId] || "";
    return sse(async (send) => {
      await send("sources", { sources: list.map(({ ref, m }) => ({ ref, id: m.id, title: m.title, createdAt: m.createdAt })) });
      if (env.MOI_AGENT_ID && env.MOI_WORKSPACE_ID && body.engine !== "model") {
        try {
          await send("stage", { text: "已交给 MOI 智能体「散会即开工助手」,它会先检索知识库再回答,通常要半分钟到 1 分钟…" });
          const text = await askAgent(env, agentText, send, docNames);
          if (text) { await send("done", { text, engine: "moi-agent" }); return; }
        } catch (e) {
          await send("stage", { text: `MOI 智能体这次没答上来(${String(e?.message || e).slice(0, 60)}),改用模型直接回答…` });
          await send("reset", {});
        }
      }
      const res = await llm(env, core.ASK_SYSTEM, prompt, { stream: true, maxTokens: 2000 });
      const text = await readDeltas(res, (d) => send("delta", { text: d }));
      await send("done", { text, engine: "model" });
    });
  },

  async analyze(body, env) {
    const m = sampleMeeting(body.meetingId);
    const wanted = new Set((Array.isArray(body.templateIds) ? body.templateIds : []).map(String));
    const chosen = seed.templates.filter((t) => wanted.has(t.id)).slice(0, 4);
    if (!chosen.length) throw new Error("先勾选至少一个模板");
    const prompt = analysisPrompt(m);
    return sse(async (send) => {
      for (const t of chosen) {
        await send("start", { templateId: t.id, name: t.name });
        try {
          const res = await llm(env, `${t.prompt}\n\n${seed.COMMON_RULES}`, prompt, { stream: true, maxTokens: 4000 });
          let text = await readDeltas(res, (d) => send("delta", { templateId: t.id, text: d }));
          if (t.format === "mindmap") text = text.replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/m, "$1").trim();
          await send("done", { templateId: t.id, text });
        } catch (e) {
          await send("error", { templateId: t.id, message: String(e?.message || e) });
        }
      }
    });
  },

  async extract(body, env) {
    const m = sampleMeeting(body.meetingId);
    const known = (Array.isArray(body.known) ? body.known : []).slice(0, 50).map((t) => str(t, 200));
    const names = [m.speakerNames.mic, m.speakerNames.system].filter(Boolean);
    const prompt = core.buildExtractPrompt({ createdAt: m.createdAt, names, transcript: m.transcript, known });
    return json({ arr: core.extractJsonArray(await llmText(env, core.ACTIONS_SYSTEM, prompt, { maxTokens: 2500 })) });
  },

  async review(body, env) {
    const m = sampleMeeting(body.meetingId);
    const open = (Array.isArray(body.open) ? body.open : []).slice(0, 40).map((a) => ({
      id: str(a?.id, 40), meetingId: str(a?.meetingId, 40), text: str(a?.text, 200), owner: str(a?.owner, 40),
      due: core.normalizeDue(a?.due), meetingAt: str(a?.meetingAt, 40), meetingTitle: str(a?.meetingTitle, 80),
    })).filter((a) => a.id && a.text && a.meetingAt);
    if (!open.length) return json({ arr: [] });
    const prompt = core.buildReviewPrompt({ open, transcript: m.transcript });
    return json({ arr: core.extractJsonArray(await llmText(env, core.REVIEW_SYSTEM, prompt, { maxTokens: 2000 })) });
  },
};

export async function onRequestPost({ request, env, params }) {
  const name = [].concat(params.path || [])[0];
  const handler = handlers[name];
  if (!handler) return json({ error: "没有这个接口" }, 404);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: "请求太大" }, 413);
  let body;
  try { body = JSON.parse(raw || "{}"); } catch { return json({ error: "请求格式不对" }, 400); }
  try {
    return await handler(body, env);
  } catch (e) {
    return json({ error: String(e?.message || e) }, e?.status || 500);
  }
}

export const onRequestGet = () => json({ ok: true, endpoints: Object.keys(handlers) });
