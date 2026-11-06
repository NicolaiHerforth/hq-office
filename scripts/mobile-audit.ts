// Every surface at three phone sizes and both themes, on a throwaway server: a screenshot of each and results.json with
// what spills, cut text, targets under 44 px, unequal edges, boxes nested too deep and low contrast.
//   bun scripts/mobile-audit.ts --out DIR [--root TREE] [--only a,b] [--phones 390,360] [--themes dark]
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startChrome } from "./room-hash.ts";
import { AUDIT, MEASURE, PHONES, SURFACES, openPhone, openSurface, startOffice } from "../test/mobile-walk.ts";

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : ""; };
const list = (k: string) => arg(k) ? arg(k).split(",") : null;
const out = arg("out");
if (!out) throw new Error("--out DIR is required");
mkdirSync(out, { recursive: true });
const only = list("only"), widths = list("phones");

const chrome = await startChrome();
const office = await startOffice(arg("root") || resolve(import.meta.dir, ".."));
const tab = await openPhone(chrome, []);
const results: object[] = [];
for (const theme of list("themes") ?? ["light", "dark"]) for (const phone of PHONES.filter((p) => !widths || widths.includes(String(p.width)))) {
  await tab.size(phone);
  for (const s of SURFACES.filter((x) => !only || only.includes(x.name))) {
    const id = `${s.name}-${phone.width}-${theme}`;
    try {
      await openSurface(tab, office, { ...s, stored: { ...s.stored, "hq-theme": theme } });
      const m = await tab.ev(MEASURE), a = await tab.ev(AUDIT);
      for (const [name, full] of [[`${id}.png`, false], [`${id}-full.png`, true]] as const) {
        const { data } = await tab.s("Page.captureScreenshot", { format: "png", captureBeyondViewport: full });
        writeFileSync(join(out, name), Buffer.from(data, "base64"));
      }
      results.push({ id, surface: s.name, width: phone.width, theme, ok: true, ...m, ...a });
      console.log(id, "scrollW", m.scrollW, "spills", m.spills.length, "taps", a.taps.length);
    } catch (e) {
      results.push({ id, surface: s.name, width: phone.width, theme, ok: false, error: String(e) });
      console.log(id, "FAILED", String(e).slice(0, 200));
    }
  }
}
writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 1));
await tab.s("Page.navigate", { url: "about:blank" });
await office.stop();
await chrome.close();
process.exit(0);
