// THE MONITOR's page (public/monitor.html), read as text and held to its rules: every colour a token, the dark tokens
// given twice and alike, nothing kept in the browser, no markup made from data, and nothing asked of any host but
// this server and the two font hosts. What the page does with data is walked in a browser (test/mobile-walk.ts).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const html = readFileSync(join(import.meta.dir, "..", "..", "public", "monitor.html"), "utf8");
const lines = html.split("\n");
// Where a pattern is found, as "line: text", so a failure says where to look.
const found = (text: string, pattern: RegExp) => text.split("\n").flatMap((line, i) => (pattern.test(line) ? [`${i + 1}: ${line.trim().slice(0, 120)}`] : []));

// The three blocks that define the tokens: light, dark by the screen, dark by data-theme.
const LIGHT = /^:root\{\n([\s\S]*?)\n\}$/m;
const DARK_BY_SCREEN = /^@media \(prefers-color-scheme:dark\)\{:root:where\(:not\(\[data-theme="light"\]\)\)\{\n([\s\S]*?)\n\}\}$/m;
const DARK_BY_THEME = /^:root\[data-theme="dark"\]\{\n([\s\S]*?)\n\}$/m;
const tokensOf = (block: string) => Object.fromEntries([...block.matchAll(/(--[\w-]+):([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

describe("the page as a file", () => {
  test("it says what it is on its first line, and is a whole document in standards mode", () => {
    expect(lines[0]).toMatch(/^<!-- THE MONITOR's page: .+ -->$/);
    expect(lines[1]).toBe("<!doctype html>");
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  test("it names no machine: the name comes with the data", () => {
    expect(html).toContain('<b id="hostname"></b>');
    expect(html.match(/<title>(.*?)<\/title>/)?.[1]).toBe("Resource map");
  });
});

describe("what the page leaves out", () => {
  test("no essay on how it was designed: that is in docs/monitor.md, and neither its markup nor its styles are left", () => {
    expect(found(html, /How this page was designed|Conceptual model|Discoverability|Signifiers|Activity Monitor|iStat|btop|Grafana|Netdata|DaisyDisk/)).toEqual([]);
    expect(found(html, /class="notes"|\.notes\b|<dl>|<dt>|class="hostn"|\.hostn\b/)).toEqual([]);
  });

  test("no paragraph of explanation stands on the page: how to read it opens from one button", () => {
    expect(html).toContain('id="infobtn" aria-expanded="false" aria-controls="info"');
    expect(found(html, /class="says|id="says|class="inst-cap"/)).toEqual([]);
  });

  test("it ends with one line about the monitor itself", () => {
    expect(html).toContain('<footer class="foot"><p id="prov"></p></footer>');
  });
});

describe("a holder's colour is never a state's", () => {
  // The hue of a colour, 0 to 360, and how strong it is.
  const hsl = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
    const h = !d ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: (h * 60 + 360) % 360, s: d ? d / (1 - Math.abs(2 * l - 1)) : 0 };
  };

  test.each([["light", LIGHT], ["dark by the screen", DARK_BY_SCREEN], ["dark by the theme", DARK_BY_THEME]] as const)("%s: none of the seven is red, orange, amber or yellow", (_, block) => {
    const tokens = tokensOf(html.match(block)![1]);
    const slots = [1, 2, 3, 4, 5, 6, 7].map((n) => tokens[`--s${n}`]);
    expect(slots.every((hex) => /^#[0-9a-f]{6}$/.test(hex))).toBe(true);
    // Capped is red and close to the cap is amber: from magenta's edge round to where yellow turns green.
    expect(slots.filter((hex) => hsl(hex).h >= 335 || hsl(hex).h < 66)).toEqual([]);
    expect(new Set(slots).size).toBe(7);
  });

  test("the check itself sees the colours of the states", () => {
    const tokens = tokensOf(html.match(LIGHT)![1]);
    for (const name of ["--warn", "--serious", "--crit"]) expect(hsl(tokens[name]).h >= 335 || hsl(tokens[name]).h < 66).toBe(true);
  });
});

describe("colours", () => {
  test("the three token blocks are there", () => {
    for (const block of [LIGHT, DARK_BY_SCREEN, DARK_BY_THEME]) expect(html.match(block)?.[1].length ?? 0).toBeGreaterThan(200);
  });

  test("no hex, rgb() or hsl() colour outside them", () => {
    const rest = [LIGHT, DARK_BY_SCREEN, DARK_BY_THEME].reduce((text, block) => text.replace(block, (all) => all.replace(/[^\n]/g, "")), html);
    expect(found(rest, /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/i)).toEqual([]);
    expect(found(rest, /\b(?:rgb|hsl)a?\(/i)).toEqual([]);
  });

  test("the check itself sees a colour where there is one", () => {
    expect(found("a{color:#1a2b3c}\nb{fill:#fff}\nc{color:rgba(0,0,0,.5)}\n#app{top:0}", /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/i).map((hit) => hit.split(":")[0])).toEqual(["1", "2"]);
  });

  test("the dark tokens are given twice, for the screen and for the HUD's theme, and are the same", () => {
    const [byScreen, byTheme] = [tokensOf(html.match(DARK_BY_SCREEN)![1]), tokensOf(html.match(DARK_BY_THEME)![1])];
    expect(Object.keys(byScreen).length).toBeGreaterThan(40);
    expect(byTheme).toEqual(byScreen);
  });

  test("every token the dark blocks set is one the light block sets", () => {
    const light = Object.keys(tokensOf(html.match(LIGHT)![1]));
    expect(Object.keys(tokensOf(html.match(DARK_BY_THEME)![1])).filter((name) => !light.includes(name))).toEqual([]);
  });
});

describe("nothing is kept in the browser", () => {
  test("the one thing read is the HUD's theme, and nothing is written", () => {
    expect(html.match(/localStorage\b[^;\n]*/g)).toEqual(['localStorage.getItem("hq-theme")']);
    expect(found(html, /sessionStorage|indexedDB|document\.cookie|\bcaches\b|setItem|removeItem|serviceWorker/)).toEqual([]);
  });
});

describe("no markup is made from data", () => {
  test("the one place that writes markup takes it from the page's own table of icons", () => {
    expect(html.match(/[^\n;{]*innerHTML[^;\n]*/g)?.map((hit) => hit.trim())).toEqual(['w.innerHTML = Object.hasOwn(ICO, s) ? ICO[s] : ""']);
    expect(found(html, /outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|srcdoc|\beval\(|new Function/)).toEqual([]);
  });

  test("that table is fixed text", () => {
    const table = html.match(/^const ICO = \{\n([\s\S]*?)\n\};$/m)?.[1] ?? "";
    expect(table.split("\n").length).toBeGreaterThan(10);
    for (const line of table.split("\n")) expect(line).toMatch(/^  \w+: '<svg [^']*<\/svg>',$/);
  });
});

describe("what the page asks for", () => {
  test("no host but the two font hosts", () => {
    // The SVG namespace is a name, not an address anything is fetched from.
    const hosts = [...html.matchAll(/https?:\/\/([^/"'`\s)]+)/g)].map((m) => m[1]).filter((host) => host !== "www.w3.org");
    expect([...new Set(hosts)].sort()).toEqual(["fonts.googleapis.com", "fonts.gstatic.com"]);
    expect(found(html, /["'`(]\/\/[a-z0-9]/i)).toEqual([]);
  });

  test("its only requests are for the monitor's own routes, and it has no script, frame or image from elsewhere", () => {
    expect(html.match(/fetch\(`[^`]*/g)).toEqual(["fetch(`/api/monitor/page/moment?key=${k}&t=${at}", "fetch(`/api/monitor/page/${p.path}"]);
    expect(html.match(/fetch\(/g)?.length).toBe(2);
    expect(found(html, /<script[^>]*\ssrc=|<iframe|<img|<object|<embed|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\bimport\(/)).toEqual([]);
    expect(html.match(/<link [^>]*>/g)?.every((link) => /href="https:\/\/fonts\.(googleapis|gstatic)\.com/.test(link))).toBe(true);
  });

  test("it is read-only: nothing is posted", () => {
    expect(found(html, /method:\s*["'`](?:POST|PUT|DELETE|PATCH)|<form/i)).toEqual([]);
  });
});
