// 前端逻辑:录音、上传、列表、转写、纪要(SSE)、设置
const $ = (s) => document.querySelector(s);

// ---------- 极简 Markdown 渲染(够用:标题/列表/表格/粗体/引用/代码) ----------
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[(\d{1,3}):(\d{2})\]/g, (m, mi, se) => `<a href="#" class="ts" data-t="${Number(mi) * 60 + Number(se)}">${m}</a>`);
}
function renderMarkdown(md) {
  const lines = md.replace(/\r/g, "").split("\n");
  let html = "", i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)/))) {
      const lv = Math.min(m[1].length + 1, 6); // # 当 h2 显示
      html += `<h${lv}>${inline(m[2])}</h${lv}>`; i++; continue;
    }
    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      html += "<table><thead><tr>" + cells(line).map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>";
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        html += "<tr>" + cells(lines[i]).map((c) => `<td>${c}</td>`).join("") + "</tr>"; i++;
      }
      html += "</tbody></table>"; continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      html += "<ul>";
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { html += `<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`; i++; }
      html += "</ul>"; continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      html += "<ol>";
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { html += `<li>${inline(lines[i].replace(/^\s*\d+[.)]\s+/, ""))}</li>`; i++; }
      html += "</ol>"; continue;
    }
    if (/^\s*>\s?/.test(line)) {
      let q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      html += `<blockquote>${inline(q.join(" "))}</blockquote>`; continue;
    }
    if (/^```/.test(line)) {
      let code = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++; html += `<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`; continue;
    }
    let p = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|\s*[-*]\s|\s*\d+[.)]\s|\s*>|```|\s*\|)/.test(lines[i])) { p.push(lines[i]); i++; }
    html += `<p>${inline(p.join(" "))}</p>`;
  }
  return html;
}

// ---------- 工具 ----------
const fmtTime = (sec) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
const fmtDate = (iso) => new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const STATUS_TEXT = { queued: "排队中", recording: "录制中…", recorded: "已录制", transcribing: "转写中…", transcribed: "已转写", summarizing: "分析中…", done: "已完成", error: "出错" };
async function api(url, opts) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// ---------- 提示 / 确认 / 复制 / 存文件 ----------
// 浏览器面板会直接屏蔽 alert / confirm,所以用页面里的对话框
function uiDialog(msg, { title = "", ok = "好", cancel = null, danger = false } = {}) {
  const dlg = $("#uiDlg");
  $("#uiTitle").textContent = title;
  $("#uiTitle").hidden = !title;
  $("#uiMsg").textContent = msg;
  $("#uiOk").textContent = ok;
  $("#uiOk").className = danger ? "danger-solid" : "primary";
  $("#uiCancel").hidden = !cancel;
  if (cancel) $("#uiCancel").textContent = cancel;
  // 直接响应按钮点击,不依赖 close 事件(某些窗口里页面在后台时 close 事件会延迟)
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; if (dlg.open) dlg.close(); resolve(v); };
    $("#uiOk").onclick = (e) => { e.preventDefault(); finish(true); };
    $("#uiCancel").onclick = (e) => { e.preventDefault(); finish(false); };
    dlg.oncancel = (e) => { e.preventDefault(); finish(false); }; // Esc
    dlg.showModal();
    (cancel ? $("#uiCancel") : $("#uiOk")).focus();
  });
}
const uiAlert = (msg, title = "") => uiDialog(String(msg), { title });
const uiConfirm = (msg, opts = {}) => uiDialog(msg, { cancel: "取消", ...opts });

let toastTimer = null;
function toast(msg) {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  // 剪贴板接口被拦时的老办法
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  ta.remove();
  return ok;
}

// 文件由本地服务直接存进「下载」文件夹,并在访达里选中
async function saveFile(name, payload) {
  try {
    const r = await api("/api/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, ...payload }) });
    toast(`已存到「下载」:${r.path.split("/").pop()}`);
  } catch (e) { uiAlert(e.message, "导出失败"); }
}

const fmtSize = (b) => (b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB");

// ---------- 录制(原生录制助手) ----------
let recPoll = null, recActive = false;

function selectedMode() { return document.querySelector('input[name="mode"]:checked').value; }

function updateModeUI() {
  const mode = selectedMode();
  $("#sourceField").hidden = mode === "audio";
  $("#micField").hidden = mode === "screen";
}
document.querySelectorAll('input[name="mode"]').forEach((r) => (r.onchange = updateModeUI));

async function loadSources() {
  const sel = $("#source");
  const keep = sel.value;
  const btn = $("#btnSources");
  btn.disabled = true; btn.textContent = "读取中…";
  try {
    const data = await api("/api/record/sources");
    sel.innerHTML = "";
    const g1 = document.createElement("optgroup"); g1.label = "整个屏幕";
    for (const d of data.displays || []) {
      const main = d.id === data.mainDisplay;
      g1.appendChild(new Option(`${d.name}${main ? "(主显示器)" : ""} ${d.width}×${d.height}`, `display:${d.id}`, main, main));
    }
    sel.appendChild(g1);
    if (data.windows?.length) {
      const g2 = document.createElement("optgroup"); g2.label = "单个窗口(只收录该应用的声音)";
      for (const w of data.windows) g2.appendChild(new Option(`${w.app}${w.title ? " — " + w.title : ""}`.slice(0, 80), `window:${w.id}`));
      sel.appendChild(g2);
    }
    if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
  } catch (e) {
    $("#recHint").textContent = "⚠️ " + e.message;
  } finally {
    btn.disabled = false; btn.textContent = "刷新";
  }
}
$("#btnSources").onclick = loadSources;

async function startRecording() {
  const mode = selectedMode();
  const [kind, id] = ($("#source").value || "").split(":");
  const body = { title: $("#title").value.trim(), guest: $("#guest").value.trim(), mode, mic: $("#withMic").checked };
  if (kind === "window") body.windowId = id;
  if (kind === "display") body.displayId = id;
  const meta = await api("/api/record/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  $("#title").value = ""; $("#guest").value = "";
  $("#liveTitle").textContent = meta.title;
  $("#recHint").textContent = "启动中…第一次使用时,系统会询问屏幕录制和麦克风权限,请点允许。";
  setRecUI({ active: true, state: "starting", elapsed: 0, markers: [] });
  watchRecording();
}

const LIVE_TEXT = { starting: "启动中", recording: "录制中", paused: "已暂停", processing: "正在保存…" };
function setRecUI(st) {
  recActive = !!st.active;
  $("#recSetup").hidden = recActive;
  $("#recLive").hidden = !recActive;
  $("#btnPause").hidden = $("#btnMark").hidden = !recActive || st.state === "processing";
  const btn = $("#btnRec");
  btn.textContent = recActive ? "■ 停止" : "● 开始录制";
  btn.classList.toggle("recording", recActive);
  btn.disabled = st.state === "processing" || st.state === "starting";
  $("#btnPause").textContent = st.state === "paused" ? "继续" : "暂停";
  $("#timer").textContent = fmtTime(st.elapsed || 0);
  if (!recActive) return;
  $("#liveState").textContent = LIVE_TEXT[st.state] || st.state;
  $("#liveDot").className = "dot " + (st.state || "");
  $("#liveMarkers").innerHTML = (st.markers || []).length
    ? "打点:" + st.markers.map((m) => `<span class="chip">${fmtTime(m)}</span>`).join("")
    : "";
  if (st.warnings?.length) $("#recHint").textContent = "⚠️ " + st.warnings.join(" ");
  else if (st.state === "recording" || st.state === "paused") $("#recHint").textContent = "菜单栏有计时,可以关掉这个窗口。快捷键:⌃⌥⌘P 暂停 / ⌃⌥⌘M 打点 / ⌃⌥⌘S 停止。";
  else if (st.state === "processing") $("#recHint").textContent = "正在合成文件,稍后自动开始转写…";
}

function watchRecording() {
  clearInterval(recPoll);
  let lastId = null;
  const tick = async () => {
    const st = await api("/api/record/status").catch(() => null);
    if (!st) return;
    if (st.active) { lastId = st.id; setRecUI(st); return; }
    clearInterval(recPoll); recPoll = null;
    setRecUI({ active: false });
    window.onbeforeunload = null;
    if (st.error) $("#recHint").textContent = "⚠️ " + st.error;
    else if (st.notice) { $("#recHint").textContent = st.notice; toast(st.notice); lastId = null; }
    else $("#recHint").textContent = "已保存,正在自动转写。";
    await loadList();
    if (lastId) await openMeeting(lastId).catch(() => {});
  };
  tick();
  recPoll = setInterval(tick, 1000);
}

$("#btnRec").onclick = async () => {
  try {
    if (recActive) await api("/api/record/stop", { method: "POST" });
    else await startRecording();
  } catch (e) { uiAlert((recActive ? "停止失败:" : "无法开始录制:") + e.message); }
};
$("#btnPause").onclick = () => api("/api/record/pause", { method: "POST" }).catch((e) => uiAlert(e.message));
$("#btnMark").onclick = () => api("/api/record/mark", { method: "POST" }).catch((e) => uiAlert(e.message));

async function uploadAudio(file, durationSec) {
  const form = new FormData();
  form.append("audio", file);
  form.append("title", $("#title").value.trim() || file.name.replace(/\.[^.]+$/, "") || "");
  if (durationSec) form.append("durationSec", String(durationSec));
  try {
    const meta = await api("/api/meetings", { method: "POST", body: form });
    $("#title").value = "";
    await loadList();
    await openMeeting(meta.id);
  } catch (e) {
    uiAlert("上传失败:" + e.message);
  }
}

$("#fileInput").onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  for (let i = 0; i < files.length; i++) {
    $("#recHint").textContent = `正在上传 ${i + 1}/${files.length}…`;
    await uploadAudio(files[i], 0);
  }
  if (files.length) $("#recHint").textContent = files.length > 1 ? `已导入 ${files.length} 个文件,正在排队转写。` : "已导入,正在排队转写。";
};

// ---------- 列表 ----------
let currentId = null;
const JOB_TEXT = { transcribe: "转写", analyze: "分析" };
function statusText(m) {
  if (m.job?.state === "queued") return `排队等${JOB_TEXT[m.job.kind]}`;
  if (m.job?.state === "running") return `${JOB_TEXT[m.job.kind]}中…`;
  return STATUS_TEXT[m.status] || m.status;
}
let meetings = [], listPoll = null;
async function loadList() {
  loadBriefing();
  meetings = await api("/api/meetings");
  const ul = $("#list");
  ul.innerHTML = "";
  if (!meetings.length) ul.innerHTML = `<li class="empty small">还没有记录</li>`;
  ul.classList.toggle("selecting", selecting);
  for (const m of meetings) {
    const li = document.createElement("li");
    li.className = (m.id === currentId ? "active" : "") + (selected.has(m.id) ? " picked" : "");
    const src = m.source?.type === "voicememo" ? "🎙️ " : m.hasVideo ? "🎬 " : "";
    const box = selecting ? `<input type="checkbox" class="pick" ${selected.has(m.id) ? "checked" : ""} />` : "";
    li.innerHTML = `${box}<div class="li-main"><div class="t">${src}${escapeHtml(m.title)}</div><div class="s">${fmtDate(m.createdAt)} · ${fmtTime(m.durationSec)} · ${statusText(m)}${m.size ? " · " + fmtSize(m.size) : ""}</div></div>`;
    li.onclick = () => {
      if (!selecting) return openMeeting(m.id);
      if (selected.has(m.id)) selected.delete(m.id); else selected.add(m.id);
      li.classList.toggle("picked", selected.has(m.id));
      li.querySelector(".pick").checked = selected.has(m.id);
      updateSelectBar();
    };
    ul.appendChild(li);
  }
  const total = meetings.reduce((n, m) => n + (m.size || 0), 0);
  $("#listStats").textContent = meetings.length ? `共 ${meetings.length} 条 · ${fmtSize(total)}` : "";
  updateSelectBar();
  // 后台有任务就每 3 秒刷新一次列表
  clearTimeout(listPoll);
  if (meetings.some((m) => m.job || ["transcribing", "summarizing"].includes(m.status))) listPoll = setTimeout(() => loadList().catch(() => {}), 3000);
}
$("#btnRefresh").onclick = loadList;

// ---------- 多选删除 ----------
let selecting = false;
const selected = new Set();
function updateSelectBar() {
  $("#selectBar").hidden = !selecting;
  $("#btnSelect").textContent = selecting ? "完成" : "多选";
  $("#selCount").textContent = `已选 ${selected.size} 条`;
  $("#btnSelDelete").disabled = !selected.size;
  $("#selAll").checked = meetings.length > 0 && selected.size === meetings.length;
}
function setSelecting(on) {
  selecting = on;
  selected.clear();
  if (on && $("#search").value) { $("#search").value = ""; runSearch(); }
  loadList();
}
$("#btnSelect").onclick = () => setSelecting(!selecting);
$("#btnSelCancel").onclick = () => setSelecting(false);
$("#selAll").onchange = (e) => {
  selected.clear();
  if (e.target.checked) meetings.forEach((m) => selected.add(m.id));
  loadList();
};
$("#btnSelDelete").onclick = async () => {
  const ids = [...selected];
  if (!ids.length) return;
  if (!(await uiConfirm(`选中的 ${ids.length} 条会移到「最近删除」,30 天内可以恢复。`, { title: `删除 ${ids.length} 条记录?`, ok: "删除", danger: true }))) return;
  const r = await api("/api/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
  if (ids.includes(currentId)) { current = null; currentId = null; $("#detailBody").hidden = true; $("#emptyDetail").hidden = false; }
  if (r.errors.length) uiAlert(r.errors.join("\n"), `删除了 ${r.done} 条,有 ${r.errors.length} 条没删`);
  else toast(`已删除 ${r.done} 条,可以在「最近删除」里恢复`);
  setSelecting(false);
};

// ---------- 最近删除 ----------
const trashDlg = $("#trashDlg");
async function loadTrash() {
  const items = await api("/api/trash");
  $("#btnTrashEmpty").disabled = !items.length;
  $("#trashList").innerHTML = items.length ? items.map((m) => {
    const left = Math.max(0, 30 - Math.floor((Date.now() - Date.parse(m.deletedAt)) / 86400000));
    return `<li><div class="trash-row">
      <span class="pick-main"><span class="t">${escapeHtml(m.title)}</span>
      <span class="s">${fmtDate(m.createdAt)} · ${fmtTime(m.durationSec)} · ${fmtSize(m.size)} · ${left} 天后彻底删除</span></span>
      <button class="ghost small" data-restore="${m.id}">恢复</button>
      <button class="ghost small danger" data-purge="${m.id}">彻底删除</button></div></li>`;
  }).join("") : `<li class="empty small">没有删除的记录</li>`;
}
$("#btnTrash").onclick = async () => { trashDlg.showModal(); await loadTrash(); };
$("#btnCloseTrash").onclick = () => trashDlg.close();
$("#trashList").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    if (b.dataset.restore) {
      const meta = await api(`/api/trash/${b.dataset.restore}/restore`, { method: "POST" });
      toast(`已恢复「${meta.title}」`);
    } else if (b.dataset.purge) {
      if (!(await uiConfirm("彻底删除后无法恢复。", { title: "彻底删除这条记录?", ok: "彻底删除", danger: true }))) return;
      await api(`/api/trash/${b.dataset.purge}`, { method: "DELETE" });
    }
  } catch (err) { uiAlert(err.message, "操作失败"); }
  await loadTrash();
  loadList();
});
$("#btnTrashEmpty").onclick = async () => {
  if (!(await uiConfirm("「最近删除」里的所有记录都会彻底删除,无法恢复。", { title: "全部彻底删除?", ok: "全部彻底删除", danger: true }))) return;
  await api("/api/trash", { method: "DELETE" });
  await loadTrash();
};

