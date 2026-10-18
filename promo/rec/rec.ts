// 录屏框架:无界面 Chrome 逐帧截图 → ffmpeg 合成 1920×1080 / 30fps。
// 画面节奏按帧数算(每帧固定 1/30 秒),截图慢也不影响成片速度;只有等 AI 回答这类真实等待按真实时间截、再加速。
// 画面里的光标和点击光圈是注入页面的元素;弹窗(top layer)打开时光标会挪进弹窗,不会被挡住。
import { Page, sleep } from "./cdp.ts";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

export const W = 1280, H = 720, DPR = 1.5; // 截出来正好 1920×1080
export const SITE = "https://sanhui-kaigong.pages.dev";
const FPS = 30;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9223;

export async function launchChrome() {
  if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true).catch(() => false)) return;
  const dir = "/tmp/sanhui-rec-chrome";
  rmSync(dir, { recursive: true, force: true });
  const proc = Bun.spawn([CHROME, "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required",
    "--force-color-profile=srgb", "--lang=zh-CN", `--window-size=${W},${H}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
  proc.unref(); // 让脚本跑完能自己退出,Chrome 留着给下一段用
  for (let i = 0; i < 50; i++) { await sleep(200); if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true).catch(() => false)) return; }
  throw new Error("Chrome 没起来");
}

const CURSOR_JS = `(() => {
  if (window.__cur) return;
  const c = document.createElement("div");
  c.id = "__cur";
  c.style.cssText = "position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;pointer-events:none;transform:translate(-3px,-2px);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))";
  c.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28"><path d="M4 2l15 11.5-6.6.9 3.9 7.4-3 1.6-3.9-7.5L4 20.5z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const r = document.createElement("div");
  r.id = "__ring";
  r.style.cssText = "position:fixed;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #2563eb;background:rgba(37,99,235,.18);z-index:2147483646;pointer-events:none;opacity:0";
  window.__cur = c; window.__ring = r;
  window.__place = () => { const host = document.querySelector("dialog[open]") || document.body; for (const e of [r, c]) if (e.parentNode !== host) host.appendChild(e); };
  window.__place();
})()`;

type Clip = { x: number; y: number; w: number };

export class Rec {
  p!: Page;
  dir: string;
  frames: { file: string; dur: number }[] = [];
  n = 0;
  cx = W * 0.62; cy = H * 0.55; // 光标位置
  zoom: Clip | null = null;
  constructor(public name: string, public outDir: string) {
    this.dir = path.join("/tmp/sanhui-rec-frames", name);
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
  }

  async open(url = SITE, setup?: (r: Rec) => Promise<void>) {
    await launchChrome();
    this.p = await Page.open(PORT);
    await this.p.device(W, H, DPR, false);
    await this.p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "no-preference" }] });
    await this.p.goto(url);
    // 每段都从干净的演示状态开始(同一个 Chrome 里 localStorage 是共用的)
    await this.p.eval("localStorage.clear()");
    await this.p.goto(url);
    await sleep(2000);
    // 录视频时藏掉给评委看的说明条(网页版仍然有)
    await this.css(".demo-banner{display:none!important}textarea{font-family:-apple-system,\"PingFang SC\",\"Apple Color Emoji\",sans-serif!important}");
    if (setup) await setup(this);
    await this.cursor();
  }
  async css(text: string) { await this.p.eval(`(() => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(text)}; document.head.appendChild(s); })()`); }
  async eval(js: string) { return this.p.eval(js); }
  async cursor() { await this.p.eval(CURSOR_JS); await this.moveCursorTo(this.cx, this.cy); }
  private async moveCursorTo(x: number, y: number) {
    this.cx = x; this.cy = y;
    await this.p.eval(`(() => { window.__place && window.__place(); __cur.style.left = "${x}px"; __cur.style.top = "${y}px"; })()`);
  }

  // 截一帧,dur 秒
  async snap(dur = 1 / FPS) {
    const file = path.join(this.dir, `${String(this.n++).padStart(5, "0")}.jpg`);
    const params: any = { format: "jpeg", quality: 92 };
    if (this.zoom) {
      const h = this.zoom.w * H / W;
      params.clip = { x: this.zoom.x, y: this.zoom.y, width: this.zoom.w, height: h, scale: W / this.zoom.w };
    }
    const r = await this.p.send("Page.captureScreenshot", params);
    writeFileSync(file, Buffer.from(r.data, "base64"));
    this.frames.push({ file, dur });
  }
  async hold(sec: number) { await this.snap(sec); }
  // 按帧做动画:fn(t) t 从 0 到 1
  async anim(sec: number, fn: (t: number) => Promise<void> | void) {
    const n = Math.max(1, Math.round(sec * FPS));
    for (let i = 1; i <= n; i++) { await fn(i / n); await this.snap(); }
  }
  // 真实时间截图(等 AI 这类),speed 倍速
  async real(sec: number, { fps = 6, speed = 1, until }: { fps?: number; speed?: number; until?: () => Promise<boolean> } = {}) {
    const t0 = Date.now();
    while ((Date.now() - t0) / 1000 < sec) {
      const t = Date.now();
      await this.snap(1 / fps / speed);
      if (until && (await until())) break;
      const left = 1000 / fps - (Date.now() - t);
      if (left > 0) await sleep(left);
    }
  }

  // 元素中心(CSS 像素,视口坐标)
  async center(sel: string, nth = 0): Promise<{ x: number; y: number }> {
    const r = await this.p.eval(`(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${nth}]; if (!el) return null; el.scrollIntoView({ block: "nearest" }); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    if (!r) throw new Error(`找不到元素 ${sel} #${nth}`);
    return r;
  }
  async rect(sel: string, nth = 0): Promise<{ x: number; y: number; w: number; h: number }> {
    const r = await this.p.eval(`(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${nth}]; if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
    if (!r) throw new Error(`找不到元素 ${sel} #${nth}`);
    return r;
  }

  // 光标慢慢移过去(缓动),到了停 pause 秒
  async move(x: number, y: number, sec = 0.6, pause = 0.5) {
    const x0 = this.cx, y0 = this.cy;
    const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    await this.anim(sec, async (t) => { const e = ease(t); await this.moveCursorTo(x0 + (x - x0) * e, y0 + (y - y0) * e); });
    await this.p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    if (pause) await this.hold(pause);
  }
  async moveTo(sel: string, nth = 0, sec = 0.6, pause = 0.5) { const c = await this.center(sel, nth); await this.move(c.x, c.y, sec, pause); }
  // 点击:光圈 + 真实鼠标事件
  async click(sel?: string, nth = 0, { sec = 0.6, pause = 0.5, after = 0.4 } = {}) {
    if (sel) await this.moveTo(sel, nth, sec, pause);
    const x = this.cx, y = this.cy;
    await this.p.eval(`(() => { window.__place && window.__place(); __ring.style.left = "${x}px"; __ring.style.top = "${y}px"; __ring.style.opacity = "1"; __ring.style.transform = "scale(.5)"; })()`);
    await this.p.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.p.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await this.anim(0.35, async (t) => { await this.p.eval(`(() => { window.__place && window.__place(); __ring.style.transform = "scale(${0.5 + t})"; __ring.style.opacity = "${1 - t}"; })()`); });
    await this.p.eval(`window.__place && window.__place()`);
    if (after) await this.hold(after);
  }
  // 逐字输入
  async type(text: string, perChar = 0.09) {
    for (const ch of text) { await this.p.send("Input.insertText", { text: ch }); await this.hold(perChar); }
  }
  // 推近 / 拉远到某个区域(CSS 像素,视口坐标);to = null 回到全屏
  async zoomTo(to: Clip | null, sec = 1.2) {
    const from = this.zoom || { x: 0, y: 0, w: W };
    const target = to || { x: 0, y: 0, w: W };
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    await this.anim(sec, (t) => {
      const e = ease(t);
      this.zoom = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, w: from.w + (target.w - from.w) * e };
    });
    if (!to) this.zoom = null;
  }
  // 以某个矩形为中心,推近到宽度 w
  focus(r: { x: number; y: number; w: number; h: number }, w: number): Clip {
    const h = w * H / W;
    const x = Math.min(Math.max(0, r.x + r.w / 2 - w / 2), W - w);
    const y = Math.min(Math.max(0, r.y + r.h / 2 - h / 2), H - h);
    return { x, y, w };
  }

  // 当前时间点(秒),用来记录拆分点和叠加区间
  now() { return this.frames.reduce((s, f) => s + f.dur, 0); }
  marks: Record<string, number> = {};
  mark(name: string) { this.marks[name] = +this.now().toFixed(2); }
  overlays: { png: string; start: number; end: number; x: string; y: string }[] = [];
  overlay(png: string, start: number, end: number, x = "0", y = "0") { this.overlays.push({ png, start, end, x, y }); }

  // 合成 mp4,右上角叠「示例数据」角标,再叠其他图片
  async save(badge = path.join(this.outDir, "字卡", "角标-示例数据.png")) {
    await this.p.close();
    const list = this.frames.map((f) => `file '${f.file}'\nduration ${f.dur.toFixed(4)}`).join("\n") + `\nfile '${this.frames.at(-1)!.file}'\n`;
    const listFile = path.join(this.dir, "list.txt");
    writeFileSync(listFile, list);
    mkdirSync(path.join(this.outDir, "录屏"), { recursive: true });
    const out = path.join(this.outDir, "录屏", `${this.name}.mp4`);
    // 第一步:按固定 30 帧合成底片(直接加滤镜会被图片时间戳取整搞乱节奏)
    const base = path.join(this.dir, "base.mp4");
    const run = (args: string[]) => { const pr = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", ...args]); if (pr.exitCode !== 0) throw new Error("ffmpeg 失败:" + pr.stderr.toString().slice(-400)); };
    run(["-f", "concat", "-safe", "0", "-i", listFile, "-fps_mode", "cfr", "-r", "30", "-vf", "scale=1920:1080:flags=lanczos", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "16", base]);
    // 第二步:叠角标和字卡
    const layers = [...(existsSync(badge) ? [{ png: badge, start: 0, end: 1e9, x: "W-w-24", y: "20" }] : []), ...this.overlays];
    const args = ["-i", base];
    let fc = "[0:v]null[v0]";
    layers.forEach((l, i) => {
      args.push("-loop", "1", "-i", l.png);
      fc += `;[v${i}][${i + 1}:v]overlay=${l.x}:${l.y}:shortest=1:enable='between(t,${l.start},${l.end})'[v${i + 1}]`;
    });
    fc += `;[v${layers.length}]format=yuv420p[o]`;
    args.push("-filter_complex", fc, "-map", "[o]", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-movflags", "+faststart", out);
    run(args);
    const total = this.frames.reduce((s, f) => s + f.dur, 0);
    console.log(`✓ ${this.name}.mp4  ${total.toFixed(1)} 秒  ${this.frames.length} 帧${Object.keys(this.marks).length ? "  时间点 " + JSON.stringify(this.marks) : ""}`);
    return out;
  }
}
export { sleep };
