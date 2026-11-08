// An answer changes the screen before it leaves the page: the card goes and the count drops while the POST is still held
// in the page, and the server still has the question open. Once it lands the card stays gone; when it fails the card
// comes back with its words, not as a new question. Steps, not times: it holds the request instead of timing it.
// Needs Chrome; skipped without it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, spawnServer } from "../../scripts/room-hash.ts";
import { chromeDriver } from "./needs-scenes.ts";

setDefaultTimeout(60_000);
const ROOT = join(import.meta.dir, "..", "..");
const RUNS = [
  { name: "phone 390", width: 390, height: 844, touch: true },
  { name: "desktop 1280", width: 1280, height: 800, touch: false },
];
// Answers wait in the page until the test lets them go, or fail there with "offline".
const GATE = `(() => { const f = window.fetch; window.__held = 0; window.__mode = "hold"; window.__gate = Promise.withResolvers();
  window.fetch = async (u, o) => {
    if (!/\\/api\\/asks\\/\\d+\\/answer$/.test(String(u))) return f(u, o);
    if (window.__mode === "fail") return new Response(JSON.stringify({ error: "offline" }), { status: 400 });
    window.__held++; await window.__gate.promise; window.__held--; return f(u, o);
  }; })()`;

for (const run of RUNS) {
  describe.skipIf(!findChrome())(`an answer, ${run.name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "hq-answer-at-once-"));
    let server: Awaited<ReturnType<typeof spawnServer>>, browser: Awaited<ReturnType<typeof chromeDriver>>;
    const ids: number[] = [];
    const ev = (e: string) => browser.driver.ev(e);
    const until = async (e: string, what = e) => { for (let i = 0; i < 100; i++) { if (await ev(e)) return; await Bun.sleep(100); } throw new Error(`never: ${what}`); };
    const openOnServer = async () => ((await (await fetch(`${server.base}/api/state`)).json()).open as { id: number }[]).map((a) => a.id);
    const count = () => ev(`document.querySelector("#sWait .count").textContent`);
    const press = async (id: number) => {
      const at = await ev(`(() => { const b = document.querySelector('#hud [data-ask="${id}"] .send'); b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await until(`!document.documentElement.classList.contains("unready")`);
      await browser.driver.click(at.x, at.y);
    };

    beforeAll(async () => {
      server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HUD_SUBS_HOME: join(dir, "subs"), HERDR_BIN: join(dir, "no-herdr"), HUD_OWNER: "Tester", HUD_GH_BIN: "false" } });
      for (let i = 1; i <= 3; i++) ids.push((await (await fetch(`${server.base}/api/asks`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify({ title: `Do ${i}`, kind: "action" }) })).json()).id);
      browser = await chromeDriver(run.width, run.height, { touch: run.touch });
      await browser.driver.goto(`${server.base}/`);
      await until(`document.querySelectorAll("#hud [data-ask] .send").length === 3`, "three cards");
      await ev(GATE);
      await ev(`window.__back = 0; new MutationObserver((l) => { for (const r of l) for (const n of r.addedNodes) if (n.dataset?.ask === "${ids[0]}") window.__back++; }).observe(document.getElementById("hud"), { childList: true }); 0`);
    }, 60_000);
    afterAll(async () => { await browser?.close(); await server?.stop(); rmSync(dir, { recursive: true, force: true }); });

    test("the card goes and the count drops while the answer is still held in the page", async () => {
      expect(await count()).toBe("3");
      await press(ids[0]);
      await until(`!document.querySelector('#hud [data-ask="${ids[0]}"]')`, "the card left");
      expect(await count()).toBe("2");
      expect(await ev(`window.__held`)).toBe(1);
      expect(await openOnServer()).toContain(ids[0]);
    });

    test("once it lands, the card stays gone and the toast says who has it", async () => {
      await ev(`window.__gate.resolve(), 0`);
      await until(`[...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("HAS IT"))`, "the toast");
      await until(`import("/src/client/core/state.js").then((m) => m.S.answered.some((a) => a.id === ${ids[0]}))`, "the server's push");
      expect(await openOnServer()).not.toContain(ids[0]);
      expect(await ev(`window.__back`)).toBe(0);
      expect(await count()).toBe("2");
    });

    test("when it fails, the card comes back with its words, and not as a new question", async () => {
      await ev(`window.__mode = "fail", 0`);
      await ev(`(() => { const t = document.querySelector('#hud [data-ask="${ids[1]}"] textarea'); t.focus(); return 0; })()`);
      await browser.driver.type("my words");
      await press(ids[1]);
      await until(`[...document.querySelectorAll(".toast")].some((t) => t.textContent === "offline")`, "the failure toast");
      await until(`document.querySelector('#hud [data-ask="${ids[1]}"] textarea')?.value === "my words"`, "the card back with its words");
      expect(await count()).toBe("2");
      expect(await ev(`document.querySelector('#hud [data-ask="${ids[1]}"]').dataset.mark`)).toBe("DRAFT");
      expect(await openOnServer()).toContain(ids[1]);
    });
  });
}