// ---------- 详情 ----------
let current = null, detailPoll = null, summarizingNow = false;
const player = () => (current?.hasVideo ? $("#dVideo") : $("#dAudio"));
function seek(sec) {
  const p = player();
  if (!p.src) return;
  const go = () => { p.currentTime = Math.max(0, sec - 1); p.play().catch(() => {}); };
  // 刚换了文件、还没加载时直接设时间会被忽略,等元数据加载完再跳
  if (p.readyState >= 1) go();
  else { p.addEventListener("loadedmetadata", go, { once: true }); p.load(); }
}
$("#dMarkers").onclick = (e) => { const t = e.target.dataset?.t; if (t) seek(Number(t)); };
// ---------- 逐字稿阅读模式 ----------
// 说话人分颜色;点一句从那里播放;播放时当前这句高亮并跟着滚动
let trLines = [], trPlaying = -1, trUserScrollAt = 0;
function parseTranscript(text, withSpeaker) {
  return text.split("\n").map((line) => {
    const m = /^\[(\d+):(\d{2})\]\s*(.*)$/.exec(line);
    if (!m) return line.trim() ? { t: null, who: "", text: line.trim() } : null;
    let body = m[3], who = "";
    const sp = withSpeaker ? /^([^:：\s]{1,20})[:：](.*)$/.exec(body) : null;
    if (sp) { who = sp[1]; body = sp[2]; }
    return { t: Number(m[1]) * 60 + Number(m[2]), who, text: body.trim() };
  }).filter(Boolean);
}
function speakerClass(who) {
  if (!who) return "";
  const me = current?.speakerNames?.mic || "我", guest = current?.speakerNames?.system || "嘉宾";
  if (who === me) return "sp-me";
  if (who === guest) return "sp-guest";
  let h = 0;
  for (const ch of who) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return "sp-" + (h % 4);
}
function renderTranscriptRead() {
  const box = $("#trRead");
  const hasTracks = !!(current?.tracks?.mic || current?.tracks?.system || current?.speakerNames);
  trLines = parseTranscript(current?.transcript || "", hasTracks);
  trPlaying = -1;
  if (!trLines.length) { box.innerHTML = `<div class="empty small">还没有转写。点上面的「转写文字」。</div>`; return; }
  const markers = current?.markers || [];
  box.innerHTML = trLines.map((l, i) => {
    const next = trLines.slice(i + 1).find((x) => x.t != null)?.t ?? Infinity;
    const pin = l.t != null && markers.some((mk) => mk >= l.t && mk < next) ? `<span class="tr-pin" title="录制时打的点">📍</span>` : "";
    return `<div class="tr-line${l.t == null ? " no-time" : ""}" data-i="${i}">` +
      `<span class="tr-time">${l.t != null ? fmtTime(l.t) : ""}</span>` +
      `<span class="tr-body">${l.who ? `<span class="tr-who ${speakerClass(l.who)}">${escapeHtml(l.who)}</span>` : ""}${pin}${escapeHtml(l.text)}</span></div>`;
  }).join("");
}
$("#trRead").addEventListener("click", (e) => {
  const row = e.target.closest(".tr-line");
  if (!row || window.getSelection()?.toString()) return; // 在选文字时不跳
  const l = trLines[Number(row.dataset.i)];
  if (l?.t != null) seek(l.t);
});
["wheel", "touchmove"].forEach((ev) => $("#trRead").addEventListener(ev, () => (trUserScrollAt = Date.now()), { passive: true }));
function onPlayerTime(e) {
  if (!trLines.length || e.target !== player()) return;
  const now = e.target.currentTime + 0.3;
  let idx = -1;
  for (let i = 0; i < trLines.length; i++) { if (trLines[i].t != null && trLines[i].t <= now) idx = i; else if (trLines[i].t != null) break; }
  if (idx === trPlaying) return;
  $("#trRead .tr-line.playing")?.classList.remove("playing");
  trPlaying = idx;
  const row = idx >= 0 ? $(`#trRead .tr-line[data-i="${idx}"]`) : null;
  if (!row) return;
  row.classList.add("playing");
  // 用户刚手动滚过就先不抢滚动
  if ($("#trFollow").checked && !$("#paneTranscript").hidden && !$("#trRead").hidden && Date.now() - trUserScrollAt > 4000) {
    const box = $("#trRead");
    box.scrollTo({ top: row.offsetTop - box.clientHeight / 2 + row.clientHeight / 2, behavior: "smooth" });
  }
}
$("#dVideo").addEventListener("timeupdate", onPlayerTime);
$("#dAudio").addEventListener("timeupdate", onPlayerTime);

