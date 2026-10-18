// 会议变行动的核心逻辑:提示词 + 纯函数,不碰文件和网络。
// 本地服务(server.ts)、网页演示版(web/demo.js)、云端函数(web/functions)共用这一份,保证三边行为一致。
// 所有跟「现在」有关的函数都显式传入时间,演示版可以把「今天」固定在某一天。

export const ACTION_STATUSES = ["pending", "todo", "doing", "done", "dropped"];

export const ACTIONS_SYSTEM = `你是会议行动项提取器。从会议逐字稿里找出所有「某人承诺要做的具体事情」,输出一个 JSON 数组,不要输出任何其他文字。

每个元素的字段:
- "text": 做什么,一句话,动词开头,具体到可以判断做没做(例如「把报价单发给客户」,不要「跟进报价」)
- "owner": 谁负责。用逐字稿里的说话人名字或被点名的人名;听不出来就写 ""
- "due": 截止日期,格式 YYYY-MM-DD。「下周三」「月底前」「明天」这类相对时间,按会议日期换算成具体日期;没提到就写 null
- "due_text": 原话里的时间表述,如「下周三」;没有就写 ""
- "time": 这件事在逐字稿里出现的时间戳,照抄行首的 mm:ss
- "quote": 承诺这件事的原话,30 字以内,照抄逐字稿
- "confidence": 0 到 1,你有多确定这是一个明确的行动项

规则:
- 只提「要去做的事」,不提已经做完的事、纯讨论、纯结论、泛泛的「以后要注意」
- 同一件事只出一条,不要拆成多条
- 一场会通常 3 到 12 条;确实没有就输出 []
- 人名、品牌名按专有名词表纠正
- 严格输出 JSON,不要 Markdown 围栏`;

export const REVIEW_SYSTEM = `你是会议任务跟踪员。下面有一份「之前会议定下、还没完成的任务清单」和一份「新会议的逐字稿」。
找出逐字稿里提到了清单中哪些任务的进展,输出 JSON 数组,不要输出其他文字。只输出确实被提到的任务,没提到的不要出现。

每个元素:
- "id": 清单里的任务 id,照抄
- "status": "done"(说做完了 / 已经发了 / 搞定了)、"doing"(说在做、有进展但没完)、"dropped"(说不做了 / 取消 / 不用了)
- "time": 逐字稿里提到的位置,照抄行首的 mm:ss
- "quote": 原话,30 字以内,照抄
- "confidence": 0 到 1

规则:只依据原话,不要推测;同一任务只出一条;严格输出 JSON,不要 Markdown 围栏。`;

export const ASK_SYSTEM = `你是用户的会议资料库助手。用户是主讲人,资料是他录制的会议 / 分享的逐字稿(语音识别结果,可能有错别字)。
根据提供的资料回答用户的问题:
- 只依据资料回答,资料里没有的就直接说"资料里没有提到",不要编造。
- 每个要点后面标注出处,格式严格写成 [[M编号 mm:ss]],例如 [[M2 13:05]];时间取逐字稿里最接近的时间戳。同一要点有多处出处可以写多个。
- M编号只用在出处标记里;正文里提到某场会议时写它的标题,不要写 M编号。
- 涉及多场会议时,可以对比不同场次说法的异同,并说明是哪一场。
- 资料里可能附有「任务清单」:会议上定下的行动项,带负责人、状态、截止日期和定下它的那场会议及时间戳。问到「谁负责 / 做了没 / 哪次会定的 / 还有什么没做」这类问题时,以任务清单为准回答状态,再用逐字稿补充当时怎么说的;出处同样写 [[M编号 mm:ss]]。
- 用 Markdown,简洁直接,不要开场白。`;

export const STATUS_CN = { pending: "待确认(AI 提取,还没人确认)", todo: "待办", doing: "进行中", done: "已完成", dropped: "搁置" };

// ---------- 小工具 ----------
export const newActionId = () => "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
export const fmtTime = (sec) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const shiftDate = (ymd, days) => { const [y, m, d] = ymd.split("-").map(Number); return localDate(new Date(y, m - 1, d + days)); };
const fmtMD = (ymd) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;

// 「下周三」这类相对时间由模型换算,这里只做兜底校验
export function normalizeDue(v) {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) return null;
  return `${m[1]}-${String(Number(m[2])).padStart(2, "0")}-${String(Number(m[3])).padStart(2, "0")}`;
}

