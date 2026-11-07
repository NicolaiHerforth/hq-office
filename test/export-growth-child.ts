// One case of test/server/export-growth.test.ts, in a process the parent can kill: a search that blows up never comes back,
// so nothing in the parent could stop it. Doubles the input and prints { bytes, ms } per size, the fastest of 3. With no
// argument the file is only the table of cases; nothing is loaded until a case runs. HUD_DATA_DIR must be a throwaway folder.
type Fn = (s: string) => unknown;
type Case = { load: () => Promise<Fn>; build: (k: number) => string };

// The server's modules need one another loaded in this order, as main.ts loads them. A held value, so that every search for
// one runs.
const server = async () => {
  for (const m of ["config", "db", "types", "push", "updates", "events", "herdr", "lanes", "score", "state"]) await import(`../src/server/${m}.ts`);
  (await import("../src/server/push.ts")).secrets.set("GROWN", "FAKE&grown<value>42", 60, "owner");
};
const brief = async (s: string) => {
  await server();
  const { db } = await import("../src/server/db.ts");
  return (db.query("INSERT INTO briefs (floor, at, by, title, body) VALUES ('', 1, 'x', 't', ?) RETURNING id").get(s) as { id: number }).id;
};
const check = async (): Promise<Fn> => { await server(); const { checkExport } = await import("../src/server/brief-export.ts"); return async (s) => checkExport(await brief(s), () => {}); };
const make = async (): Promise<Fn> => { await server(); const { makeExport } = await import("../src/server/brief-export.ts"); return async (s) => makeExport(await brief(s), "html", () => {}); };
const scan = async (): Promise<Fn> => (await import("../src/server/brief-export-scan.ts")).looksLikeKeys;
const spelled = async (): Promise<Fn> => { const { maskSpelled } = await import("../src/server/brief-export-spelled.ts"); return (s) => maskSpelled(s, [{ name: "A", value: "FAKE&grown<value>42" }]); };
const host = async (): Promise<Fn> => (await import("../src/server/brief-export-guard.ts")).plainlyPrivate;

const page = (body: string, head = "") => `<!doctype html><html><head><title>T</title>${head}</head><body>${body}</body></html>`;
const rep = (load: () => Promise<Fn>, unit: string, before = "", after = ""): Case => ({ load, build: (k) => before + unit.repeat(k) + after });
const inPage = (unit: string, before = "", after = ""): Case => ({ load: check, build: (k) => page(before + unit.repeat(k) + after) });
const hash = (i: number) => new Bun.CryptoHasher("sha256").update(String(i)).digest("hex");
const table = (k: number) => page(Array.from({ length: k }, (_, i) => `<tr><td>${hash(i)}</td></tr>`).join(""));