function setTrMode(mode) {
  document.querySelectorAll("#trMode button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("#trRead").hidden = mode !== "read";
  $("#trEdit").hidden = mode !== "edit";
  $("#trFollowWrap").hidden = mode !== "read";
  $("#transcriptHint").textContent = mode === "read" ? "点任意一句,从那里开始播放。" : "改完点「保存修改」。按住 ⌘ 点某一行也能跳到那句。";
  try { localStorage.setItem("trMode", mode); } catch {}
}
$("#trMode").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setTrMode(b.dataset.mode); });
setTrMode((() => { try { return localStorage.getItem("trMode") || "read"; } catch { return "read"; } })());

// ⌘ + 点击转写里的某一行,跳到这句话
$("#transcriptEdit").addEventListener("click", (e) => {
  if (!e.metaKey) return;
  const ta = e.target;
  const lineStart = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
  const m = /^\[(\d+):(\d{2})\]/.exec(ta.value.slice(lineStart, lineStart + 12));
  if (m) seek(Number(m[1]) * 60 + Number(m[2]));
});
function setStatus(status) {
  const el = $("#dStatus");
  el.textContent = STATUS_TEXT[status] || status;
  el.className = "badge " + (status === "done" ? "done" : status === "error" ? "error" : /ing$/.test(status) ? "busy" : "");
}
function showError(msg) {
  const el = $("#dError");
  el.hidden = !msg; el.textContent = msg || "";
}
// ---------- 模板与结果 ----------
let templates = [];
let activeTab = null;      // 模板 id 或 "transcript"
let streaming = {};        // 正在生成的结果 { 模板id: 文本 }
let mm = null, mmTimer = null;

const tplName = (id) => templates.find((t) => t.id === id)?.name || id;
const tplFormat = (id) => templates.find((t) => t.id === id)?.format || "markdown";

function loadSelected() {
  try {
    const saved = JSON.parse(localStorage.getItem("tplSelected") || "null");
    if (Array.isArray(saved)) return new Set(saved);
  } catch {}
  return new Set(templates.filter((t) => t.defaultOn).map((t) => t.id));
}
function saveSelected(set) { try { localStorage.setItem("tplSelected", JSON.stringify([...set])); } catch {} }

async function loadTemplates() {
  templates = (await api("/api/templates")).templates;
  renderPicker();
}

function renderPicker() {
  const sel = loadSelected();
  const results = current?.results || {};
  $("#tplPicker").innerHTML = templates.map((t) =>
    `<label class="tpl-chip${results[t.id] ? " has" : ""}" title="${results[t.id] ? "已有结果,再次分析会覆盖" : ""}">` +
    `<input type="checkbox" value="${escapeHtml(t.id)}"${sel.has(t.id) ? " checked" : ""} /><span>${escapeHtml(t.name)}</span></label>`
  ).join("");
}
$("#tplPicker").addEventListener("change", () => {
  saveSelected(new Set([...document.querySelectorAll("#tplPicker input:checked")].map((i) => i.value)));
});

function resultIds() {
  const all = { ...(current?.results || {}), ...streaming };
  const ordered = templates.map((t) => t.id).filter((id) => id in all);
  return ordered.concat(Object.keys(all).filter((id) => !ordered.includes(id)));
}

function renderTabs() {
  const ids = resultIds();
  if (!activeTab || (activeTab !== "transcript" && activeTab !== "actions" && !ids.includes(activeTab))) activeTab = ids[0] || "transcript";
  const pending = actions.filter((a) => a.status === "pending").length;
  const open = actions.filter((a) => a.status === "todo" || a.status === "doing").length;
  const actLabel = `行动项${pending ? ` <span class="tab-badge warn">${pending} 待确认</span>` : open ? ` <span class="tab-badge">${open}</span>` : ""}`;
  $("#tabs").innerHTML = ids.map((id) =>
    `<button class="tab${id === activeTab ? " active" : ""}${id in streaming ? " live" : ""}" data-tab="${escapeHtml(id)}">${escapeHtml(tplName(id))}</button>`
  ).join("") + (current?.transcript ? `<button class="tab${activeTab === "actions" ? " active" : ""}" data-tab="actions">${actLabel}</button>` : "")
    + `<button class="tab${activeTab === "transcript" ? " active" : ""}" data-tab="transcript">转写原文</button>`;
}
$("#tabs").addEventListener("click", (e) => {
  const t = e.target.closest(".tab");
  if (t) switchTab(t.dataset.tab);
});

function switchTab(name) {
  activeTab = name;
  renderTabs();
  renderPane();
}

function renderPane() {
  const isTranscript = activeTab === "transcript";
  const isActions = activeTab === "actions";
  $("#paneTranscript").hidden = !isTranscript;
  $("#paneActions").hidden = !isActions;
  $("#paneResult").hidden = isTranscript || isActions;
  if (isTranscript) return;
  if (isActions) { renderActions(); return; }
  const live = activeTab in streaming;
  const text = live ? streaming[activeTab] : current?.results?.[activeTab] || "";
  const isMap = tplFormat(activeTab) === "mindmap";
  $("#resultEmpty").hidden = !!text || live;
  $("#mindmapWrap").hidden = $("#mindmapTools").hidden = !isMap || !text;
  const view = $("#resultView");
  view.hidden = isMap && !!text;
  if (isMap && text) {
    clearTimeout(mmTimer);
    mmTimer = setTimeout(() => renderMindmap(text), live ? 400 : 0); // 流式时节流
  } else {
    view.innerHTML = text ? renderMarkdown(text) : "";
  }
  view.classList.toggle("cursor", live);
}

// 导图渲染排队执行,同样的内容不重复画(连续两次 setData 重叠会量出 0 尺寸)
let mmChain = Promise.resolve(), mmLast = null;
function renderMindmap(md) {
  mmChain = mmChain.then(() => (md === mmLast ? mm?.fit() : drawMindmap(md))).catch((e) => console.error(e));
  return mmChain;
}
async function drawMindmap(md) {
  const { Transformer, Markmap } = window.markmap || {};
  if (!Transformer || !Markmap) { $("#resultView").hidden = false; $("#resultView").innerHTML = renderMarkdown(md); return; }
  const { root } = new Transformer().transform(md);
  if (!mm) {
    mm = Markmap.create("#mindmap", { duration: 300, maxWidth: 280, initialExpandLevel: -1 });
    // 容器尺寸变了(切换标签、窗口缩放)就重新适应,否则导图可能被挪出可视区
    new ResizeObserver(() => { if (mm.state.data) mm.fit(); }).observe($("#mindmap"));
  }
  await mm.setData(root); // 渲染是异步的,画完再适应窗口
  mmLast = md;
  await mm.fit();
}
$("#btnFit").onclick = () => mm?.fit();

// 导出:把 Markmap 的样式内联进 SVG,单独打开也能正常显示
function mindmapSvgString() {
  const svg = $("#mindmap");
  const g = svg.querySelector("g");
  const box = g.getBBox();
  const pad = 24;
  const clone = svg.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", Math.ceil(box.width + pad * 2));
  clone.setAttribute("height", Math.ceil(box.height + pad * 2));
  clone.setAttribute("viewBox", `${box.x - pad} ${box.y - pad} ${box.width + pad * 2} ${box.height + pad * 2}`);
  clone.querySelector("g").removeAttribute("transform");
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = (window.markmap.globalCSS || "") + ` .markmap{--markmap-text-color:#1c1f24;font:14px -apple-system,"PingFang SC",sans-serif;background:#fff}`;
  clone.insertBefore(style, clone.firstChild);
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", box.x - pad); bg.setAttribute("y", box.y - pad);
  bg.setAttribute("width", box.width + pad * 2); bg.setAttribute("height", box.height + pad * 2);
  bg.setAttribute("fill", "#fff");
  clone.insertBefore(bg, style.nextSibling);
  return { str: new XMLSerializer().serializeToString(clone), w: box.width + pad * 2, h: box.height + pad * 2 };
}

$("#btnExportSvg").onclick = () => {
  if (!mm) return;
  saveFile(`${current.title}-思维导图.svg`, { content: mindmapSvgString().str });
};
$("#btnExportPng").onclick = async () => {
  if (!mm) return;
  const { str, w, h } = mindmapSvgString();
  const img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(str);
  try {
    await img.decode();
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = w * scale; canvas.height = h * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, w, h);
    saveFile(`${current.title}-思维导图.png`, { dataUrl: canvas.toDataURL("image/png") });
  } catch (e) {
    uiAlert("导出 PNG 失败,请用「导出 SVG」:" + e.message);
  }
};

// 结果里的 [mm:ss] 时间戳可以点,跳到对应位置
$("#resultView").addEventListener("click", (e) => {
  const a = e.target.closest("a.ts");
  if (!a) return;
  e.preventDefault();
  seek(Number(a.dataset.t));
});

