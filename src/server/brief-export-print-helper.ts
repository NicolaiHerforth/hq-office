// A PDF of one exported page: a program of its own, started by brief-export-print.ts for one print and gone after it.
// The server never holds Chrome's pipes, so whatever goes wrong here costs one failed PDF, not the HUD. It reads its job
// as JSON on stdin and writes lines of JSON on stdout: { chrome: PID } once Chrome runs, then { pdf, warnings } or { error }.
//
// The page was written by an agent, so it is treated as hostile:
//   it is served once, through the server, with a CSP sandbox and no 'self' (routes/brief-export.ts), never as file://;
//   Chrome runs with its own sandbox on, and is driven over a pipe, so no debugging port exists for a page to find;
//   all of Chrome's connections go through the proxy this starts (brief-export-print-proxy.ts), which is where what may
//   be reached is decided: its one document, and https on public hosts. A navigation of the page itself is answered 204,
//   which leaves the page where it is (a failed one would print Chrome's error page).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plainlyPrivate } from "./brief-export-guard.ts";
import { startProxy } from "./brief-export-print-proxy.ts";

export type PrintJob = { bin: string; printUrl: string; profile: string; title: string; date: string; ink: string; timeoutMs: number; trusted: string[] };

// A4, in inches; the bottom margin leaves room for the line with the title, date and page number. It is at the foot:
// Chrome draws the same line on every sheet, and at the top it would sit right over page 1's own title.
// Portrait is 698 CSS px wide, landscape 1026.
const PAPER = { paperWidth: 8.27, paperHeight: 11.69, marginTop: 0.6, marginBottom: 0.7, marginLeft: 0.5, marginRight: 0.5 };
const WIDTH = { portrait: 698, landscape: 1026 };
// What a sheet holds under its margins, in CSS px.
const HEIGHT = { portrait: 997, landscape: 669 };
// Below this, a portrait page is too small to read: it turns sideways. Below the second, it says so.
const TURN_BELOW = 0.7, WARN_BELOW = 0.6;
// How long a page may go on working after it loaded before the PDF is made without it: what it is still waiting on, and
// whether it is still changing.
const SETTLE_MS = 12_000;

