// Secret drop: a value the owner pastes in, readable by HQ's CLI until its deadline, then gone.
// Values live in this process's memory only. Nothing here writes a value to the database, a log or a listing:
// a listing carries the name, who set it, when, and when it expires. A ledger (secret-ledger.ts) may keep that
// metadata, so a restart that loses the values can say which ones it lost. A planned restart hands the values over
// from process to process (the handover routes below and src/secret-handover.ts), never through a file.
import { timingSafeEqual } from "node:crypto";
import { atText } from "../client/secrets/expiry.js";

export type Clock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
};
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

export type SecretMeta = { name: string; by: string; setAt: number; expiresAt: number };
// A secret with its value, as the handover carries it between two server processes.
export type SecretCarried = SecretMeta & { value: string };
type Entry = SecretCarried & { timer: unknown };
// Told of every name that comes and goes, with metadata only.
export type SecretLedger = { put(m: SecretMeta): void; drop(name: string): void };

export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const BY_RE = /^[\w-]{1,32}$/;
export const MAX_MINUTES = 7 * 24 * 60;
const MAX_VALUE = 64 * 1024;

export function checkName(name: unknown): string {
  const n = String(name ?? "");
  if (!NAME_RE.test(n)) throw new Error("name must be letters, digits and _ (up to 64), starting with a letter or _");
  return n;
}
export function checkMinutes(minutes: unknown): number {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0 || m > MAX_MINUTES) throw new Error(`minutes must be more than 0 and at most ${MAX_MINUTES}`);
  return m;
}
// The error never quotes the value.
export function checkValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("value is empty");
  if (value.length > MAX_VALUE) throw new Error("value is over 64 KB");
  return value;
}

export function createSecretStore(opts: { clock?: Clock; onChange?: () => void; ledger?: SecretLedger } = {}) {
  const clock = opts.clock ?? systemClock;
  const onChange = opts.onChange ?? (() => {});
  let ledger = opts.ledger;
  const items = new Map<string, Entry>();
  const meta = ({ name, by, setAt, expiresAt }: Entry): SecretMeta => ({ name, by, setAt, expiresAt });

  function drop(name: string) {
    const e = items.get(name);
    if (!e) return false;
    clock.clearTimeout(e.timer);
    items.delete(name);
    ledger?.drop(name);
    return true;
  }
  function put(name: string, value: string, by: string, setAt: number, expiresAt: number): SecretMeta {
    drop(name);
    const timer = clock.setTimeout(() => {
      if (items.get(name)?.expiresAt === expiresAt && drop(name)) onChange();
    }, expiresAt - clock.now());
    const e: Entry = { name, by, setAt, expiresAt, value, timer };
    items.set(name, e);
    ledger?.put(meta(e));
    return meta(e);
  }
  // The deadline is checked on every access, so a late or lost timer never lets a value outlive it.
  function live(name: string): Entry | null {
    const e = items.get(name);
    if (!e) return null;
    if (clock.now() >= e.expiresAt) {
      drop(name);
      return null;
    }
    return e;
  }

  return {
    set(name: string, value: string, minutes: number, by: string): SecretMeta {
      checkName(name);
      checkValue(value);
      const m = checkMinutes(minutes);
      if (!BY_RE.test(by)) throw new Error("by must be a short word");
      const setAt = clock.now();
      const out = put(name, value, by, setAt, setAt + Math.round(m * 60_000));
      onChange();
      return out;
    },
    // Puts back what a planned restart handed over, each with its own deadline. Already expired ones are skipped.
    restore(list: unknown): SecretMeta[] {
      if (!Array.isArray(list)) throw new Error("secrets must be a list");
      const now = clock.now();
      const checked = list.map((x: any) => {
        const name = checkName(x?.name);
        const value = checkValue(x?.value);
        const by = String(x?.by ?? "");
        const setAt = Number(x?.setAt), expiresAt = Number(x?.expiresAt);
        if (!BY_RE.test(by)) throw new Error(`${name}: by must be a short word`);
        if (!Number.isFinite(setAt) || !Number.isFinite(expiresAt) || expiresAt > now + MAX_MINUTES * 60_000 + 60_000) throw new Error(`${name}: bad times`);
        return { name, value, by, setAt, expiresAt };
      });
      const out = checked.filter((x) => x.expiresAt > now).map((x) => put(x.name, x.value, x.by, x.setAt, x.expiresAt));
      if (out.length) onChange();
      return out;
    },
    // Text with every live secret's value blanked out as [secret NAME]: for anything shown that the HUD did not write
    // itself, such as an agent's terminal. Values under 4 characters are left alone (they would match everywhere).
    mask(text: string): string {
      let out = text;
      for (const name of [...items.keys()]) live(name);
      for (const e of [...items.values()].sort((a, b) => b.value.length - a.value.length)) {
        if (e.value.length >= 4) out = out.split(e.value).join(`[secret ${e.name}]`);
      }
      return out;
    },
    // Every live secret with its value: for the handover only.
    carry(): SecretCarried[] {
      for (const name of [...items.keys()]) live(name);
      return [...items.values()].map((e) => ({ ...meta(e), value: e.value }));
    },
    size(): number {
      for (const name of [...items.keys()]) live(name);
      return items.size;
    },
    attach(l: SecretLedger) {
      ledger = l;
    },
    get(name: string, once = false): string | null {
      const e = live(name);
      if (!e) return null;
      if (once) {
        drop(name);
        onChange();
      }
      return e.value;
    },
    remove(name: string): boolean {
      const gone = drop(name);
      if (gone) onChange();
      return gone;
    },
    list(): SecretMeta[] {
      for (const name of [...items.keys()]) live(name);
      return [...items.values()].map(meta).sort((a, b) => a.expiresAt - b.expiresAt);
    },
  };
}
export type SecretStore = ReturnType<typeof createSecretStore>;