async function openMeeting(id, keepTab = false) {
  if (id !== currentId && !keepTab) activeTab = null;
  currentId = id;
  current = await api(`/api/meetings/${id}`);
  await loadActions();
  $("#emptyDetail").hidden = true;
  $("#detailBody").hidden = false;
  $("#dTitle").textContent = current.title;
  $("#dTime").textContent = fmtDate(current.createdAt);
  $("#dDuration").textContent = fmtTime(current.durationSec);
  setStatus(current.status);
  showError(current.error);
  const mediaUrl = current.audioFile ? `/api/meetings/${id}/audio` : "";
  const v = $("#dVideo"), a = $("#dAudio");
  v.hidden = !current.hasVideo; a.hidden = !!current.hasVideo || !mediaUrl;
  if (current.hasVideo) { if (!v.src.endsWith(mediaUrl)) v.src = mediaUrl; a.removeAttribute("src"); }
  else { v.removeAttribute("src"); if (mediaUrl && !a.src.endsWith(mediaUrl)) a.src = mediaUrl; }
  const mk = current.markers || [];
  $("#dMarkers").hidden = !mk.length;
  $("#dMarkers").innerHTML = mk.length ? "打点:" + mk.map((s) => `<button class="chip" data-t="${s}">${fmtTime(s)}</button>`).join("") : "";
  const hasTracks = !!(current.tracks?.mic || current.tracks?.system);
  $("#dSpeakers").hidden = !hasTracks;
  if (hasTracks && !$("#dSpeakers").contains(document.activeElement)) {
    $("#spMe").value = current.speakerNames?.mic || "";
    $("#spGuest").value = current.speakerNames?.system || "";
  }
  $("#btnSrt").disabled = !current.transcript;
  $("#dStorage").hidden = !current.size;
  $("#dSize").textContent = current.mediaRemoved
    ? `占用 ${fmtSize(current.size)} · 录音文件已删除,只保留文字`
    : `占用 ${fmtSize(current.size)}${current.videoSize ? `(视频 ${fmtSize(current.videoSize)})` : ""}`;
  $("#btnStripVideo").hidden = !current.hasVideo;
  $("#btnStripAll").hidden = !current.audioFile || !current.transcript;
  $("#dWarn").hidden = !current.warnings?.length;
  $("#dWarn").textContent = (current.warnings || []).join(" ");
  if (current.job) setStatus(current.job.state === "queued" ? "queued" : current.job.kind === "transcribe" ? "transcribing" : "summarizing");
  $("#btnTranscribe").disabled = !current.audioFile || !!current.job || current.status === "transcribing" || current.status === "recording";
  // 后台转写 / 分析时,每 3 秒刷新一次
  clearTimeout(detailPoll);
  if ((current.job || ["transcribing", "recording", "summarizing"].includes(current.status)) && !summarizingNow) {
    detailPoll = setTimeout(() => { if (currentId === id) openMeeting(id, true).catch(() => {}); }, 3000);
  }
  if (document.activeElement !== $("#transcriptEdit")) $("#transcriptEdit").value = current.transcript || "";
  renderTranscriptRead();
  $("#btnAutoTitle").hidden = !current.transcript;
  $("#btnAnalyze").disabled = !current.transcript || summarizingNow;
  renderPicker();
  renderTabs();
  renderPane();
  await loadList();
}

