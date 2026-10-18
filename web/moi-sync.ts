// 把示例会议同步进 MOI 知识库。在项目根目录运行(会读 .env 里的 GENESIS_API_KEY):
//   bun web/moi-sync.ts          生成文档 → 第一次建知识库,之后整批替换文档
//   bun web/moi-sync.ts status   看知识库里每份文档的处理状态
//   bun web/moi-sync.ts retry    处理失败的文档删掉重传(平台偶尔内部超时)
// 知识库和工作区的编号记在 web/moi.json(不含密钥,可以提交)。
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const WEB = import.meta.dir;
const API = "https://api.moi.matrixorigin.cn/v5";
const CONF_PATH = path.join(WEB, "moi.json");
const KEY = Bun.env.GENESIS_API_KEY;
if (!KEY) throw new Error("没在 .env 里找到 GENESIS_API_KEY(要在项目根目录运行)");

const conf: Record<string, any> = existsSync(CONF_PATH) ? JSON.parse(await readFile(CONF_PATH, "utf8")) : {};
const saveConf = () => Bun.write(CONF_PATH, JSON.stringify(conf, null, 2) + "\n");

async function api(method: string, p: string, body?: unknown, form?: FormData) {
  const headers: Record<string, string> = { "X-API-Key": KEY! };
  if (conf.workspaceId) headers["X-Workspace-ID"] = conf.workspaceId;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(API + p, { method, headers, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok || (data.code && data.code !== "OK")) throw new Error(`${method} ${p} → HTTP ${res.status} ${data.code || ""} ${data.msg || text.slice(0, 200)}`);
  return data.data ?? data;
}

async function ensureWorkspace() {
  if (conf.workspaceId) return;
  const d = await api("GET", "/workspaces");
  const ws = d.workspaces?.[0];
  if (!ws) throw new Error("账号下没有工作区,先在 https://moi.matrixorigin.cn 登录一次");
  conf.workspaceId = ws.id;
  await saveConf();
}

const kbFiles = async () => (await readdir(path.join(WEB, "kb"))).filter((f) => f.endsWith(".md")).sort();
async function upload(url: string, name: string) {
  const form = new FormData();
  form.append("file", new File([await readFile(path.join(WEB, "kb", name))], name, { type: "text/markdown" }));
  return (await api("POST", url, undefined, form)).file_id as string;
}

async function listSources() {
  const d = await api("GET", `/semantic-models/${conf.kbId}/sources?page=1&page_size=100`);
  return (d.items || d.sources || []) as any[];
}

async function status() {
  const items = await listSources();
  for (const s of items) console.log(`${String(s.ingest_status).padEnd(10)} ${s.display_name}${s.error ? "  错误:" + JSON.stringify(s.error) : ""}`);
  // 记下 文件编号 → 文档名(去掉 .md 和日期前缀),网页版显示「在哪份文档里找到」用
  const docs: Record<string, string> = {};
  for (const s of items) docs[s.kb_file_id || s.source_file_id] = String(s.display_name).replace(/\.md$/, "").replace(/^(M\d)-\d+月\d+日-/, "$1 ");
  if (JSON.stringify(docs) !== JSON.stringify(conf.docs)) { conf.docs = docs; await saveConf(); }
  return items;
}

async function sync() {
  await Bun.$`bun ${path.join(WEB, "kb-build.ts")}`.quiet();
  await ensureWorkspace();
  const names = await kbFiles();
  if (!conf.kbId) {
    const sources = [];
    for (const n of names) sources.push({ source_type: "local_file", file_id: await upload("/semantic-models/local-files/upload", n), file_name: n });
    const d = await api("POST", "/semantic-models/create-with-sources", {
      name: "散会即开工-橙子美妆示例",
      description: "MatrixNEXT 2026 参赛作品「散会即开工」的示例数据:同一个直播代运营项目连开的三场会议(逐字稿、纪要、任务)和任务总表。",
      sources,
    });
    conf.kbId = d.model.id;
    await saveConf();
    console.log(`已创建知识库 ${conf.kbId}`);
  } else {
    // 整批替换:先删旧文档,再传新文档
    for (const s of await listSources()) await api("DELETE", `/semantic-models/${conf.kbId}/sources/${s.row_id}`);
    const sources = [];
    for (const n of names) sources.push({ source_type: "local_file", file_id: await upload(`/semantic-models/${conf.kbId}/local-files/upload`, n), file_name: n });
    await api("POST", `/semantic-models/${conf.kbId}/sources`, { sources });
    console.log(`已替换知识库 ${conf.kbId} 的 ${names.length} 份文档`);
  }
  await waitDone(names.length);
}

const FINISHED = ["ready", "succeeded", "success", "failed", "error"];
const isFailed = (s: any) => ["failed", "error"].includes(String(s.ingest_status));

// 等处理完。处理任务卡在「需要协调」时调用协调接口推一下
async function waitDone(expect: number) {
  for (let i = 0; i < 45; i++) {
    const items = await listSources();
    if (items.length >= expect && items.every((s) => FINISHED.includes(String(s.ingest_status)))) break;
    const jobs = await api("GET", `/semantic-models/${conf.kbId}/source-jobs?page=1&page_size=100`);
    if (jobs.reconcile_required) await api("POST", `/semantic-models/${conf.kbId}/source-jobs/reconcile`);
    await Bun.sleep(10000);
  }
  const items = await status();
  if (items.some(isFailed)) console.log("有文档处理失败,运行 bun web/moi-sync.ts retry 重传");
}

// 失败的先协调再删(不协调会报「仍在处理中」),然后把知识库里缺的文档补传上去
async function retryFailed() {
  const names = await kbFiles();
  await api("POST", `/semantic-models/${conf.kbId}/source-jobs/reconcile`);
  await Bun.sleep(5000);
  for (const s of (await listSources()).filter(isFailed)) {
    for (let i = 0; ; i++) {
      try { await api("DELETE", `/semantic-models/${conf.kbId}/sources/${s.row_id}`); break; }
      catch (e) { if (i >= 5) throw e; await api("POST", `/semantic-models/${conf.kbId}/source-jobs/reconcile`); await Bun.sleep(8000); }
    }
    console.log(`已删除失败的文档:${s.display_name}`);
  }
  const have = new Set((await listSources()).map((s) => s.display_name));
  const sources = [];
  for (const n of names.filter((n) => !have.has(n))) sources.push({ source_type: "local_file", file_id: await upload(`/semantic-models/${conf.kbId}/local-files/upload`, n), file_name: n });
  if (sources.length) { await api("POST", `/semantic-models/${conf.kbId}/sources`, { sources }); console.log(`已补传 ${sources.length} 份`); }
  await waitDone(names.length);
}

const cmd = process.argv[2];
if ((cmd === "status" || cmd === "retry") && !conf.kbId) throw new Error("还没建知识库");
if (cmd === "status") await status();
else if (cmd === "retry") await retryFailed();
else await sync();