export const CASES: Record<string, Case> = {
  // Addresses, as linkOf reads them.
  "img address, spaces inside": inPage(" ", `<img src="a`, `b">`),
  "link address, spaces inside": inPage(" ", `<a href="a`, `b">y</a>`),
  "frame address, spaces inside": inPage(" ", `<iframe src="a`, `b"></iframe>`),
  "script address, spaces inside": inPage(" ", `<script src="a`, `b"></script>`),
  "address, tabs inside": inPage("\t", `<a href="a`, `b">y</a>`),
  "address, spaces in front": inPage(" ", `<a href="`, `b">y</a>`),
  "address, slashes": inPage("/", `<a href="a`, `b">y</a>`),
  "address, question marks": inPage("?", `<a href="a`, `b">y</a>`),
  "address, percents": inPage("%", `<a href="a`, `b">y</a>`),
  "address, ampersands": inPage("&", `<a href="a`, `b">y</a>`),
  "address, references": inPage("&amp;", `<a href="a`, `b">y</a>`),
  "address, numeric references": inPage("&#", `<a href="a`, `b">y</a>`),
  "https host, dots": inPage(".", `<a href="https://a`, `b/">y</a>`),
  "https host, trailing dots": inPage(".", `<a href="https://a`, `/">y</a>`),
  "https address, dots": inPage(".", `<a href="https://a.example/`, `b">y</a>`),
  "host read by the table, dots": rep(host, ".", "a"),
  "host read by the table, brackets": rep(host, "[", "", "]"),
  // References, as neutral reads them.
  "reference, ending in dots": inPage(".", "<p>#page/rooms/a/files/", "x</p>"),
  "reference, ending in commas": inPage(",", "<p>#page/rooms/a/files/", "x</p>"),
  "reference, punctuation at the end": inPage(".", "<p>#lane/a", " x</p>"),
  "references": inPage("#brief/1 ", "<p>", "</p>"),
  "references, spaced by brackets": inPage("(#brief/1", "<p>", "</p>"),
  "hashes": inPage("#", "<p>", "</p>"),
  "title, references": { load: check, build: (k) => page("x", `<title>${"#brief/1 ".repeat(k)}</title>`) },
  // Styles.
  "style, open addresses": inPage("url(", "<style>", "</style>"),
  "style, open quoted addresses": inPage(`url("`, "<style>", "</style>"),
  "style, open single quotes": inPage("url('", "<style>", "</style>"),
  "style, spaces in an open address": inPage(" ", "<style>a{b:url(", "x}</style>"),
  "style, spaces after an address": inPage(" ", "<style>a{b:url(x", "</style>"),
  "style, spaces in a quoted address": inPage(" ", `<style>a{b:url("a`, `b")}</style>`),
  "style, one long address": inPage("a", "<style>a{b:url(", ")}</style>"),
  "style, one long quoted address": inPage("a", `<style>a{b:url("`, `")}</style>`),
  "style, backslashes": inPage("\\\\", "<style>a{b:url(", "</style>"),
  "style, escaped ends": inPage("\\)", "<style>a{b:url(", "</style>"),
  "style, the same address": inPage("a{b:url(x)}", "<style>", "</style>"),
  "style attribute, open addresses": inPage("url(", `<p style="`, `">x</p>`),
  "style attribute, spaces": inPage(" ", `<p style="url(`, `x">y</p>`),
  // Sets of addresses.
  "srcset, commas": inPage(",", `<img srcset="`, `">`),
  "srcset, spaces": inPage(" ", `<img srcset="`, `">`),
  "srcset, an address then commas": inPage(",", `<img srcset="a.png`, `">`),
  "srcset, commas and spaces": inPage(", ", `<img srcset="`, `">`),
  "srcset, words": inPage("a ", `<img srcset="`, `">`),
  "srcset, the same address": inPage("a.png 1x, ", `<img srcset="`, `">`),
  // Tags.
  "tags, the same link": inPage(`<a href="x">y</a>`),
  "tags, links on the web": inPage(`<a href="https://e.example/">y</a>`),
  "tags, links in the page": inPage(`<a href="#x">y</a>`),
  "tags, pictures": inPage(`<img src="x.png">`),
  "tags, uses": inPage(`<use href="#d"/>`, "<svg>", "</svg>"),
  "tags, inputs": inPage("<input>"),
  "tags, comments": inPage("<!-- x -->"),
  "tags, styled": inPage("<b style=x>"),
  "tags, frames written inside": inPage(`<iframe srcdoc="x"></iframe>`),
  "tags, cards": inPage(`<hud-card ref="#brief/1"></hud-card>`),
  "tags, noscript": inPage("<noscript>x</noscript>"),
  "tags, base": inPage("<base>"),
  "tags, open meta": inPage("<meta "),
  "tags, open script": inPage("<script "),
  "tags, text nodes with a reference": inPage("x<b>", "<p>#lane/x</p>"),
  "tags, a page that starts with comments": rep(check, "<!---->", "", "<!doctype html><title>T</title><p>x"),
  "tags, comments and no doctype": rep(check, "<!---->", "<title>T</title>"),
  // Data addresses.
  "data, the word": inPage("data:"),
  "data, the word in quotes": inPage(`"data:`),
  "data, the word in brackets": inPage("(data:"),
  "data, the word in single quotes": inPage("'data:"),
  "data, no comma": inPage("data:text/plain "),
  "data, a text address with no end": inPage("data:,(", "<p>", "</p>"),
  "data, open text addresses": inPage(`(data:,`, "<p>", "</p>"),
  "data, quoted text addresses": inPage(`"data:,x" `, "<p>", "</p>"),
  "data, svg pictures": inPage(`<img src="data:image/svg+xml,x">`),
  "data, svg pictures of some length": inPage(`<img src="data:image/svg+xml,xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx">`),
  "data, base64 pictures": inPage(`<img src="data:image/png;base64,AAAA">`),
  "data, one long svg": inPage("a", `<img src="data:image/svg+xml,`, `">`),
  "data, one long percent svg": inPage("%3C", `<img src="data:image/svg+xml,`, `">`),
  "data, one long base64 svg": inPage("AAAA", `<img src="data:image/svg+xml;base64,`, `">`),
  "data, bad percents": inPage("%", `<img src="data:image/svg+xml,`, `">`),
  // Scripts, as the import scan reads them.
  "scripts, the word": inPage("<script>import</script>"),
  "scripts, one long text": inPage("import ", "<script>", "</script>"),
  "scripts, one parser refuses": inPage("(", "<script>import(", "</script>"),
  "scripts, import maps": inPage(`<script type="importmap">{}</script>`),
  // The key scan.
  "scan, hashes in a table": { load: scan, build: table },
  "scan, one long run": rep(scan, "a1", "", ""),
  "scan, shapes": rep(scan, "sk-aaaaaaaaaaaaaaaaaaaa1 "),
  "scan, github shapes": rep(scan, "ghp_aaaaaaaaaaaaaaaaaaaa1 "),
  "scan, bearers": rep(scan, "Bearer aaaaaaaaaaaaaaaaaaaaaaaa1 "),
  "scan, bearer spaces": rep(scan, " ", "Bearer", "x"),
  "scan, data words": rep(scan, "data:"),
  "scan, data types": rep(scan, ";a", "data:a"),
  "scan, data run": rep(scan, "a", "data:"),
  "scan, integrity": rep(scan, "sha256-a ", `integrity="`),
  "scan, integrity runs": rep(scan, "sha256-", `integrity="`),
  "scan, integrity spaces": rep(scan, " ", `integrity="`),
  "scan, words": rep(scan, "a word "),
  "scan through the check, hashes in a table": { load: check, build: table },
  // The mask, for what a page spells.
  "spelled, ampersands": rep(spelled, "&"),
  "spelled, references": rep(spelled, "&amp;"),
  "spelled, numeric references": rep(spelled, "&#"),
  "spelled, the value": rep(spelled, "FAKE&amp;grown&lt;value&gt;42 "),
  // A whole file, with what only a make reads.
  "make, the same link": { load: make, build: (k) => page(`<a href="x">y</a>`.repeat(k)) },
  "make, a diagram and open scripts": { load: make, build: (k) => page(`<div class="mermaid">x</div>${"<script ".repeat(k)}`) },
  "make, open classes": { load: make, build: (k) => page(`<div class="${"class= ".repeat(k)}">`) },
  "make, spaces in a viewport": { load: make, build: (k) => page(`<meta name="viewport${" ".repeat(k)}x">`) },
};

if (import.meta.main) {
  const name = process.argv[2], c = CASES[name];
  if (!c) throw new Error(`no case: ${name}`);
  const run = await c.load();
  const FLOOR_MS = Number(process.env.GROWTH_FLOOR_MS ?? 10), DOUBLINGS = Number(process.env.GROWTH_DOUBLINGS ?? 3), MAX_BYTES = Number(process.env.GROWTH_MAX_BYTES ?? 16_000_000);
  let above = 0;
  for (let k = 1; above <= DOUBLINGS; k *= 2) {
    const text = c.build(k);
    if (text.length > MAX_BYTES) break;
    let ms = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      await run(text);
      ms = Math.min(ms, performance.now() - t);
    }
    console.log(JSON.stringify({ bytes: text.length, ms }));
    if (ms >= FLOOR_MS) above++;
  }
  process.exit(0);
}