$("#dTitle").onblur = async () => {
  const title = $("#dTitle").textContent.trim();
  if (current && title && title !== current.title) {
    await api(`/api/meetings/${current.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
    current.title = title; loadList();
  }
};
$("#dTitle").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } };
$("#btnAutoTitle").onclick = async () => {
  if (!current) return;
  const btn = $("#btnAutoTitle");
  btn.disabled = true; btn.textContent = "起标题中…";
  try {
    const r = await api(`/api/meetings/${current.id}/title`, { method: "POST" });
    await openMeeting(current.id, true);
    toast(`新标题:${r.title}`);
  } catch (e) { uiAlert(e.message, "没能起标题"); }
  finally { btn.disabled = false; btn.textContent = "✨ 起标题"; }
};

$("#btnTranscribe").onclick = async () => {
  if (!current) return;
  const btn = $("#btnTranscribe");
  btn.disabled = true; showError("");
  try {
    await api(`/api/meetings/${current.id}/transcribe`, { method: "POST" });
    activeTab = "transcript";
    await openMeeting(current.id, true);
    loadList();
  } catch (e) {
    setStatus("error"); showError(e.message); btn.disabled = false;
  }
};

$("#btnAnalyze").onclick = async () => {
  if (!current) return;
  const chosen = new Set([...document.querySelectorAll("#tplPicker input:checked")].map((i) => i.value));
  const ids = templates.map((t) => t.id).filter((id) => chosen.has(id));
  if (!ids.length) return uiAlert("先勾选至少一个模板");
  const btn = $("#btnAnalyze");
  btn.disabled = true; summarizingNow = true; streaming = {};
  setStatus("summarizing"); showError("");
  const errors = [];
  let n = 0;
  try {
    const res = await fetch(`/api/meetings/${current.id}/analyze`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateIds: ids }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const ev = /^event: (.*)$/m.exec(raw)?.[1];
        const data = /^data: (.*)$/m.exec(raw)?.[1];
        if (!ev || data == null) continue;
        const p = JSON.parse(data);
        if (ev === "start") {
          n++; btn.textContent = `分析中 ${n}/${ids.length}…`;
          streaming[p.templateId] = "";
          switchTab(p.templateId);
        } else if (ev === "delta") {
          streaming[p.templateId] = (streaming[p.templateId] || "") + p.text;
          if (activeTab === p.templateId) renderPane();
        } else if (ev === "done") {
          current.results = { ...(current.results || {}), [p.templateId]: p.text };
          delete streaming[p.templateId];
          renderTabs(); renderPane();
        } else if (ev === "error") {
          if (p.templateId) delete streaming[p.templateId];
          errors.push(p.templateId ? `${tplName(p.templateId)}:${p.message}` : p.message);
          showError(errors.join("\n"));
        }
      }
    }
  } catch (e) {
    errors.push(e.message);
  } finally {
    streaming = {}; summarizingNow = false;
    btn.textContent = "② 分析所选";
    await openMeeting(current.id, true).catch(() => {});
    if (errors.length) showError(errors.join("\n"));
  }
};

$("#btnCopy").onclick = async () => {
  if (!current) return;
  const text = activeTab === "transcript" ? $("#transcriptEdit").value : current.results?.[activeTab];
  if (!text) return uiAlert("这一页还没有内容");
  if (!(await copyText(text))) return uiAlert("复制失败,可以在「转写原文」里手动全选复制。");
  $("#btnCopy").textContent = "已复制 ✓";
  setTimeout(() => ($("#btnCopy").textContent = "复制当前页"), 1500);
};
$("#btnDownload").onclick = () => {
  if (!current) return;
  const parts = resultIds().map((id) => `## ${tplName(id)}\n\n${current.results[id]}`);
  const md = `# ${current.title}\n\n${fmtDate(current.createdAt)} · ${fmtTime(current.durationSec)}\n\n${parts.join("\n\n---\n\n") || "(还没有分析结果)"}\n\n---\n\n## 转写原文\n\n${current.transcript || "(无)"}\n`;
  saveFile(`${current.title}.md`, { content: md });
};
$("#btnSpeakers").onclick = async () => {
  if (!current) return;
  const btn = $("#btnSpeakers");
  btn.disabled = true;
  try {
    await api(`/api/meetings/${current.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speakerNames: { mic: $("#spMe").value.trim(), system: $("#spGuest").value.trim() } }) });
    document.activeElement?.blur();
    await openMeeting(current.id, true);
    btn.textContent = "已保存 ✓";
    setTimeout(() => (btn.textContent = "保存名字"), 1500);
  } catch (e) { uiAlert("保存失败:" + e.message); }
  finally { btn.disabled = false; }
};
["#spMe", "#spGuest"].forEach((sel) => $(sel).addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btnSpeakers").click(); }));

async function strip(keep) {
  const text = keep === "audio"
    ? `会删掉视频文件(${fmtSize(current.videoSize)}),保留声音、逐字稿和分析结果。删掉后不能恢复。`
    : `会删掉所有录音和视频文件(${fmtSize(current.mediaSize)}),只保留逐字稿和分析结果,之后不能再播放或重新转写。删掉后不能恢复。`;
  if (!(await uiConfirm(text, { title: keep === "audio" ? "删除视频?" : "删除录音文件?", ok: "删除", danger: true }))) return;
  try {
    await api(`/api/meetings/${current.id}/strip`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keep }) });
    $("#dVideo").removeAttribute("src"); $("#dAudio").removeAttribute("src");
    await openMeeting(current.id, true);
    toast("已删除,省出了空间");
  } catch (e) { uiAlert(e.message, "删除失败"); }
}
$("#btnStripVideo").onclick = () => strip("audio");
$("#btnStripAll").onclick = () => strip("text");

$("#btnSrt").onclick = async () => {
  if (!current) return;
  saveFile(`${current.title}.srt`, { srt: current.id });
};

$("#btnDelete").onclick = async () => {
  if (!current) return;
  if (!(await uiConfirm(`「${current.title}」会移到「最近删除」,30 天内可以恢复。`, { title: "删除这条记录?", ok: "删除", danger: true }))) return;
  try { await api(`/api/meetings/${current.id}`, { method: "DELETE" }); } catch (e) { return uiAlert(e.message, "删除失败"); }
  current = null; currentId = null;
  $("#detailBody").hidden = true; $("#emptyDetail").hidden = false;
  loadList();
};
$("#btnSaveTranscript").onclick = async () => {
  if (!current) return;
  const transcript = $("#transcriptEdit").value;
  await api(`/api/meetings/${current.id}/transcript`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript }) });
  current.transcript = transcript;
  renderTranscriptRead();
  $("#btnAnalyze").disabled = !transcript.trim();
  $("#btnSaveTranscript").textContent = "已保存 ✓";
  setTimeout(() => ($("#btnSaveTranscript").textContent = "保存修改"), 1500);
};

// ---------- 语音备忘录 ----------
const vmDlg = $("#vmDlg");
let vmMemos = [];
async function loadVoiceMemos() {
  $("#vmError").hidden = true;
  $("#btnVmPrivacy").hidden = true;
  $("#vmList").innerHTML = `<li class="empty small">读取中…</li>`;
  try {
    const data = await api("/api/voicememos");
    vmMemos = data.memos;
    $("#vmAuto").checked = data.autoImport;
    if (data.lastError) { $("#vmError").hidden = false; $("#vmError").textContent = "自动导入出错:" + data.lastError; }
    $("#vmList").innerHTML = vmMemos.length ? vmMemos.map((m) => {
      const state = m.importedAs ? `<span class="tag ok">已导入</span>` : !m.available ? `<span class="tag">在 iCloud 上,未下载</span>` : m.deleted ? `<span class="tag">导入过又删了,不会再自动导入</span>` : "";
      return `<li><label class="${m.importedAs || !m.available ? "dim" : ""}">
        <input type="checkbox" value="${escapeHtml(m.uid)}"${m.importedAs || !m.available ? " disabled" : ""} />
        <span class="pick-main"><span class="t">${escapeHtml(m.title)}</span>
        <span class="s">${fmtDate(m.date)} · ${fmtTime(m.durationSec)}${m.folder ? " · " + escapeHtml(m.folder) : ""}</span></span>${state}</label></li>`;
    }).join("") : `<li class="empty small">语音备忘录里还没有录音</li>`;
  } catch (e) {
    $("#vmList").innerHTML = "";
    $("#vmError").hidden = false; $("#vmError").textContent = e.message;
    $("#btnVmPrivacy").hidden = !e.message.includes("完全磁盘访问权限");
  }
}
$("#btnVmPrivacy").onclick = () => api("/api/open-privacy?pane=files", { method: "POST" }).catch((e) => uiAlert(e.message));
$("#btnVoiceMemos").onclick = () => { $("#vmAll").checked = false; vmDlg.showModal(); loadVoiceMemos(); };
$("#btnCloseVm").onclick = () => vmDlg.close();
$("#vmAll").onchange = (e) => document.querySelectorAll("#vmList input:not(:disabled)").forEach((i) => (i.checked = e.target.checked));
$("#vmAuto").onchange = async (e) => {
  await api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autoImportVoiceMemos: e.target.checked ? "1" : "0" }) });
};
$("#btnVmImport").onclick = async () => {
  const ids = [...document.querySelectorAll("#vmList input:checked")].map((i) => i.value);
  if (!ids.length) return uiAlert("先勾选要导入的录音");
  const btn = $("#btnVmImport");
  btn.disabled = true; btn.textContent = "导入中…";
  try {
    const r = await api("/api/voicememos/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
    if (r.errors.length) uiAlert(r.errors.join("\n"));
    await loadList();
    if (r.imported.length) { vmDlg.close(); await openMeeting(r.imported[0].id); }
  } catch (e) { uiAlert("导入失败:" + e.message); }
  finally { btn.disabled = false; btn.textContent = "导入所选"; }
};

// ---------- 批量分析 ----------
const batchDlg = $("#batchDlg");
$("#btnBatch").onclick = async () => {
  await loadList();
  const sel = loadSelected();
  $("#batchTpl").innerHTML = templates.map((t) =>
    `<label class="tpl-chip"><input type="checkbox" value="${escapeHtml(t.id)}"${sel.has(t.id) ? " checked" : ""} /><span>${escapeHtml(t.name)}</span></label>`).join("");
  const usable = meetings.filter((m) => m.audioFile && m.status !== "recording");
  $("#batchList").innerHTML = usable.length ? usable.map((m) => `<li><label>
    <input type="checkbox" value="${m.id}" />
    <span class="pick-main"><span class="t">${escapeHtml(m.title)}</span>
    <span class="s">${fmtDate(m.createdAt)} · ${fmtTime(m.durationSec)} · ${statusText(m)}</span></span></label></li>`).join("")
    : `<li class="empty small">还没有可以分析的记录</li>`;
  $("#batchAll").checked = false;
  batchDlg.showModal();
};
$("#batchAll").onchange = (e) => document.querySelectorAll("#batchList input").forEach((i) => (i.checked = e.target.checked));
$("#btnCloseBatch").onclick = () => batchDlg.close();
$("#btnBatchRun").onclick = async () => {
  const ids = [...document.querySelectorAll("#batchList input:checked")].map((i) => i.value);
  const templateIds = [...document.querySelectorAll("#batchTpl input:checked")].map((i) => i.value);
  if (!ids.length) return uiAlert("先勾选记录");
  if (!templateIds.length) return uiAlert("先勾选至少一个模板");
  const post = (meetingIds, kind) => api("/api/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ meetingIds, kind, templateIds }) });
  // 没转写的先排转写;队列按顺序执行,转写完才轮到分析
  const needTranscribe = ids.filter((id) => !meetings.find((m) => m.id === id)?.transcribeModel);
  if (needTranscribe.length) await post(needTranscribe, "transcribe");
  await post(ids, "analyze");
  batchDlg.close();
  loadList();
};

// ---------- 搜索 ----------
let searchTimer = null;
$("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
});
async function runSearch() {
  const q = $("#search").value.trim();
  $("#list").hidden = !!q;
  $("#searchResults").hidden = !q;
  if (!q) return;
  const results = await api("/api/search?q=" + encodeURIComponent(q)).catch(() => []);
  if ($("#search").value.trim() !== q) return; // 输入已经变了
  const mark = (t) => {
    let html = escapeHtml(t);
    for (const term of q.split(/\s+/).filter(Boolean)) {
      html = html.replace(new RegExp(escapeHtml(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => `<mark>${m}</mark>`);
    }
    return html;
  };
  $("#searchResults").innerHTML = results.length ? results.map((r) => `<li data-id="${r.id}">
    <div class="t">${escapeHtml(r.title)}</div><div class="s">${fmtDate(r.createdAt)} · ${r.count} 处</div>
    ${r.hits.map((h) => `<div class="hit" data-tab="${h.tab}" data-t="${h.t ?? ""}"><span class="where">${escapeHtml(h.where)}${h.t != null ? " " + fmtTime(h.t) : ""}</span>${mark(h.text)}</div>`).join("")}
  </li>`).join("") : `<li class="empty small">没有找到「${escapeHtml(q)}」</li>`;
}
$("#searchResults").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  const hit = e.target.closest(".hit");
  if (hit?.dataset.tab) activeTab = hit.dataset.tab;
  await openMeeting(li.dataset.id, !!hit?.dataset.tab);
  if (hit?.dataset.t) seek(Number(hit.dataset.t));
});

// ---------- 问资料库 ----------
const askDlg = $("#askDlg");
let askHistory = [], askBusy = false;

// 回答里的 [[M2 13:05]] 变成可以点的出处
function renderAnswer(text, sources) {
  const byRef = Object.fromEntries((sources || []).map((s) => [s.ref, s]));
  const marked = text.replace(/\[\[(M\d+)\s+(\d{1,3}):(\d{2})\]\]/g, (m, ref, mi, se) => `\u27E6${ref}|${Number(mi) * 60 + Number(se)}\u27E7`);
  return renderMarkdown(marked).replace(/\u27E6(M\d+)\|(\d+)\u27E7/g, (m, ref, t) => {
    const s = byRef[ref];
    if (!s) return "";
    return `<a href="#" class="cite" data-id="${s.id}" data-t="${t}" title="${escapeHtml(s.title)}">${escapeHtml(s.title.slice(0, 14))} ${fmtTime(Number(t))}</a>`;
  });
}

function askBubble(role, html) {
  const log = $("#askLog");
  log.querySelector(".empty")?.remove();
  const div = document.createElement("div");
  div.className = `ask-msg ${role}`;
  div.innerHTML = html;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

$("#btnAsk").onclick = () => { askDlg.showModal(); $("#askInput").focus(); };
$("#btnCloseAsk").onclick = () => askDlg.close();
$("#btnAskClear").onclick = () => {
  if (askBusy) return;
  askHistory = [];
  $("#askLog").innerHTML = `<div class="empty small">新对话。问题会基于所有转写过的会议来回答。</div>`;
};
$("#askInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#askForm").requestSubmit(); }
});
$("#askLog").addEventListener("click", async (e) => {
  const a = e.target.closest("a.cite");
  if (!a) return;
  e.preventDefault();
  askDlg.close();
  activeTab = "transcript";
  await openMeeting(a.dataset.id, true);
  seek(Number(a.dataset.t));
});
$("#askForm").onsubmit = async (e) => {
  e.preventDefault();
  const question = $("#askInput").value.trim();
  if (!question || askBusy) return;
  askBusy = true;
  $("#btnAskSend").disabled = true;
  $("#askInput").value = "";
  askBubble("user", escapeHtml(question).replace(/\n/g, "<br>"));
  const bubble = askBubble("bot cursor", `<span class="hint">正在翻资料…</span>`);
  let text = "", sources = [];
  try {
    const res = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, history: askHistory }) });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", err = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const ev = /^event: (.*)$/m.exec(raw)?.[1];
        const data = /^data: (.*)$/m.exec(raw)?.[1];
        if (!ev || data == null) continue;
        const p = JSON.parse(data);
        if (ev === "stage") bubble.innerHTML = `<span class="hint">${escapeHtml(p.text)}</span>`;
        else if (ev === "sources") {
          sources = p.sources;
          bubble.innerHTML = `<span class="hint">${sources.length ? `正在读 ${sources.length} 场会议…` : ""}</span>`;
        } else if (ev === "delta") { text += p.text; bubble.innerHTML = renderAnswer(text, sources); }
        else if (ev === "done") text = p.text;
        else if (ev === "error") err = p.message;
      }
      $("#askLog").scrollTop = $("#askLog").scrollHeight;
    }
    if (err) throw new Error(err);
    // 只列回答里真正引用到的会议
    const cited = sources.filter((s) => text.includes(`[[${s.ref} `));
    bubble.innerHTML = renderAnswer(text, sources) +
      (cited.length ? `<div class="ask-sources">出自:${cited.map((s) => `<a href="#" class="cite" data-id="${s.id}" data-t="0">${escapeHtml(s.title)}</a>`).join("")}</div>` : "");
    askHistory.push({ q: question, a: text });
  } catch (e2) {
    bubble.innerHTML = `<span class="error">出错了:${escapeHtml(e2.message)}</span>`;
  } finally {
    bubble.classList.remove("cursor");
    askBusy = false;
    $("#btnAskSend").disabled = false;
    $("#askInput").focus();
  }
};

// ---------- 词库 ----------
const glossaryDlg = $("#glossaryDlg");
$("#btnGlossary").onclick = async () => {
  const list = await api("/api/glossary");
  $("#glossaryText").value = list.map((g) => (g.aliases.length ? `${g.term} = ${g.aliases.join(", ")}` : g.term)).join("\n");
  glossaryDlg.showModal();
};
$("#btnCloseGlossary").onclick = () => glossaryDlg.close();
$("#glossaryForm").onsubmit = async (e) => {
  e.preventDefault();
  const list = $("#glossaryText").value.split("\n").map((line) => {
    const [term, rest = ""] = line.split(/[=＝]/);
    return { term: term.trim(), aliases: rest.split(/[,，、]/).map((a) => a.trim()).filter(Boolean) };
  }).filter((g) => g.term);
  await api("/api/glossary", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(list) });
  glossaryDlg.close();
};

// ---------- 模板管理 ----------
const tplDlg = $("#templatesDlg");
let tplDraft = [], tplIdx = 0;

function commitTplForm() {
  const t = tplDraft[tplIdx];
  if (!t) return;
  t.name = $("#tplName").value.trim() || "未命名";
  t.format = $("#tplFormat").value;
  t.defaultOn = $("#tplDefaultOn").checked;
  t.prompt = $("#tplPrompt").value;
}
function renderTplList() {
  $("#tplList").innerHTML = tplDraft.map((t, i) =>
    `<li class="${i === tplIdx ? "active" : ""}" data-i="${i}">${escapeHtml(t.name)}${t.format === "mindmap" ? ' <span class="tag">导图</span>' : ""}${t.defaultOn ? ' <span class="tag">默认</span>' : ""}</li>`
  ).join("");
}
function renderTplEditor() {
  renderTplList();
  const t = tplDraft[tplIdx];
  $("#tplForm").hidden = !t;
  if (!t) return;
  $("#tplName").value = t.name;
  $("#tplFormat").value = t.format;
  $("#tplDefaultOn").checked = !!t.defaultOn;
  $("#tplPrompt").value = t.prompt;
}
$("#tplList").onclick = (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  commitTplForm(); tplIdx = Number(li.dataset.i); renderTplEditor();
};
$("#tplName").oninput = $("#tplFormat").onchange = $("#tplDefaultOn").onchange = () => { commitTplForm(); renderTplList(); };
$("#btnTemplates").onclick = async () => {
  tplDraft = structuredClone((await api("/api/templates")).templates);
  tplIdx = 0;
  renderTplEditor();
  tplDlg.showModal();
};
$("#btnTplNew").onclick = () => {
  commitTplForm();
  tplDraft.push({ id: "custom-" + Date.now().toString(36), name: "新模板", format: "markdown", prompt: "", defaultOn: false });
  tplIdx = tplDraft.length - 1; renderTplEditor(); $("#tplName").select();
};
$("#btnTplCopy").onclick = () => {
  commitTplForm();
  const t = tplDraft[tplIdx];
  if (!t) return;
  tplDraft.splice(tplIdx + 1, 0, { ...t, id: "custom-" + Date.now().toString(36), name: t.name + " 副本", defaultOn: false });
  tplIdx++; renderTplEditor();
};
$("#btnTplDelete").onclick = async () => {
  const t = tplDraft[tplIdx];
  if (!t || !(await uiConfirm(`已经生成的结果不受影响。点「保存」后生效。`, { title: `删除模板「${t.name}」?`, ok: "删除", danger: true }))) return;
  tplDraft.splice(tplIdx, 1);
  tplIdx = Math.max(0, tplIdx - 1); renderTplEditor();
};
$("#btnTplReset").onclick = async () => {
  if (!(await uiConfirm("你新建和修改过的模板会被清掉。", { title: "恢复成默认模板?", ok: "恢复默认", danger: true }))) return;
  await api("/api/templates", { method: "DELETE" });
  tplDraft = structuredClone((await api("/api/templates")).templates);
  tplIdx = 0; renderTplEditor();
  await loadTemplates();
};
$("#btnCloseTemplates").onclick = () => tplDlg.close();
$("#btnSaveTemplates").onclick = async () => {
  commitTplForm();
  const empty = tplDraft.find((t) => !t.prompt.trim());
  if (empty) return uiAlert(`模板「${empty.name}」的提示词是空的`);
  try {
    await api("/api/templates", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(tplDraft) });
  } catch (e) { return uiAlert("保存失败:" + e.message); }
  tplDlg.close();
  await loadTemplates();
  if (current) { renderTabs(); renderPane(); }
};

// ---------- 设置 ----------
const dlg = $("#settings");
const form = $("#settingsForm");

function updateProviderPanels() {
  const t = form.elements.transcribeProvider.value;
  const s = form.elements.summaryProvider.value;
  document.querySelector('[data-provider="transcribe-api"]').hidden = t !== "api";
  document.querySelector('[data-provider="transcribe-local"]').hidden = t !== "local";
  document.querySelector('[data-provider="summary-cli"]').hidden = s !== "cli";
  document.querySelector('[data-provider="summary-api"]').hidden = s !== "api";
  document.querySelector('[data-provider="summary-openai"]').hidden = s !== "openai";
}
form.addEventListener("change", (e) => { if (e.target.type === "radio") updateProviderPanels(); });

async function checkCli() {
  const el = $("#cliStatus");
  el.textContent = "登录状态:检测中…"; el.className = "hint";
  try {
    const st = await api("/api/claude-status");
    el.textContent = "登录状态:" + st.message;
    el.className = "hint " + (st.loggedIn ? "ok" : "bad");
    return st;
  } catch (e) {
    el.textContent = "登录状态:检测失败 " + e.message; el.className = "hint bad";
  }
}
$("#btnCheckCli").onclick = checkCli;

$("#btnSettings").onclick = async () => {
  const cfg = await api("/api/settings");
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "radio") el.checked = cfg[el.name] === el.value;
    else if (el.type === "checkbox") el.checked = cfg[el.name] === "1";
    else if (el.type === "password") { el.value = ""; el.placeholder = cfg[el.name] ? `已设置 ${cfg[el.name]},留空不改` : "未设置"; }
    else el.value = cfg[el.name] ?? "";
  }
  if (!cfg.localTranscribeAvailable) $("#localHint").textContent = "当前系统不支持本机识别,请改用 Whisper 接口。";
  if (!form.querySelector('input[name="backupScope"]:checked')) form.querySelector('input[name="backupScope"][value="text"]').checked = true;
  updateProviderPanels();
  dlg.showModal();
  checkCli();
  loadBackupState();
  loadRemindPreview();
};
$("#btnCloseSettings").onclick = () => dlg.close();

// ---------- 备份 ----------
let backupInfo = null;
function renderBackupUI() {
  const dir = form.elements.backupDir.value;
  $("#backupOn").checked = !!dir;
  $("#backupDetail").hidden = !dir;
  const pretty = dir.replace(/^\/Users\/[^/]+\/Library\/Mobile Documents\/com~apple~CloudDocs/, "iCloud 云盘").replace(/^\/Users\/[^/]+\/Documents/, "文稿").replace(/^\/Users\/[^/]+/, "~");
  $("#backupPath").textContent = dir ? `备份位置:${pretty.split("/").join(" / ")}` : "";
  if (!backupInfo) return;
  $("#backupOnText").textContent = backupInfo.icloud ? "自动备份到 iCloud 云盘" : "自动备份到「文稿」文件夹";
  const st = backupInfo.running ? "正在备份…" : backupInfo.lastError ? `上次备份出错:${backupInfo.lastError}`
    : backupInfo.lastAt ? `上次备份:${new Date(backupInfo.lastAt).toLocaleString("zh-CN")}` : "还没有备份过";
  $("#backupStatus").textContent = st;
}
async function loadBackupState() {
  backupInfo = await api("/api/backup").catch(() => null);
  renderBackupUI();
}
$("#backupOn").onchange = (e) => {
  form.elements.backupDir.value = e.target.checked ? (backupInfo?.dir || backupInfo?.suggested || "") : "";
  renderBackupUI();
};
async function saveSettingsQuietly() {
  const body = { backupDir: form.elements.backupDir.value, backupScope: form.querySelector('input[name="backupScope"]:checked')?.value || "text" };
  await api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
$("#btnBackupNow").onclick = async () => {
  const btn = $("#btnBackupNow");
  btn.disabled = true; $("#backupStatus").textContent = "正在备份…";
  try {
    await saveSettingsQuietly();
    backupInfo = { ...backupInfo, ...(await api("/api/backup/run", { method: "POST" })) };
    renderBackupUI();
    if (!backupInfo.lastError) toast(backupInfo.copied ? `备份完成,更新了 ${backupInfo.copied} 个文件(${fmtSize(backupInfo.bytes || 0)})` : "备份完成,没有新改动");
  } catch (e) { uiAlert(e.message, "备份失败"); }
  finally { btn.disabled = false; }
};
$("#btnBackupReveal").onclick = async () => { await saveSettingsQuietly(); api("/api/backup/reveal", { method: "POST" }).catch((e) => uiAlert(e.message)); };
$("#btnBackupRestore").onclick = async () => {
  if (!(await uiConfirm("会把备份里有、但这台 Mac 上没有的记录拷回来。已有的记录不会被覆盖。", { title: "从备份恢复?", ok: "恢复" }))) return;
  try {
    await saveSettingsQuietly();
    const r = await api("/api/backup/restore", { method: "POST" });
    toast(r.restored ? `恢复了 ${r.restored} 条记录` : "没有需要恢复的记录");
    loadList();
  } catch (e) { uiAlert(e.message, "恢复失败"); }
};
form.onsubmit = async (e) => {
  e.preventDefault();
  const body = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "radio") { if (el.checked) body[el.name] = el.value; }
    else if (el.type === "checkbox") body[el.name] = el.checked ? "1" : "0";
    else if (el.value !== "" || el.hasAttribute("data-allow-empty")) body[el.name] = el.value;
  }
  await api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  dlg.close();
  refreshHint();
};

// ---------- 启动 ----------
async function refreshHint() {
  const cfg = await api("/api/settings");
  const problems = [];
  if (cfg.transcribeProvider === "api" && !cfg.hasTranscribeKey) problems.push("转写接口还没填 API Key");
  if (cfg.transcribeProvider === "local" && !cfg.localTranscribeAvailable) problems.push("当前系统不支持本机识别");
  if (cfg.summaryProvider === "api" && !cfg.hasAnthropicKey) problems.push("Claude 还没填 API Key");
  if (cfg.summaryProvider === "openai" && !cfg.hasOpenaiKey) problems.push("OpenAI 兼容接口还没填 API Key");
  if (cfg.summaryProvider === "cli") {
    const st = await api("/api/claude-status").catch(() => null);
    if (st && !st.loggedIn) problems.push("Claude Code " + st.message);
  }
  if (problems.length) $("#recHint").textContent = "⚠️ " + problems.join(";") + "。点右上角「设置」处理。";
}
loadList();
refreshHint();
loadTemplates().catch(() => {});
updateModeUI();
loadSources();
// 打开页面时如果正在录制(比如从菜单栏开始后重开窗口),接上状态
api("/api/record/status").then((st) => { if (st.active) watchRecording(); }).catch(() => {});

// 应用模式下的心跳:窗口关掉 30 秒后服务自动退出
setInterval(() => fetch("/api/ping").catch(() => {}), 5000);
fetch("/api/ping").catch(() => {});

// ---------- 行动项(会议变行动) ----------
let actions = [], actionsBusy = false;
const ACT_STATUS = { pending: "待确认", todo: "待办", doing: "进行中", done: "已完成", dropped: "搁置" };
const ACT_ORDER = { pending: 0, doing: 1, todo: 2, done: 3, dropped: 4 };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const dueClass = (a) => (!a.due || a.status === "done" || a.status === "dropped") ? "" : a.due < today() ? "overdue" : a.due === today() ? "due-today" : "";
const dueLabel = (a) => !a.due ? "" : a.due < today() && a.status !== "done" && a.status !== "dropped" ? "已逾期" : a.due === today() ? "今天到期" : "";
const statusSelect = (a) => `<select class="act-status s-${a.status}" data-f="status">${Object.entries(ACT_STATUS).filter(([k]) => k !== "pending" || a.status === "pending").map(([k, v]) => `<option value="${k}"${k === a.status ? " selected" : ""}>${v}</option>`).join("")}</select>`;

let reviews = [];
async function loadActions() {
  if (!currentId || !current?.transcript) { actions = []; reviews = []; return; }
  [actions, reviews] = await Promise.all([
    api(`/api/meetings/${currentId}/actions`).catch(() => []),
    api(`/api/meetings/${currentId}/reviews`).catch(() => []),
  ]);
}

function sortActions(list) {
  return [...list].sort((a, b) => (ACT_ORDER[a.status] - ACT_ORDER[b.status]) || ((a.due || "9999") < (b.due || "9999") ? -1 : (a.due || "9999") > (b.due || "9999") ? 1 : 0) || a.createdAt.localeCompare(b.createdAt));
}

function actionRow(a, { meeting = null } = {}) {
  const src = a.source;
  return `<div class="act-row ${a.status} ${dueClass(a)}" data-aid="${a.id}" data-mid="${meeting ? meeting.id : currentId}">
    ${statusSelect(a)}
    <div class="act-main">
      <div class="act-text" contenteditable="true" spellcheck="false" data-f="text">${escapeHtml(a.text)}</div>
      <div class="act-sub">
        <input class="act-owner" data-f="owner" placeholder="负责人" value="${escapeHtml(a.owner || "")}" />
        <input type="date" class="act-due" data-f="due" value="${a.due || ""}" />
        ${dueLabel(a) ? `<span class="due-tag">${dueLabel(a)}</span>` : ""}
        ${a.dueText && !a.due ? `<span class="hint">原话「${escapeHtml(a.dueText)}」</span>` : ""}
        ${src ? `<button type="button" class="chip act-src" data-t="${src.t}" title="${escapeHtml(src.quote)}">▶ ${fmtTime(src.t)} 原话</button>` : ""}
        ${meeting ? `<button type="button" class="chip act-meeting" title="${escapeHtml(meeting.title)}">${escapeHtml(meeting.title.slice(0, 16))} · ${fmtDate(meeting.createdAt)}</button>` : ""}
        ${a.status === "pending" && a.confidence != null ? `<span class="hint">AI 置信 ${Math.round(a.confidence * 100)}%</span>` : ""}
      </div>
    </div>
    <div class="act-ops">
      ${a.status === "pending" ? `<button type="button" class="primary small act-confirm">确认</button>` : ""}
      <button type="button" class="ghost small act-del" title="删除">×</button>
    </div>
  </div>`;
}

const REV_LABEL = { done: "说做完了", doing: "说有进展", dropped: "说不做了" };
function renderReviews() {
  const open = reviews.filter((r) => !r.resolved);
  $("#reviewList").innerHTML = open.length ? `<div class="act-group">
    <div class="act-group-title">之前定的事,这场会里提到了 · 确认后会改掉原任务的状态</div>
    ${open.map((r) => `<div class="rev-row ${r.suggested}" data-aid="${r.actionId}">
      <span class="rev-tag">${REV_LABEL[r.suggested]}</span>
      <div class="act-main">
        <div class="act-text">${escapeHtml(r.text)}</div>
        <div class="act-sub">
          <span class="hint">${escapeHtml(r.owner || "待定")}</span>
          ${r.t != null ? `<button type="button" class="chip act-src" data-t="${r.t}" title="${escapeHtml(r.quote)}">▶ ${fmtTime(r.t)} 原话</button>` : ""}
          <span class="hint">「${escapeHtml(r.quote)}」</span>
        </div>
      </div>
      <div class="act-ops">
        <button type="button" class="primary small rev-accept">${r.suggested === "done" ? "标记完成" : r.suggested === "doing" ? "改为进行中" : "标记搁置"}</button>
        <button type="button" class="ghost small rev-ignore">忽略</button>
      </div>
    </div>`).join("")}
  </div>` : "";
}
$("#reviewList").addEventListener("click", async (e) => {
  const row = e.target.closest(".rev-row");
  if (!row) return;
  const aid = row.dataset.aid;
  try {
    if (e.target.closest(".act-src")) { seek(Number(e.target.closest(".act-src").dataset.t)); return; }
    const accept = !!e.target.closest(".rev-accept");
    if (!accept && !e.target.closest(".rev-ignore")) return;
    reviews = await api(`/api/meetings/${currentId}/reviews/${aid}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accept }) });
    renderReviews();
    if (accept) { toast("已更新原任务"); loadBriefing(); }
  } catch (err) { uiAlert(err.message, "操作失败"); }
});
$("#btnReview").onclick = async () => {
  if (!current?.transcript) return;
  const btn = $("#btnReview");
  btn.disabled = true; btn.textContent = "对照中…";
  try {
    const r = await api(`/api/meetings/${current.id}/reviews`, { method: "POST" });
    reviews = r.reviews;
    toast(r.added ? `发现 ${r.added} 条旧任务在这场会里被提到` : "没发现旧任务的进展");
  } catch (e) { uiAlert(e.message, "对照失败"); }
  finally { btn.disabled = false; btn.textContent = "🔁 对照旧任务"; renderReviews(); }
};

