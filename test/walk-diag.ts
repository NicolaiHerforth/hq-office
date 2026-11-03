// What a walk's last clicks and taps did, for the message of a step that timed out: every mousedown, mouseup and click and the
// element it reached, what was under the point just before and after each press, layout shifts and what moved,
// popstate and hashchange, and the Navigation API's navigations. A click that missed, or a step undone by a late
// navigation, then says so in the run that caught it. The walk's own steps are in it too: named keys (Escape, Enter),
// how the document was loaded (a reload, the browser's back), and did() for a step the page cannot tell from a
// person's (the browser's back or forward sent through CDP), so none of them reads as the page moving by itself.
type Evaluate = (expression: string) => Promise<any>;

const WATCH = `(() => {
  if (window.__walkOn) return;
  window.__walkOn = true;
  const log = window.__walk ??= [], t = () => Math.round(performance.now());
  const name = (n) => !n ? "-" : n.nodeType !== 1 ? name(n.parentElement) : n.tagName.toLowerCase() + (n.id ? "#" + n.id : "")
    + (typeof n.className === "string" && n.className.trim() ? "." + n.className.trim().split(/\\s+/).join(".") : "")
    + ["ref", "qtab", "room"].filter((k) => n.dataset?.[k]).map((k) => "[" + k + "=" + n.dataset[k] + "]").join("");
  window.__walkName = name;
  const add = (e) => { log.push({ t: t(), ...e }); if (log.length > 80) log.shift(); };
  add({ k: "loaded", how: performance.getEntriesByType("navigation")[0]?.type ?? "?" });
  addEventListener("keydown", (e) => { if (e.key.length > 1) add({ k: "key", key: e.key, on: name(e.target) }); }, true);
  for (const k of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"]) document.addEventListener(k, (e) => add({ k, at: [Math.round(e.clientX), Math.round(e.clientY)], on: name(e.target), ...(e.pointerType ? { by: e.pointerType } : {}) }), true);
  for (const k of ["touchstart", "touchend"]) document.addEventListener(k, (e) => add({ k, on: name(e.target) }), true);
  for (const k of ["popstate", "hashchange"]) addEventListener(k, () => add({ k, hash: location.hash }), true);
  // what the page itself went through: errors, messages, being shown and hidden, focus
  addEventListener("error", (e) => add({ k: "error", text: String(e.message ?? e.target?.src ?? e.type).slice(0, 160) }), true);
  addEventListener("unhandledrejection", (e) => add({ k: "unhandledrejection", text: String(e.reason?.message ?? e.reason).slice(0, 160) }));
  addEventListener("message", (e) => add({ k: "message", from: e.origin, keys: e.data && typeof e.data === "object" ? Object.keys(e.data).slice(0, 6).join(",") : typeof e.data }), true);
  for (const k of ["pageshow", "pagehide", "focus", "blur"]) addEventListener(k, () => add({ k }), true);
  document.addEventListener("visibilitychange", () => add({ k: "visibilitychange", state: document.visibilityState }), true);
  const nav = window.navigation;
  if (nav) {
    nav.addEventListener("navigate", (e) => add({ k: "navigate", type: e.navigationType, to: new URL(e.destination.url).hash }));
    for (const k of ["navigatesuccess", "navigateerror"]) nav.addEventListener(k, () => add({ k, hash: location.hash }));
    nav.addEventListener("currententrychange", (e) => add({ k: "currententrychange", type: e.navigationType, hash: location.hash }));
  }
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) add({ k: "shift", v: +e.value.toFixed(3), moved: (e.sources || []).map((s) => name(s.node) + " y" + Math.round(s.previousRect.y) + ">" + Math.round(s.currentRect.y)) }); }).observe({ type: "layout-shift" });
  } catch {}
})(), true`;

// Starts the log in the page now (aimed() does it for a click), so what comes before the first click is in it too.
export const watch = (evaluate: Evaluate) => evaluate(WATCH).catch(() => {});

// A step of the walk's own that the page would log as the browser's doing, given before the step: did(ev, "back").
export const did = (evaluate: Evaluate, what: string) =>
  watch(evaluate).then(() => evaluate(`(window.__walk?.push({ t: Math.round(performance.now()), k: "test", did: ${JSON.stringify(what)} }), true)`)).catch(() => {});

// Before and after a press at (x, y) aimed at what: what is under the point, and whether a navigation is under way.
export async function aimed(evaluate: Evaluate, what: string, x: number, y: number, phase: "aim" | "pressed") {
  await watch(evaluate);
  await evaluate(`(window.__walk && window.__walk.push({ t: Math.round(performance.now()), k: ${JSON.stringify(phase)}, what: ${JSON.stringify(what)}, at: [${Math.round(x)}, ${Math.round(y)}], under: __walkName(document.elementFromPoint(${x}, ${y})), hash: location.hash, navigating: !!window.navigation?.transition }), true)`).catch(() => {});
}

// The log, one line per event, times from its first line; empty when the page kept none (a new document).
export async function clickLog(evaluate: Evaluate, title = "last clicks and navigations") {
  const log: Record<string, unknown>[] | null = await evaluate(`window.__walk ? window.__walk.slice(-40) : null`).catch(() => null);
  if (!log?.length) return "";
  const t0 = log[0].t as number;
  return `\n${title} (ms):\n` + log.map(({ t, k, ...rest }) => `  +${(t as number) - t0} ${k} ${JSON.stringify(rest)}`).join("\n");
}

// A person aims at what has stopped moving (a sheet still growing as its content comes, text a late font widens):
// wait until the first visible match of sel has the same box in two looks 80 ms apart, 3 s at most.
export async function settled(evaluate: Evaluate, sel: string) {
  const box = `JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getClientRects().length)?.getBoundingClientRect() ?? null)`;
  let last = await evaluate(box).catch(() => null);
  for (const end = Date.now() + 3000; Date.now() < end; last = await evaluate(box).catch(() => null)) {
    await Bun.sleep(80);
    if (last !== null && last !== "null" && (await evaluate(box).catch(() => null)) === last) return;
  }
}
