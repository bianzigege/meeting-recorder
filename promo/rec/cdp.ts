// Minimal CDP client for headless Chrome (bun). Usage: import { Page } from "./cdp.ts"
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export class Page {
  ws!: WebSocket; id = 0; pend = new Map<number, [Function, Function]>(); events: ((m: any) => void)[] = [];
  static async open(port = 9222) {
    const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
    const t = await r.json();
    const p = new Page();
    p.ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise(res => p.ws.onopen = res);
    p.ws.onmessage = ev => {
      const m = JSON.parse(String(ev.data));
      if (m.id && p.pend.has(m.id)) { const [ok, ko] = p.pend.get(m.id)!; p.pend.delete(m.id); m.error ? ko(new Error(JSON.stringify(m.error))) : ok(m.result); }
      else p.events.forEach(f => f(m));
    };
    await p.send("Page.enable"); await p.send("Runtime.enable");
    return p;
  }
  send(method: string, params: any = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((ok, ko) => { this.pend.set(id, [ok, ko]); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async device(w: number, h: number, dpr: number, mobile = true) {
    await this.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dpr, mobile, screenWidth: w, screenHeight: h });
    if (mobile) await this.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  }
  async goto(url: string, timeout = 10000) {
    // Hash-only navigations never fire load, so always go through about:blank first.
    const cur = await this.eval("location.href").catch(() => "");
    if (cur && cur !== "about:blank" && cur.split("#")[0] === url.split("#")[0]) { await this.send("Page.navigate", { url: "about:blank" }); await sleep(100); }
    let done = false;
    const loaded = new Promise<void>(res => { const f = (m: any) => { if (m.method === "Page.loadEventFired") { done = true; res(); this.events = this.events.filter(x => x !== f); } }; this.events.push(f); });
    await this.send("Page.navigate", { url });
    await Promise.race([loaded, sleep(timeout)]);
    if (!done) console.warn("goto: load timeout", url);
  }
  async eval(js: string): Promise<any> {
    const r = await this.send("Runtime.evaluate", { expression: js, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception?.description));
    return r.result?.value;
  }
  async shot(path: string, opts: any = {}) {
    const r = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, ...opts });
    await Bun.write(path, Buffer.from(r.data, "base64"));
  }
  async close() { this.ws.close(); }
}