function renderActions() {
  renderReviews();
  const list = sortActions(actions);
  const pending = list.filter((a) => a.status === "pending");
  const rest = list.filter((a) => a.status !== "pending");
  $("#actEmpty").hidden = !!list.length;
  $("#btnConfirmAll").hidden = !pending.length;
  $("#btnConfirmAll").textContent = `全部确认(${pending.length})`;
  $("#btnExtract").disabled = actionsBusy || !current?.transcript;
  const open = rest.filter((a) => a.status === "todo" || a.status === "doing").length;
  const done = rest.filter((a) => a.status === "done").length;
  $("#actHint").textContent = list.length ? `${pending.length ? `${pending.length} 条待确认 · ` : ""}${open} 条未完成 · ${done} 条已完成` : "";
  $("#actList").innerHTML =
    (pending.length ? `<div class="act-group"><div class="act-group-title">AI 提取的,等你确认</div>${pending.map((a) => actionRow(a)).join("")}</div>` : "") +
    (rest.length ? `<div class="act-group">${pending.length ? `<div class="act-group-title">已确认</div>` : ""}${rest.map((a) => actionRow(a)).join("")}</div>` : "");
}

async function patchActionRow(mid, aid, body) {
  const updated = await api(`/api/meetings/${mid}/actions/${aid}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const i = actions.findIndex((a) => a.id === aid);
  if (i >= 0 && mid === currentId) actions[i] = updated;
  return updated;
}

// 会议内的行动项面板和全局看板共用一套事件处理
async function onActionEvent(e, container, rerender) {
  const row = e.target.closest(".act-row");
  if (!row) return;
  const aid = row.dataset.aid, mid = row.dataset.mid;
  const f = e.target.dataset?.f;
  try {
    if (e.type === "change" && f && f !== "text") {
      await patchActionRow(mid, aid, { [f]: e.target.value });
      rerender();
    } else if (e.type === "focusout" && f === "text") {
      const text = e.target.textContent.trim();
      const cur = actions.find((a) => a.id === aid);
      if (text && (!cur || text !== cur.text)) await patchActionRow(mid, aid, { text });
      else if (!text && cur) e.target.textContent = cur.text;
    } else if (e.type === "keydown" && f === "text" && e.key === "Enter") {
      e.preventDefault(); e.target.blur();
    } else if (e.type === "click") {
      if (e.target.closest(".act-confirm")) { await patchActionRow(mid, aid, { status: "todo" }); rerender(); }
      else if (e.target.closest(".act-del")) {
        if (!(await uiConfirm("删除这条行动项?", { ok: "删除", danger: true }))) return;
        await api(`/api/meetings/${mid}/actions/${aid}`, { method: "DELETE" });
        if (mid === currentId) actions = actions.filter((a) => a.id !== aid);
        rerender();
      } else if (e.target.closest(".act-src")) {
        const t = Number(e.target.closest(".act-src").dataset.t);
        if (mid !== currentId) { boardDlg.close(); activeTab = "actions"; await openMeeting(mid, true); }
        seek(t);
        toast("原话:" + (e.target.closest(".act-src").title || ""));
      } else if (e.target.closest(".act-meeting")) {
        boardDlg.close(); activeTab = "actions"; await openMeeting(mid, true);
      }
    }
  } catch (err) { uiAlert(err.message, "操作失败"); }
}
for (const ev of ["change", "focusout", "keydown", "click"]) {
  $("#actList").addEventListener(ev, (e) => onActionEvent(e, $("#actList"), () => { renderActions(); renderTabs(); }));
}

$("#btnExtract").onclick = async () => {
  if (!current?.transcript || actionsBusy) return;
  actionsBusy = true;
  const btn = $("#btnExtract");
  btn.disabled = true; btn.textContent = "提取中…(约 1 分钟)";
  try {
    const r = await api(`/api/meetings/${current.id}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ extract: true }) });
    actions = r.items;
    toast(r.added ? `提取到 ${r.added} 条新行动项,请确认` : "没有发现新的行动项");
  } catch (e) { uiAlert(e.message, "提取失败"); }
  finally { actionsBusy = false; btn.disabled = false; btn.textContent = "✨ 从逐字稿提取"; renderActions(); renderTabs(); }
};
$("#btnConfirmAll").onclick = async () => {
  actions = await api(`/api/meetings/${current.id}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
  renderActions(); renderTabs();
};
$("#btnAddAction").onclick = async () => {
  if (!current) return;
  const a = await api(`/api/meetings/${current.id}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "新任务(点这里改)", owner: "" }) });
  actions.push(a);
  renderActions(); renderTabs();
  const el = $("#actList").querySelector(`[data-aid="${a.id}"] .act-text`);
  if (el) { el.focus(); document.getSelection()?.selectAllChildren(el); }
};