// ---- who may talk to the secret routes ----

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  return a === "::1" || /^127\.\d+\.\d+\.\d+$/.test(a) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(a);
}

// A request with no Origin is not from a browser page on another site. One with an Origin must be this
// server's own page: Origin equal to http://<Host>, with Host a loopback name or the bound address. That
// also stops a rebound DNS name, whose Host is the attacker's name.
export function originAllowed(req: Request, boundHost: string): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  const host = req.headers.get("host") ?? "";
  if (origin !== `http://${host}`) return false;
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  return LOOPBACK_HOSTS.has(hostname) || hostname === boundHost.toLowerCase();
}

const FORBIDDEN = () => json({ error: "forbidden" }, 403);
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

// Every secret route: from this machine only, never from another origin.
export function secretGuard(req: Request, ip: string | undefined | null, boundHost: string): Response | null {
  if (!isLoopbackAddress(ip)) return FORBIDDEN();
  if (!originAllowed(req, boundHost)) return FORBIDDEN();
  return null;
}

// COPY on the SECRETS tab: the one route that gives a value to a browser, and only to the owner's own page. It has an
// Origin that is this HUD's (on this machine) or one the owner listed in HUD_TRUSTED_ORIGINS (the tailnet, through a
// proxy on this machine), Sec-Fetch-Site same-origin (a browser sets it; another site cannot) and x-hud. A request
// with no Origin is refused: the CLI reads with `hud secret get`. The page asks only on a click, puts the value on
// the clipboard and keeps no copy; it is never in the markup, the state, the log or the database. onCopy logs the name.
async function copyRoute(req: Request, ip: string | undefined | null, store: SecretStore, opts: { host: string; trusted?: string[]; onCopy?: (name: string) => void }): Promise<Response> {
  const origin = req.headers.get("origin");
  const trusted = origin !== null && (opts.trusted ?? []).includes(origin);
  const ownPage = origin !== null && (trusted || originAllowed(req, opts.host));
  if (req.method !== "POST" || !ownPage || (!isLoopbackAddress(ip) && !trusted)) return FORBIDDEN();
  if (req.headers.get("sec-fetch-site") !== "same-origin" || req.headers.get("x-hud") !== "1") return FORBIDDEN();
  const body = await req.json().catch(() => ({}));
  try {
    const name = checkName(body.name);
    const value = store.get(name, false);
    if (value === null) return json({ error: `no secret ${name} (expired, removed or never set)` }, 404);
    opts.onCopy?.(name);
    return json({ value });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}

export const isSecretPath = (path: string) => path === "/api/secrets" || path.startsWith("/api/secrets/");

// A name the ledger knew but this process has no value for: lost when the server restarted.
export type LostSecret = SecretMeta & { lostAt: number };
export type LostBook = { list(): LostSecret[]; get(name: string): LostSecret | null; clear(name: string): boolean };

// When a lost secret's restart was, for messages: "13:45" today, else "yesterday 13:45" or "Mon 2 Nov, 13:45".
export function restartTime(t: number, now = Date.now()): string {
  const said = atText(t, now);
  return said.startsWith("today ") ? said.slice(6) : said;
}
export const lostMessage = (l: LostSecret) => `${l.name} was lost when the server restarted at ${restartTime(l.lostAt)}; ask the owner to set it again`;

// ---- the handover: a planned restart carries the values from the old process to the new one ----
// Only a caller that can read the token file in the data dir (0600, a fresh random token per start) may export or
// import. Import is taken once, by a server that holds no secrets yet, within HANDOVER_WINDOW_MS of its start.

export const HANDOVER_WINDOW_MS = 2 * 60_000;
export function createHandover(opts: { token: string; startedAt: number; clock?: Clock; onImport?: (restored: SecretMeta[]) => void }) {
  const clock = opts.clock ?? systemClock;
  const want = Buffer.from(opts.token);
  let taken = false;
  return {
    allows(given: string | null): boolean {
      const got = Buffer.from(given ?? "");
      return got.length === want.length && want.length > 0 && timingSafeEqual(got, want);
    },
    refusal(store: SecretStore): string | null {
      if (taken) return "this server already took a handover";
      if (clock.now() - opts.startedAt > HANDOVER_WINDOW_MS) return "this server started more than 2 minutes ago";
      if (store.size()) return "this server already holds secrets";
      return null;
    },
    took(restored: SecretMeta[]) {
      taken = true;
      opts.onImport?.(restored);
    },
  };
}
export type Handover = ReturnType<typeof createHandover>;
export const HANDOVER_HEADER = "x-hud-handover";

// GET  /api/secrets          listing (names and times only), lost names last with lostAt
// POST /api/secrets          set {name, value, minutes, by}
// POST /api/secrets/rm       remove {name} (also dismisses a lost name)
// POST /api/secrets/get      read {name, once}: the local CLI only, so no browser page, not even this one
// POST /api/secrets/export   every live secret with its value, for the handover: no browser, and the token
// POST /api/secrets/import   {secrets}: the handover's other half, on a fresh and empty server only
export async function secretRoute(
  req: Request,
  path: string,
  ip: string | undefined | null,
  store: SecretStore,
  opts: { host: string; onSet?: (m: SecretMeta) => void; lost?: LostBook; handover?: Handover; trusted?: string[]; onCopy?: (name: string) => void; onRedact?: (name: string, value: string) => unknown },
): Promise<Response> {
  if (path === "/api/secrets/copy") return copyRoute(req, ip, store, opts);
  const refused = secretGuard(req, ip, opts.host);
  if (refused) return refused;
  if (req.method === "GET" && path === "/api/secrets") return json([...store.list(), ...(opts.lost?.list() ?? [])]);
  if (req.method !== "POST" || req.headers.get("x-hud") !== "1") return FORBIDDEN();
  const browser = req.headers.has("origin") || req.headers.has("sec-fetch-site") || req.headers.has("sec-fetch-mode");
  const body = await req.json().catch(() => ({}));
  try {
    if (path === "/api/secrets") {
      const m = store.set(checkName(body.name), checkValue(body.value), checkMinutes(body.minutes), String(body.by ?? "hq"));
      opts.onSet?.(m);
      return json(m);
    }
    if (path === "/api/secrets/rm") {
      const name = checkName(body.name);
      const removed = store.remove(name);
      const dismissed = opts.lost?.clear(name) ?? false;
      return json({ removed: removed || dismissed });
    }
    // POST /api/secrets/redact {name}: this machine, never a browser (as get). The value stays in the server.
    if (path === "/api/secrets/redact") {
      if (browser || !opts.onRedact) return FORBIDDEN();
      const name = checkName(body.name);
      const value = store.get(name, false);
      if (value === null) return json({ error: `no secret ${name} (expired, removed or never set)` }, 404);
      return json(opts.onRedact(name, value));
    }
    if (path === "/api/secrets/get") {
      if (browser) return FORBIDDEN();
      const name = checkName(body.name);
      const value = store.get(name, body.once === true);
      if (value !== null) return json({ value });
      const lost = opts.lost?.get(name);
      if (lost) return json({ error: lostMessage(lost) }, 410);
      return json({ error: `no secret ${name} (expired, removed or never set)` }, 404);
    }
    if (path === "/api/secrets/export" || path === "/api/secrets/import") {
      const h = opts.handover;
      if (browser || !h || !h.allows(req.headers.get(HANDOVER_HEADER))) return FORBIDDEN();
      if (path === "/api/secrets/export") return json({ secrets: store.carry() });
      const why = h.refusal(store);
      if (why) return json({ error: `handover refused: ${why}` }, 409);
      const restored = store.restore(body.secrets);
      h.took(restored);
      return json({ restored: restored.map((m) => m.name) });
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
  return json({ error: "not found" }, 404);
}
