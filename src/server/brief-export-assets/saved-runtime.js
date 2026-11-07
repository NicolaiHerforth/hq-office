// CLASSIC SCRIPT, not a module: what a page gets in a saved copy (src/server/brief-export.ts), first in its <head>. No
// server is behind it. localStorage and sessionStorage work and last while the page is open, in memory only, so a saved
// copy neither reads nor leaves anything in the reader's browser. hud.use and claude.use give null for every name, as
// they do for a page opened outside the HUD, and a line at the bottom of the screen says so. Mermaid diagrams draw.
(() => {
  function makeStorage() {
    const data = new Map();
    const api = {
      get length() { return data.size; },
      key(i) { return [...data.keys()][i] ?? null; },
      getItem(k) { return data.has(String(k)) ? data.get(String(k)) : null; },
      setItem(k, v) { data.set(String(k), String(v)); },
      removeItem(k) { data.delete(String(k)); },
      clear() { data.clear(); },
    };
    const own = new Set(Object.keys(Object.getOwnPropertyDescriptors(api)));
    return new Proxy(api, {
      get: (t, p) => (typeof p === "symbol" || own.has(p) ? Reflect.get(t, p) : t.getItem(p) ?? undefined),
      set: (t, p, v) => { if (typeof p === "symbol" || own.has(p)) return false; t.setItem(p, v); return true; },
      deleteProperty: (t, p) => { if (typeof p !== "symbol" && !own.has(p)) t.removeItem(p); return true; },
      has: (t, p) => own.has(p) || (typeof p === "string" && data.has(p)),
      ownKeys: () => [...data.keys()],
      getOwnPropertyDescriptor: (t, p) => (typeof p === "string" && data.has(p) ? { value: data.get(p), writable: true, enumerable: true, configurable: true } : undefined),
    });
  }
  for (const name of ["localStorage", "sessionStorage"]) {
    try { Object.defineProperty(window, name, { value: makeStorage(), configurable: true, enumerable: true }); } catch {}
  }

  let told = false;
  function tell() {
    if (told) return;
    told = true;
    const show = () => {
      const host = document.createElement("saved-note");
      const root = host.attachShadow({ mode: "closed" });
      root.innerHTML = `<style>div{position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:10px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:8px 8px 8px 12px;border:1px solid CanvasText;border-radius:8px;background:Canvas;color:CanvasText;font:13px/1.35 system-ui,-apple-system,sans-serif}button{min-width:44px;min-height:44px;border:0;background:none;color:inherit;font:inherit;cursor:pointer}@media print{div{display:none}}</style><div role="status"><span>This is a saved copy. Live features of the page, such as saving and sharing, are off.</span><button type="button" aria-label="Dismiss this note">✕</button></div>`;
      root.querySelector("button").addEventListener("click", () => host.remove());
      document.documentElement.append(host);
    };
    if (document.body) show();
    else addEventListener("DOMContentLoaded", show, { once: true });
  }
  const api = Object.freeze({ use: (name) => { tell(); return Promise.resolve(null); } });
  Object.defineProperty(window, "hud", { value: api, configurable: false, enumerable: true, writable: false });
  if (window.claude === undefined) Object.defineProperty(window, "claude", { value: api, configurable: false, enumerable: true, writable: false });

  // The library sits in the file when the page has diagrams, before this script. Without it (the machine that made
  // the file could not fetch it) the diagrams need the internet, as the page does in the HUD.
  const inFile = !!window.mermaid;
  addEventListener("load", () => {
    if (window.mermaid && !inFile) return;
    const todo = [...document.querySelectorAll(".mermaid")].filter((el) => !el.dataset.processed && !el.querySelector("svg"));
    if (!todo.length) return;
    const draw = () => {
      try {
        window.mermaid.initialize({ startOnLoad: false, theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" });
        window.mermaid.run({ nodes: todo }).catch((e) => console.warn("mermaid:", e));
      } catch (e) { console.warn("mermaid:", e); }
    };
    if (inFile) return draw();
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js";
    s.onload = draw;
    document.head.append(s);
  });
})();