// ---------- 全局任务看板 ----------
const boardDlg = $("#boardDlg");
let boardItems = [], boardFilter = "open", boardOwner = "";
async function loadBoard() {
  boardItems = await api("/api/actions");
  const owners = [...new Set(boardItems.map((a) => a.owner).filter(Boolean))].sort();
  const sel = $("#boardOwner");
  const keep = boardOwner;
  sel.innerHTML = `<option value="">所有人</option>` + owners.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
  sel.value = owners.includes(keep) ? keep : "";
  boardOwner = sel.value;
  renderBoard();
}
function renderBoard() {
  const t = today();
  const live = boardItems.filter((a) => a.status !== "done" && a.status !== "dropped");
  const stats = {
    pending: boardItems.filter((a) => a.status === "pending").length,
    open: live.filter((a) => a.status !== "pending").length,
    overdue: live.filter((a) => a.due && a.due < t).length,
    done: boardItems.filter((a) => a.status === "done").length,
  };
  $("#boardStats").innerHTML = [
    ["待确认", stats.pending, "pending"], ["未完成", stats.open, "open"], ["已逾期", stats.overdue, "overdue"], ["已完成", stats.done, "done"],
  ].map(([l, n, k]) => `<div class="stat ${k}"><b>${n}</b><span>${l}</span></div>`).join("");
  let list = boardItems.filter((a) => !boardOwner || a.owner === boardOwner);
  if (boardFilter === "open") list = list.filter((a) => a.status === "todo" || a.status === "doing");
  else if (boardFilter === "overdue") list = list.filter((a) => a.due && a.due < t && a.status !== "done" && a.status !== "dropped");
  else if (boardFilter !== "all") list = list.filter((a) => a.status === boardFilter);
  list = sortActions(list);
  $("#boardList").innerHTML = list.length
    ? list.map((a) => actionRow(a, { meeting: { id: a.meetingId, title: a.meetingTitle, createdAt: a.meetingAt } })).join("")
    : `<div class="empty small">这个筛选下没有任务。</div>`;
  $("#boardStatus").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.s === boardFilter));
}
$("#btnBoard").onclick = async () => { boardDlg.showModal(); $("#boardList").innerHTML = `<div class="empty small">加载中…</div>`; await loadBoard().catch((e) => uiAlert(e.message)); };
$("#btnCloseBoard").onclick = () => boardDlg.close();
$("#btnBoardRefresh").onclick = () => loadBoard();
$("#boardStatus").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { boardFilter = b.dataset.s; renderBoard(); } });
$("#boardOwner").addEventListener("change", (e) => { boardOwner = e.target.value; renderBoard(); });
for (const ev of ["change", "focusout", "keydown", "click"]) {
  $("#boardList").addEventListener(ev, (e) => onActionEvent(e, $("#boardList"), async () => {
    // 看板里改了状态,重新拉一遍保证各会议的数据一致
    const r = e.target.closest(".act-row");
    if (r && e.type === "change") { const u = await api(`/api/meetings/${r.dataset.mid}/actions`).catch(() => null); if (u) boardItems = boardItems.map((a) => a.meetingId === r.dataset.mid ? { ...(u.find((x) => x.id === a.id) || a), meetingId: a.meetingId, meetingTitle: a.meetingTitle, meetingAt: a.meetingAt } : a); }
    else if (r) boardItems = await api("/api/actions");
    renderBoard();
  }));
}