export function parseTimestamp(v) {
  if (typeof v === "number" && isFinite(v)) return Math.max(0, Math.floor(v));
  const m = String(v ?? "").match(/(\d{1,3}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export const normText = (s) => s.replace(/[\s,。,.;;:：、「」『』“”"'()()【】\[\]-]/g, "").toLowerCase();

// 从模型输出里把 JSON 数组抠出来(模型可能包 ```json 围栏或多说两句)
export function extractJsonArray(raw) {
  const cleaned = String(raw).replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("模型没有返回 JSON 数组:" + cleaned.slice(0, 120));
  const arr = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error("模型返回的不是数组");
  return arr;
}

export function meetingDateLine(createdAt) {
  const d = new Date(createdAt);
  return `${localDate(d)}(周${"日一二三四五六"[d.getDay()]})`;
}

// ---------- 行动项提取 ----------
// known:这场会已经确认过的任务,重新提取时不要再出
export function buildExtractPrompt({ createdAt, names = [], glossary = "", transcript, known = [] }) {
  return [
    `会议日期:${meetingDateLine(createdAt)}。相对时间以此为基准换算。`,
    names.length ? `已知参会人:${names.join("、")}。` : "",
    glossary,
    known.length ? `这场会里已经确认记下的任务(不要重复输出):\n${known.map((t) => `- ${t}`).join("\n")}` : "",
    "",
    "<transcript>",
    transcript.slice(0, 60000),
    "</transcript>",
  ].join("\n");
}

// 模型返回的数组 → 新的待确认行动项。重新提取时,上一轮还没确认的建议整批换掉;已确认的保留并去重
export function mergeExtracted(existing, arr, nowIso) {
  const kept = existing.filter((a) => a.status !== "pending");
  const seen = new Set(kept.map((a) => normText(a.text)));
  const fresh = [];
  for (const x of arr) {
    const text = String(x?.text || "").trim();
    if (!text || seen.has(normText(text))) continue;
    seen.add(normText(text));
    const t = parseTimestamp(x?.time);
    fresh.push({
      id: newActionId(),
      text,
      owner: String(x?.owner || "").trim(),
      due: normalizeDue(x?.due),
      dueText: String(x?.due_text || "").trim() || undefined,
      status: "pending",
      source: t === null ? null : { t, quote: String(x?.quote || "").trim().slice(0, 80) },
      confidence: typeof x?.confidence === "number" ? Math.max(0, Math.min(1, x.confidence)) : undefined,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }
  return { fresh, items: kept.concat(fresh) };
}

export function patchAction(a, body, nowIso) {
  const next = { ...a };
  if (typeof body.text === "string" && body.text.trim()) next.text = body.text.trim();
  if (typeof body.owner === "string") next.owner = body.owner.trim();
  if ("due" in body) next.due = body.due ? normalizeDue(body.due) : null;
  if (typeof body.note === "string") next.note = body.note.trim() || undefined;
  if (typeof body.status === "string" && ACTION_STATUSES.includes(body.status)) {
    next.status = body.status;
    if (next.status === "done" && a.status !== "done") next.doneAt = nowIso;
    if (next.status !== "done") next.doneAt = undefined;
  }
  next.updatedAt = nowIso;
  return next;
}

// ---------- 旧任务对照 ----------
// open:之前会议里未完成的任务,带 meetingAt / meetingTitle
export function pickOpenForReview(all, meetingId) {
  return all
    .filter((a) => a.meetingId !== meetingId && (a.status === "todo" || a.status === "doing"))
    .sort((a, b) => b.meetingAt.localeCompare(a.meetingAt))
    .slice(0, 40);
}

export function buildReviewPrompt({ open, glossary = "", transcript }) {
  const md = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const listText = open.map((a) => `- id=${a.id} | ${a.owner || "待定"} | ${a.text}${a.due ? ` | 截止 ${a.due}` : ""} | 来自 ${md(a.meetingAt)}「${a.meetingTitle}」`).join("\n");
  return `${glossary}\n\n<open_tasks>\n${listText}\n</open_tasks>\n\n<transcript>\n${transcript.slice(0, 60000)}\n</transcript>`;
}

export function mergeReviews(existing, arr, open, nowIso) {
  const seen = new Set(existing.map((r) => r.actionId));
  const byId = new Map(open.map((a) => [a.id, a]));
  const fresh = [];
  for (const x of arr) {
    const a = byId.get(String(x?.id || ""));
    const st = String(x?.status || "");
    if (!a || seen.has(a.id) || !["done", "doing", "dropped"].includes(st)) continue;
    seen.add(a.id);
    fresh.push({ actionId: a.id, meetingId: a.meetingId, text: a.text, owner: a.owner, suggested: st, t: parseTimestamp(x?.time), quote: String(x?.quote || "").trim().slice(0, 80), confidence: typeof x?.confidence === "number" ? x.confidence : undefined, createdAt: nowIso });
  }
  return { fresh, reviews: existing.concat(fresh) };
}

export const reviewNote = (meetingTitle, quote) => `在「${meetingTitle}」里提到:${quote}`;

// ---------- 会前汇报 ----------
// meetings:按时间从新到旧;all:所有行动项,带 meetingId / meetingTitle;today:YYYY-MM-DD
export function briefingFrom(meetings, all, today) {
  const t = today;
  // 「上次会议」= 最近一场有已确认任务的会议;刚转写完、任务还全是待确认的那场单独提一句
  const withActions = meetings.filter((m) => all.some((a) => a.meetingId === m.id && a.status !== "pending"));
  const last = withActions[0] || null;
  const lastItems = last ? all.filter((a) => a.meetingId === last.id && a.status !== "pending") : [];
  const newest = meetings.find((m) => all.some((a) => a.meetingId === m.id));
  const pendingNewest = newest && newest.id !== last?.id ? all.filter((a) => a.meetingId === newest.id && a.status === "pending").length : 0;
  const count = (list, st) => list.filter((a) => a.status === st).length;
  const live = all.filter((a) => a.status === "todo" || a.status === "doing");
  const overdue = live.filter((a) => a.due && a.due < t);
  const dueSoon = live.filter((a) => a.due && a.due >= t && a.due <= shiftDate(t, 1));
  const lastDate = last ? fmtMD(localDate(new Date(last.createdAt))) : "";
  const lastOpen = lastItems.filter((a) => a.status === "todo" || a.status === "doing").length;
  const line = last
    ? `上次会议（${lastDate}）定了 ${lastItems.length} 件事：完成 ${count(lastItems, "done")}，未完成 ${lastOpen}${overdue.length ? `，逾期 ${overdue.length}` : ""}`
    : "还没有记录过行动项";
  const pendingNote = pendingNewest ? `；最近一场「${newest.title}」还有 ${pendingNewest} 条待确认` : "";
  const item = (a) => `- ${a.owner || "待定"}：${a.text}${a.due ? `（${fmtMD(a.due)}）` : ""}`;
  const lines = [`📊 会前汇报（${fmtMD(t)}）`, ""];
  if (pendingNewest) lines.push(`最近一场「${newest.title}」刚转写完，有 ${pendingNewest} 条行动项等你确认。`, "");
  if (last) {
    lines.push(`上次会议「${last.title}」（${lastDate}）定了 ${lastItems.length} 件事：完成 ${count(lastItems, "done")} · 进行中 ${count(lastItems, "doing")} · 待办 ${count(lastItems, "todo")}${count(lastItems, "dropped") ? ` · 搁置 ${count(lastItems, "dropped")}` : ""}`, "");
  }
  if (overdue.length) lines.push("⚠️ 已逾期", ...overdue.map(item), "");
  if (dueSoon.length) lines.push("🔜 今明两天到期", ...dueSoon.map(item), "");
  const rest = live.filter((a) => !overdue.includes(a) && !dueSoon.includes(a));
  if (rest.length) lines.push("📝 其他未完成", ...rest.slice(0, 15).map(item), rest.length > 15 ? `…还有 ${rest.length - 15} 条，看任务看板` : "", "");
  if (!live.length) lines.push("所有任务都完成了 🎉", "");
  lines.push("开会先对一遍这些，再聊新的。");
  return {
    lastMeeting: last ? { id: last.id, title: last.title, createdAt: last.createdAt } : null,
    counts: { last: lastItems.length, lastDone: count(lastItems, "done"), lastOpen, open: live.length, overdue: overdue.length, dueSoon: dueSoon.length },
    line: line + pendingNote,
    text: lines.join("\n").replace(/\n{3,}/g, "\n\n"),
  };
}

// ---------- 到期摘要(提醒用) ----------
export function dueDigestFrom(all, today) {
  const live = all.filter((a) => (a.status === "todo" || a.status === "doing") && a.due);
  return {
    date: today,
    overdue: live.filter((a) => a.due < today).sort((a, b) => a.due.localeCompare(b.due)),
    today: live.filter((a) => a.due === today),
    tomorrow: live.filter((a) => a.due === shiftDate(today, 1)),
  };
}

// ---------- 问资料库:任务清单 ----------
// refById:会议 id → M编号。只收资料库里有的会议
export function formatTasksBlock(tasks, refById, today) {
  const lines = tasks
    .filter((a) => refById.has(a.meetingId))
    .map((a) => {
      const ref = refById.get(a.meetingId);
      const src = a.source ? `[${ref} ${fmtTime(a.source.t)}]` : `[${ref}]`;
      const extra = [a.due ? `截止 ${a.due}` : "", a.doneAt ? `完成于 ${String(a.doneAt).slice(0, 10)}` : "", a.note ? `备注:${a.note}` : "", a.source?.quote ? `原话「${a.source.quote}」` : ""].filter(Boolean).join(" | ");
      return `- ${src} ${a.owner || "待定"}:${a.text} | 状态:${STATUS_CN[a.status] || a.status}${extra ? " | " + extra : ""}`;
    });
  return {
    lines,
    block: lines.length ? `<tasks>\n今天是 ${today}。任务清单(方括号里是定下它的会议编号和时间戳):\n${lines.join("\n")}\n</tasks>` : "",
    cited: new Set(lines.map((l) => l.match(/^- \[(M\d+)/)?.[1]).filter(Boolean)),
  };
}