// Everything through the proxy, loopback too; no QUIC, which a proxy cannot see; no name lookups of Chrome's own, since the
// proxy does those. WebRTC's UDP, which a proxy cannot see either, is off in the profile (print, below).
const NETWORK = (proxyPort: number) => [`--proxy-server=http://127.0.0.1:${proxyPort}`, "--proxy-bypass-list=<-loopback>", "--disable-quic", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"];
// Chrome's own calls, on a clean print: its sign-in, its search page, its updater, its optimization hints, the time, and
// what it tells its autofill service about a page with a text box. Each
// of these stops one, measured with the proxy's log; the rest are in the profile (print, below). Anything still asked for
// is refused at the proxy and not named: a page did not ask for it. Together: 0 connections. Chrome will not open port 9
// for anything, so an address there reaches nothing, not even the proxy.
const NOWHERE = "http://127.0.0.1:9/";
const OWN_CALLS = [`--gaia-url=${NOWHERE}`, `--google-base-url=${NOWHERE}`, `--component-updater=url-source=${NOWHERE}`, "--disable-features=OptimizationHints,OptimizationHintsFetching,OptimizationGuideModelDownloading,OptimizationTargetPrediction,OptimizationGuideOnDeviceModel,NetworkTimeServiceQuerying,AutofillServerCommunication"];
const FLAGS = [...OWN_CALLS, "--headless=new", "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--no-pings", "--mute-audio", "--hide-scrollbars", "--force-color-profile=srgb", "--use-mock-keychain", "--password-store=basic", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"];

// Put in the page before its own scripts, so the print knows what it set a timer for: nothing to wait for on a page with
// no timers, and no more than the timer on one that has. A repeating timer is not waited for. Chrome's own way of running a
// page's clock ahead cannot be used: with a repeating timer on the page, the print then never finishes.
const TIMERS = `(() => {
  const pending = new Set(), set = window.setTimeout, clear = window.clearTimeout;
  window.setTimeout = function (fn, ms, ...rest) {
    if (typeof fn !== "function" || Number(ms) > ${SETTLE_MS}) return set.call(window, fn, ms, ...rest);
    const id = set.call(window, function () { pending.delete(id); return fn.apply(this, arguments); }, ms, ...rest);
    pending.add(id);
    return id;
  };
  window.clearTimeout = function (id) { pending.delete(id); return clear.call(window, id); };
  Object.defineProperty(window, "__timersPending", { get: () => pending.size });
})()`;

// Makes the page fit before it prints: what scrolls inside a box would be cut on paper, and could not break across
// sheets, so it opens up; a card that fits on a sheet stays whole; and a table too wide for the sheet is shrunk on its own.
// Returns the width the page still needs.
// A link that would point at this server is cut: it would put the print's address in the PDF.
const fitScript = (width: number, height: number, cut: string[]) => `(() => {
  const open = (el, k, v) => el.style.setProperty(k, v, "important"), cut = new Set(${JSON.stringify(cut)});
  for (const a of document.querySelectorAll("a, area")) {
    const raw = a.getAttribute("href") ?? a.getAttribute("xlink:href");
    if (raw === null) continue;
    let keep = false;
    try {
      const u = new URL(raw, location.href);
      keep = /^(?:mailto|tel):$/.test(u.protocol) || (/^https?:$/.test(u.protocol) && !cut.has(u.hostname) && (u.protocol === "https:" || u.hostname !== location.hostname)) || (raw.startsWith("#") && !!document.getElementById(raw.slice(1)));
    } catch {}
    if (!keep) { a.removeAttribute("href"); a.removeAttribute("xlink:href"); }
  }
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    const tall = /auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
    if (/auto|scroll/.test(cs.overflowX + cs.overflowY)) open(el, "overflow", "visible");
    if (tall) { open(el, "height", "auto"); open(el, "max-height", "none"); }
    const boxed = parseFloat(cs.borderTopWidth) > 0 && parseFloat(cs.borderBottomWidth) > 0 || cs.boxShadow !== "none";
    if (boxed && !/inline$|contents|table/.test(cs.display) && el.getBoundingClientRect().height <= ${height}) el.style.breakInside = "avoid";
  }
  for (const t of document.querySelectorAll("table")) {
    if (t.parentElement.closest("table")) continue;
    t.style.zoom = "";
    const r = t.getBoundingClientRect(), room = ${width} - r.left;
    if (r.width > room && room > 0) t.style.zoom = Math.max(0.55, room / r.width);
  }
  return Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
})()`;
// The hosts the page's links name, as they are now: its scripts may have set them. The guard says which to cut.
const LINK_HOSTS = `[...new Set([...document.querySelectorAll("a, area")].map((a) => { try { return new URL(a.getAttribute("href") ?? a.getAttribute("xlink:href") ?? "", location.href).hostname; } catch { return ""; } }))].filter(Boolean)`;
const WALK = `(async () => {
  const step = Math.max(200, innerHeight);
  for (let y = 0; y < document.documentElement.scrollHeight && y < 60000; y += step) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 30)); }
  scrollTo(0, 0);
  for (const a of document.getAnimations()) { try { a.finish(); } catch {} }
})()`;
const QUIET = `[document.documentElement.outerHTML.length, document.documentElement.scrollHeight, document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity).length].join()`;

// What is hidden in the page and holds real words: an unopened tab, a closed section. Paper shows only what is open.
const HIDDEN = `(() => {
  const skip = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "OPTION", "DATALIST"]), found = [];
  const words = (el) => el.textContent.replace(/\\s+/g, " ").trim();
  const walk = (parent) => {
    for (const el of parent.children) {
      if (skip.has(el.tagName)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") { if (/[\\p{L}\\p{N}]{3}/u.test(words(el))) found.push(words(el)); continue; }
      if (el.tagName === "DETAILS" && !el.open) {
        const text = [...el.childNodes].filter((c) => c.nodeName !== "SUMMARY").map((c) => c.textContent).join(" ").replace(/\\s+/g, " ").trim();
        if (/[\\p{L}\\p{N}]{3}/u.test(text)) found.push(text);
        continue;
      }
      walk(el);
    }
  };
  if (document.body) walk(document.body);
  return found;
})()`;

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const LINE = "font-size:8px;font-family:system-ui,-apple-system,Helvetica,Arial,sans-serif;width:100%;margin:0 0.5in;display:flex;justify-content:space-between;gap:16px;";

// seen: every connection Chrome asked the proxy for, by host, which is how a test measures a clean print.
type Printed = { pdf: string; warnings: string[]; unfinished: boolean; seen: string[] };
const named = (names: string[], most: number) => names.slice(0, most).join(", ") + (names.length > most ? ` and ${names.length - most} more` : "");

const WOULD_NOT_START = "Chrome would not start on this machine. Download the HTML file and print it from your browser.";

async function print(job: PrintJob, say: (line: object) => void): Promise<Printed> {
  const { printUrl, timeoutMs: TIMEOUT_MS } = job;
  const LOAD_MS = Math.min(20_000, TIMEOUT_MS / 2);
  const finish: (() => Promise<void>)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const proxy = await startProxy({ printUrl, trusted: job.trusted });
  // WebRTC's policy is read from the profile: Chrome sends UDP whatever --force-webrtc-ip-handling-policy says. Measured. So
  // are safe browsing's and the preconnects' own calls: without these two prefs, www.gstatic.com and www.google.com.
  mkdirSync(join(job.profile, "Default"), { recursive: true });
  writeFileSync(join(job.profile, "Default", "Preferences"), JSON.stringify({ webrtc: { ip_handling_policy: "disable_non_proxied_udp", multiple_routes_enabled: false, nonproxied_udp_enabled: false }, safebrowsing: { enabled: false }, net: { network_prediction_options: 2 } }));
  finish.push(async () => proxy.close());
  try {
    const proc = spawn(job.bin, [...FLAGS, ...NETWORK(proxy.port), `--user-data-dir=${job.profile}`, "about:blank"], {
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? job.profile, TMPDIR: process.env.TMPDIR ?? "" },
    });
    const exited = new Promise<void>((ok) => { proc.once("exit", () => ok()); proc.once("error", () => ok()); });
    const failed = new Promise<never>((_, no) => {
      proc.once("error", () => no(new Error(WOULD_NOT_START)));
      proc.once("exit", () => no(new Error("Chrome stopped before the PDF was made. Try again. If it keeps happening, this machine may be stopping Chrome's sandbox, which printing always keeps on. Download the HTML file and print it from your browser.")));
    });
    failed.catch(() => {});
    const toChrome = proc.stdio[3] as NodeJS.WritableStream | null, fromChrome = proc.stdio[4] as NodeJS.ReadableStream | null;
    if (!proc.pid || !toChrome || !fromChrome) throw new Error(WOULD_NOT_START);
    say({ chrome: proc.pid });
    finish.push(async () => {
      for (const w of waiting.values()) w.no(new Error("Chrome closed"));
      waiting.clear();
      try { toChrome.write(`${JSON.stringify({ id: ++seq, method: "Browser.close" })}\0`); } catch {}
      await Promise.race([exited, Bun.sleep(3000)]);
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGKILL");
        await Promise.race([exited, Bun.sleep(2000)]);
      }
    });
    const late = new Promise<never>((_, no) => {
      timer = setTimeout(() => no(new Error(`The page was not ready to print after ${Math.round(TIMEOUT_MS / 1000)} seconds, so it was stopped. Download the HTML file instead, or ask the page's author to fix it.`)), TIMEOUT_MS);
    });
    late.catch(() => {});

    let seq = 0;
    const waiting = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
    const events: ((m: any) => void)[] = [];
    const receive = (text: string) => {
      let m: any;
      try { m = JSON.parse(text); } catch { return; }
      const w = m.id ? waiting.get(m.id) : null;
      if (w) {
        waiting.delete(m.id);
        m.error ? w.no(new Error(m.error.message)) : w.ok(m.result);
      } else for (const fn of events) fn(m);
    };
    toChrome.on?.("error", () => {});
    fromChrome.on?.("error", () => {});
    fromChrome.setEncoding("utf8");
    // A big PDF comes in thousands of chunks: each is searched once, never what came before it.
    const parts: string[] = [];
    fromChrome.on("data", (chunk: string) => {
      let from = 0;
      for (let i = chunk.indexOf("\0"); i >= 0; i = chunk.indexOf("\0", from)) {
        parts.push(chunk.slice(from, i));
        receive(parts.join(""));
        parts.length = 0;
        from = i + 1;
      }
      parts.push(chunk.slice(from));
    });
    const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((ok, no) => {
      const id = ++seq;
      waiting.set(id, { ok, no });
      toChrome.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    });

    const work = async (): Promise<Printed> => {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const s = (method: string, params: object = {}) => send(method, params, sessionId);
      const ev = async (expression: string, awaitPromise = false) => (await s("Runtime.evaluate", { expression, awaitPromise, returnByValue: true })).result?.value;

      let served = false;
      const inFlight = new Set<string>();
      const blocked = new Set<string>(), unloaded = new Set<string>();
      const hostOf = (u: string) => { try { return new URL(u).host || u.slice(0, 40); } catch { return u.slice(0, 40); } };
      const LEFT = new Error("The page tried to go somewhere else while it was being printed, so the PDF was stopped. Download the HTML file instead.");
      let left = false, moved: (e: Error) => void = () => {};
      const away = new Promise<never>((_, no) => { moved = no; });
      away.catch(() => {});
      let loaded: () => void = () => {};
      const load = new Promise<void>((ok) => { loaded = ok; });
      const urls = new Map<string, string>();
      events.push((m) => {
        if (m.sessionId !== sessionId) return;
        const p = m.params;
        if (m.method === "Fetch.requestPaused") {
          const { requestId, request: { url }, resourceType } = p;
          if (resourceType === "Document" && url === printUrl && !served) { served = true; s("Fetch.continueRequest", { requestId }).catch(() => {}); return; }
          if (url !== printUrl) blocked.add(hostOf(url));
          s("Fetch.fulfillRequest", { requestId, responseCode: 204 }).catch(() => {});
        } else if (m.method === "Network.requestWillBeSent") {
          // A worker's own blob is asked for and never said to have ended, and nothing is waited on for it.
          if (!p.request.url.startsWith("blob:")) inFlight.add(p.requestId);
          urls.set(p.requestId, p.request.url);
        } else if (m.method === "Network.loadingFinished") inFlight.delete(p.requestId);
        else if (m.method === "Network.loadingFailed") {
          inFlight.delete(p.requestId);
          const u = urls.get(p.requestId) ?? "";
          if (p.errorText !== "net::ERR_BLOCKED_BY_CLIENT" && /^https:/i.test(u)) unloaded.add(hostOf(u));
        } else if (m.method === "Page.loadEventFired") loaded();
        else if (m.method === "Page.frameNavigated" && !p.frame.parentId && p.frame.url !== printUrl) { left = true; moved(LEFT); }
      });
      await s("Page.enable");
      await s("Network.enable");
      await s("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document" }] });
      await s("Emulation.setEmulatedMedia", { media: "print", features: [{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "reduce" }] });
      const size = (width: number) => s("Emulation.setDeviceMetricsOverride", { width, height: 1040, deviceScaleFactor: 2, mobile: false });
      await size(WIDTH.portrait);

      const ready = (async (): Promise<Printed> => {
        const started = Date.now();
        await s("Page.addScriptToEvaluateOnNewDocument", { source: TIMERS });
        await s("Page.navigate", { url: printUrl });
        await Promise.race([load, Bun.sleep(LOAD_MS)]);
        await ev(`Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))])`, true);
        // A chart on a canvas animates with no sign in the document.
        if (await ev(`!!document.querySelector("canvas")`)) await Bun.sleep(Math.max(0, 1300 - (Date.now() - started)));
        // Quiet: nothing on the network and the document not changing. It waits on past that for a timer the page set,
        // but a timer alone at the end is no sign of anything unfinished: it may be a poll that sets the next one.
        const settle = async (ms: number) => {
          let last = "", same = 0, timers = 0;
          for (const end = Date.now() + ms; Date.now() < end && (same < 3 || timers > 0); await Bun.sleep(200)) {
            const now = String(await ev(QUIET));
            same = now === last && inFlight.size === 0 ? same + 1 : 0;
            last = now;
            timers = Number(await ev(`window.__timersPending ?? 0`));
          }
          return same >= 3;
        };
        const settled = await settle(SETTLE_MS);
        // Hidden on a screen too: what a page hides only from paper, it means to.
        await s("Emulation.setEmulatedMedia", { media: "screen" });
        const hidden = (await ev(HIDDEN)) as string[];
        await s("Emulation.setEmulatedMedia", { media: "print", features: [{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "reduce" }] });
        const fit = async (width: number, height: number) => ev(fitScript(width, height, ((await ev(LINK_HOSTS)) as string[]).filter((host) => plainlyPrivate(host, job.trusted))));
        await fit(WIDTH.portrait, HEIGHT.portrait);
        await ev(WALK, true);
        await settle(1500);

        let landscape = false, scale = 1;
        let needs = Number(await fit(WIDTH.portrait, HEIGHT.portrait));
        if (needs > WIDTH.portrait) {
          scale = WIDTH.portrait / needs;
          if (scale < TURN_BELOW) {
            landscape = true;
            await size(WIDTH.landscape);
            await Bun.sleep(150);
            needs = Number(await fit(WIDTH.landscape, HEIGHT.landscape));
            scale = Math.min(1, WIDTH.landscape / needs);
          }
        }
        // Without a title Chrome names the PDF after the address, which holds this machine's port and the print token.
        await ev(`if (!document.title.trim()) document.title = ${JSON.stringify(job.title)}`);
        const { data } = await s("Page.printToPDF", {
          ...PAPER,
          landscape,
          scale: Math.max(0.1, Number(scale.toFixed(3))),
          printBackground: true,
          preferCSSPageSize: false,
          generateTaggedPDF: true,
          generateDocumentOutline: true,
          displayHeaderFooter: true,
          headerTemplate: "<span></span>",
          footerTemplate: `<div style="${LINE}color:${job.ink}"><span style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${escHtml(job.title)}</span><span style="white-space:nowrap">${escHtml(job.date)} · <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
        });
        const warnings: string[] = [];
        if (!settled) warnings.push("The page was still changing when the time ran out, so this PDF may be unfinished. Look through it before you send it, or send the HTML file.");
        if (hidden.length) warnings.push(`Part of this page is hidden, so it is not in the PDF: ${hidden.slice(0, 3).map((t) => `"${t.slice(0, 40)}${t.length > 40 ? "…" : ""}"`).join(", ")}${hidden.length > 3 ? ` and ${hidden.length - 3} more` : ""}. This is usually a tab or section nobody opened. The HTML file keeps it.`);
        if (scale < WARN_BELOW) warnings.push(`The page is much wider than a sheet, so the PDF shows it at ${Math.round(scale * 100)}%.`);
        const refused = new Set([...blocked, ...proxy.refused]);
        const missed = [...unloaded].filter((host) => !refused.has(host));
        if (missed.length) warnings.push(`Not loaded while printing, so it may be missing from the PDF: ${named(missed, 5)}.`);
        if (refused.size) warnings.push(`The page asked for things a printed copy may not reach, and they were refused: ${named([...refused], 5)}.`);
        return { pdf: data, warnings, unfinished: !settled, seen: proxy.seen };
      })();
      try {
        return await Promise.race([ready, away]);
      } catch (e) {
        if (e === LEFT) throw e;
        // A page that leaves can break a call before Chrome says it left. Chrome's own words mean nothing to the owner.
        await Bun.sleep(300);
        if (left) throw LEFT;
        throw new Error(`Chrome could not print this page (${(e as Error).message}). Download the HTML file instead.`);
      }
    };

    return await Promise.race([work(), failed, late]);
  } finally {
    clearTimeout(timer);
    for (const fn of finish) await fn();
  }
}

const say = (line: object) => { process.stdout.write(`${JSON.stringify(line)}\n`); };
const job = JSON.parse(await Bun.stdin.text()) as PrintJob;
const answer = await print(job, say).catch((e: Error) => ({ error: e.message }));
// Written through to the end before it exits: a PDF is far larger than a pipe holds.
await new Promise<void>((done) => { process.stdout.write(`${JSON.stringify(answer)}\n`, () => done()); });
process.exit(0);