// ---------- 认领消息 ----------
const claimDlg = $("#claimDlg");
const fmtDue = (ymd) => ymd ? `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}` : "";
function buildClaimText() {
  const list = sortActions(actions.filter((a) => a.status === "todo" || a.status === "doing"));
  if (!list.length) return "";
  const groups = new Map();
  for (const a of list) { const k = a.owner || "待认领"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); }
  const d = new Date(current.createdAt);
  const lines = [`📋 「${current.title}」行动项(${d.getMonth() + 1}/${d.getDate()} 会议)`, ""];
  // 有名字的在前,「待认领」放最后
  const keys = [...groups.keys()].sort((a, b) => (a === "待认领") - (b === "待认领"));
  for (const k of keys) {
    lines.push(k === "待认领" ? "🙋 待认领(谁来接?)" : `@${k}`);
    groups.get(k).forEach((a, i) => {
      const due = a.due ? ` · ${fmtDue(a.due)} 前` : a.dueText ? ` · ${a.dueText}` : "";
      const src = a.source ? `(${fmtTime(a.source.t)} 原话:${a.source.quote.slice(0, 24)})` : "";
      lines.push(`${i + 1}. ${a.text}${due} ${src}`.trimEnd());
    });
    lines.push("");
  }
  lines.push("看到请回「收到」,有出入直接在群里说,我来改。");
  return lines.join("\n");
}
$("#btnClaim").onclick = () => {
  const text = buildClaimText();
  if (!text) { toast("还没有已确认的任务,先确认几条"); return; }
  $("#claimText").value = text;
  claimDlg.showModal();
};
$("#btnCloseClaim").onclick = () => claimDlg.close();
$("#btnCopyClaim").onclick = async () => { await copyText($("#claimText").value); toast("已复制,去群里粘贴"); };

// ---------- 任务提醒(设置里) ----------
async function loadRemindPreview() {
  const el = $("#remindPreview");
  try {
    const d = await api("/api/reminders");
    el.textContent = `现在的情况:逾期 ${d.overdue.length} 条 · 今天到期 ${d.today.length} 条 · 明天到期 ${d.tomorrow.length} 条。`;
  } catch { el.textContent = ""; }
}
$("#btnRemindTest").onclick = async () => {
  const btn = $("#btnRemindTest");
  btn.disabled = true;
  try {
    const r = await api("/api/reminders", { method: "POST" });
    toast(r.sent ? "已发出一条系统通知,看右上角" : "没发出去,看看系统设置里有没有允许通知");
  } catch (e) { uiAlert(e.message, "提醒失败"); }
  finally { btn.disabled = false; }
};

// ---------- 会前汇报 ----------
let briefCache = null;
async function loadBriefing() {
  try {
    briefCache = await api("/api/briefing");
    const c = briefCache.counts;
    $("#briefCard").hidden = !briefCache.lastMeeting;
    $("#briefLine").textContent = briefCache.line;
    $("#briefCard").classList.toggle("warn", c.overdue > 0);
  } catch { $("#briefCard").hidden = true; }
}
function showBriefing() {
  if (!briefCache) return;
  $("#claimTitle").textContent = "会前汇报";
  $("#claimHint").textContent = "开会前发到群里,或者自己看一眼:上次定的事做完几件、谁逾期了。";
  $("#claimText").value = briefCache.text;
  claimDlg.showModal();
}
$("#btnBriefCopy").onclick = async () => { await loadBriefing(); showBriefing(); };
$("#btnBoardBrief").onclick = async () => { await loadBriefing(); showBriefing(); };
$("#btnBriefBoard").onclick = () => $("#btnBoard").click();
$("#btnClaim").addEventListener("click", () => { $("#claimTitle").textContent = "认领消息"; $("#claimHint").textContent = "按负责人分好组了,复制到微信 / 飞书群里,让每个人认领自己的。只包含已确认的任务。"; });
loadBriefing();
