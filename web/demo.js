// 网页演示版:在浏览器里接管 /api/*。
// 示例数据从 /samples/seed.json 读,访客的改动(确认任务、改状态)只存在自己浏览器的 localStorage 里,互不影响。
// 需要 AI 的四个动作(问资料库、分析、提取行动项、对照旧任务)转给 /demo-api 云端函数,由它调用 MOI Genesis。
(() => {
  const TODAY = "2026-10-27"; // 演示时钟:第三场会议的第二天
  const START_ID = "20261026-100000";
  const KEY = "sanhui-demo-state";
  window.DEMO = { today: TODAY };
  const realFetch = window.fetch.bind(window);
  const coreP = import("/core.js");
  let state = null;

  const nowIso = () => { const n = new Date(); const [y, m, d] = TODAY.split("-").map(Number); n.setFullYear(y, m - 1, d); return n.toISOString(); };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const fail = (msg, status = 400) => json({ error: msg }, status);
  const sseError = (message) => new Response(`event: error\ndata: ${JSON.stringify({ message })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };
  const NOT_HERE = "演示版没有这个功能,它在 Mac 版里";

  const ready = (async () => {
    const seed = await realFetch("/samples/seed.json", { cache: "no-cache" }).then((r) => r.json());
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || "null"); } catch {}
    state = saved && saved.version === seed.version ? saved : structuredClone(seed);
    state.templates = seed.templates;
    state.settings ||= {};
    save();
  })();

  const meeting = (id) => {
    const m = state.meetings[id];
    if (!m) throw Object.assign(new Error("没有这条记录"), { status: 404 });
    return m;
  };
  const metas = () => Object.values(state.meetings).map((m) => m.meta).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const allActions = () => metas().flatMap((meta) => state.meetings[meta.id].actions.map((a) => ({ ...a, meetingId: meta.id, meetingTitle: meta.title, meetingAt: meta.createdAt })));
  const sizeOf = (m) => 900_000 + (m.transcript.length + JSON.stringify(m.results).length) * 3;

  const SETTINGS = {
    transcribeProvider: "local", localTranscribeAvailable: true, transcribeLanguage: "zh",
    summaryProvider: "openai", openaiBaseUrl: "https://token.moi.matrixorigin.cn/v1", openaiModel: "qwen3.8-flash", openaiApiKey: "", hasOpenaiKey: true,
    autoTranscribe: "1", autoAnalyze: "0", autoTitle: "1", autoExtractActions: "1", remindEnabled: "1", remindHour: "9", remindFrequency: "daily",
    discardShort: "1", autoImportVoiceMemos: "0", backupDir: "", backupScope: "text", myName: "",
  };

  async function callFn(name, body) {
    const r = await realFetch(`/demo-api/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `云端函数出错 HTTP ${r.status}`);
    return d;
  }

  // 把云端函数的流式回答原样交给页面,同时旁听 done 事件把结果存起来
  async function sseProxy(name, body, onEvent = () => {}) {
    let res;
    try {
      res = await realFetch(`/demo-api/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) { return sseError("连不上云端函数:" + e.message); }
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => "");
      let msg = t.slice(0, 200);
      try { msg = JSON.parse(t).error || msg; } catch {}
      return sseError(msg || `HTTP ${res.status}`);
    }
    const dec = new TextDecoder();
    let buf = "";
    const tap = new TransformStream({
      transform(chunk, ctl) {
        ctl.enqueue(chunk);
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(raw)?.[1];
          const data = /^data: (.*)$/m.exec(raw)?.[1];
          if (ev && data != null) { try { onEvent(ev, JSON.parse(data)); } catch {} }
        }
      },
    });
    return new Response(res.body.pipeThrough(tap), { headers: { "Content-Type": "text/event-stream" } });
  }

  function search(q) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const match = (line) => { const l = line.toLowerCase(); return terms.every((t) => l.includes(t)); };
    const snippet = (line) => { const at = Math.max(0, line.toLowerCase().indexOf(terms[0])); const from = Math.max(0, at - 40); return (from > 0 ? "…" : "") + line.slice(from, at + 80).trim() + (at + 80 < line.length ? "…" : ""); };
    const out = [];
    for (const meta of metas()) {
      const m = state.meetings[meta.id];
      const hits = [];
      if (match(meta.title)) hits.push({ where: "标题", tab: "", text: meta.title });
      for (const line of m.transcript.split("\n")) {
        if (!match(line)) continue;
        const ts = /^\[(\d+):(\d{2})\]/.exec(line);
        hits.push({ where: "转写原文", tab: "transcript", text: snippet(line.replace(/^\[\d+:\d{2}\]\s*/, "")), t: ts ? Number(ts[1]) * 60 + Number(ts[2]) : undefined });
      }
      for (const [tid, text] of Object.entries(m.results)) {
        const name = state.templates.find((t) => t.id === tid)?.name || tid;
        for (const line of text.split("\n")) if (match(line)) hits.push({ where: name, tab: tid, text: snippet(line.replace(/^[#>*\-\s|]+/, "").replace(/\*\*/g, "")) });
      }
      if (hits.length) out.push({ id: meta.id, title: meta.title, createdAt: meta.createdAt, count: hits.length, hits: hits.slice(0, 6) });
    }
    return out.sort((a, b) => b.count - a.count);
  }

  function download(name, content) {
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function route(url, method, body) {
    await ready;
    const core = await coreP;
    const [, p1, p2, p3, p4] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (p1 === "ping") return json({ ok: true, appMode: false });
    if (p1 === "settings") {
      if (method === "POST") {
        for (const k of ["remindEnabled", "remindHour", "remindFrequency", "autoExtractActions", "myName"]) if (k in (body || {})) state.settings[k] = body[k];
        save();
      }
      return json({ ...SETTINGS, ...state.settings });
    }
    if (p1 === "claude-status") return json({ found: "", loggedIn: true, message: "演示版的模型走 MOI Genesis(qwen3.8-flash)" });
    if (p1 === "record") return p2 === "status" ? json({ active: false, state: "idle" }) : p2 === "sources" ? json({ displays: [], windows: [] }) : fail("演示版不能录制。录制、转写在 Mac 版里完成,这里放的是三场已转写的示例会议。");
    if (p1 === "briefing") return json(core.briefingFrom(metas(), allActions(), TODAY));
    if (p1 === "reminders") {
      if (method !== "GET") return json({ sent: false });
      const cfg = { ...SETTINGS, ...state.settings }, q = url.searchParams;
      const plan = core.remindPlanText(new Date(), { hour: q.get("hour") || cfg.remindHour, frequency: q.get("frequency") || cfg.remindFrequency });
      return json({ ...core.dueDigestFrom(allActions(), TODAY), plan });
    }
    if (p1 === "actions") return json(allActions());
    if (p1 === "templates") return method === "GET" ? json({ templates: state.templates, defaults: state.templates }) : fail("演示版不能改模板");
    if (p1 === "glossary") return method === "GET" ? json([]) : fail(NOT_HERE);
    if (p1 === "trash") return method === "GET" ? json([]) : fail(NOT_HERE);
    if (p1 === "search") return json(search(url.searchParams.get("q") || ""));
    if (p1 === "export") {
      if (!body?.content) return fail("演示版只能导出 Markdown");
      download(body.name || "导出.md", body.content);
      return json({ ok: true, path: body.name || "导出.md" });
    }
    if (p1 === "ask") {
      const tasks = allActions().map(({ id, meetingId, text, owner, status, due, doneAt, note, source }) => ({ id, meetingId, text, owner, status, due, doneAt, note, source }));
      return sseProxy("ask", { question: body?.question, history: body?.history || [], tasks });
    }

    if (p1 === "meetings") {
      if (!p2) {
        if (method === "GET") return json(metas().map((meta) => ({ ...meta, size: sizeOf(state.meetings[meta.id]) })));
        return fail("演示版不支持上传,只放了三场示例会议");
      }
      const m = meeting(p2);
      if (!p3) {
        if (method === "GET") return json({ ...m.meta, size: sizeOf(m), mediaSize: 900_000, videoSize: 0, transcript: m.transcript, results: m.results });
        if (method === "PATCH") {
          if (typeof body?.title === "string" && body.title.trim()) m.meta.title = body.title.trim();
          if (body?.speakerNames) m.meta.speakerNames = { ...m.meta.speakerNames, ...body.speakerNames };
          save();
          return json(m.meta);
        }
        return fail("示例会议不能删除。想回到最初的样子,点顶部的「重置演示」。");
      }
      if (p3 === "transcript" && method === "PUT") { m.transcript = String(body?.transcript || ""); save(); return json({ ok: true }); }
      if (p3 === "title") return json({ title: m.meta.title });
      if (p3 === "analyze") {
        return sseProxy("analyze", { meetingId: p2, templateIds: body?.templateIds || [] }, (ev, d) => {
          if (ev === "done" && d.templateId) { m.results[d.templateId] = d.text; m.meta.status = "done"; save(); }
        });
      }
      if (p3 === "actions") {
        if (!p4 && method === "GET") return json(m.actions);
        if (!p4 && method === "POST") {
          if (body?.extract) {
            const known = m.actions.filter((a) => a.status !== "pending").map((a) => a.text);
            const { arr } = await callFn("extract", { meetingId: p2, known });
            const { fresh, items } = core.mergeExtracted(m.actions, arr, nowIso());
            m.actions = items; save();
            return json({ added: fresh.length, items });
          }
          if (body?.confirm) {
            const ids = Array.isArray(body.ids) ? body.ids : null;
            m.actions = m.actions.map((a) => (a.status === "pending" && (!ids || ids.includes(a.id)) ? { ...a, status: "todo", updatedAt: nowIso() } : a));
            save();
            return json(m.actions);
          }
          const text = String(body?.text || "").trim();
          if (!text) return fail("缺少任务内容");
          const item = { id: core.newActionId(), text, owner: String(body.owner || "").trim(), due: core.normalizeDue(body.due), status: "todo", source: null, createdAt: nowIso(), updatedAt: nowIso() };
          m.actions.push(item); save();
          return json(item);
        }
        const i = m.actions.findIndex((a) => a.id === p4);
        if (i < 0) return fail("没有这条行动项", 404);
        if (method === "PATCH") { m.actions[i] = core.patchAction(m.actions[i], body || {}, nowIso()); save(); return json(m.actions[i]); }
        if (method === "DELETE") { m.actions.splice(i, 1); save(); return json({ ok: true }); }
      }
      if (p3 === "reviews") {
        if (!p4 && method === "GET") return json(m.reviews);
        if (!p4 && method === "POST") {
          const open = core.pickOpenForReview(allActions(), p2);
          if (!open.length) return json({ added: 0, reviews: m.reviews });
          const slim = open.map(({ id, meetingId, text, owner, due, meetingAt, meetingTitle }) => ({ id, meetingId, text, owner, due, meetingAt, meetingTitle }));
          const { arr } = await callFn("review", { meetingId: p2, open: slim });
          const { fresh, reviews } = core.mergeReviews(m.reviews, arr, open, nowIso());
          m.reviews = reviews; save();
          return json({ added: fresh.length, reviews });
        }
        if (p4 && method === "POST") {
          const r = m.reviews.find((x) => x.actionId === p4);
          if (!r) return fail("没有这条候选", 404);
          if (body?.accept) {
            const target = state.meetings[r.meetingId];
            const i = target ? target.actions.findIndex((a) => a.id === p4) : -1;
            if (i >= 0) target.actions[i] = core.patchAction(target.actions[i], { status: r.suggested, note: core.reviewNote(m.meta.title, r.quote) }, nowIso());
          }
          r.resolved = body?.accept ? "accepted" : "ignored";
          save();
          return json(m.reviews);
        }
      }
      return fail(NOT_HERE);
    }
    return fail(NOT_HERE, 404);
  }

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return realFetch(input, init);
    try {
      let body = null;
      if (typeof init.body === "string") { try { body = JSON.parse(init.body); } catch {} }
      return await route(url, (init.method || "GET").toUpperCase(), body);
    } catch (e) {
      return fail(e.message || String(e), e.status || 500);
    }
  };

  // ---------- 演示版的说明条、引导、重置 ----------
  document.addEventListener("DOMContentLoaded", () => {
    const banner = document.createElement("div");
    banner.className = "demo-banner";
    banner.innerHTML = `
      <div class="demo-banner-text">
        <b>网页演示版</b>：放了同一个项目连着开的三场示例会议，时间设定在 2026 年 10 月 27 日。你做的改动只存在自己的浏览器里。录音和转写在 Mac 版里完成。
      </div>
      <ol class="demo-steps">
        <li>打开的是第三场会议的「行动项」：蓝框是 AI 发现的旧任务进展，点「标记完成」；黄框是这场新提取的任务，点「确认」。</li>
        <li>点顶部「任务看板」，看所有会议的任务、谁逾期了。</li>
        <li>点「问资料库」，问一句「小林手上还有什么没做完？」</li>
        <li>点「复制会前汇报」，看下次开会前发到群里的汇报。</li>
      </ol>
      <div class="demo-banner-ops"><button type="button" class="ghost small" id="demoReset">重置演示</button></div>`;
    document.querySelector(".topbar").after(banner);
    banner.querySelector("#demoReset").onclick = () => { try { localStorage.removeItem(KEY); } catch {} location.reload(); };

    const askHint = document.querySelector("#askDlg .hint");
    if (askHint) askHint.textContent = "问题交给 MOI 上的智能体「散会即开工助手」：它绑定了这三场会议的知识库，先检索再回答，通常要半分钟到 1 分钟。回答里的出处可以点，直接跳到那场会议的那一句。";
    const rec = document.querySelector(".card.recorder");
    if (rec) {
      const intro = document.createElement("div");
      intro.className = "demo-intro";
      intro.innerHTML = `<b>Mac 版在这里录会</b><br />会议软件一开麦就提醒你录，录音分成你和对方两条声音，在本机离线转成文字，录音不出电脑。散会后自动提取行动项。`;
      rec.prepend(intro);
    }
  });

  // 页面脚本加载完后,直接打开第三场会议的「行动项」
  window.addEventListener("load", () => {
    setTimeout(() => {
      try {
        activeTab = "actions"; // app.js 的全局变量
        openMeeting(START_ID, true);
      } catch (e) { console.error(e); }
    }, 300);
  });
})();
