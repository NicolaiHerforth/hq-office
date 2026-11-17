// Secret drop. Every server here is a throwaway one on a spare port with a temporary data dir; the CLI is always
// pointed at it through HUD_URL. Values are obviously fake.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../scripts/room-hash.ts";
import { createSecretStore, isSecretPath, secretRoute, type Clock } from "../src/server/secrets.ts";

const ROOT = join(import.meta.dir, "..");

function fakeClock(start: number) {
  let t = start;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  const clock: Clock = {
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimeout: (id) => {
      timers = timers.filter((x) => x.id !== id);
    },
  };
  return {
    clock,
    // Moves time on. Timers fire only when asked, so a test can prove the deadline holds without them.
    advance(ms: number, fire = false) {
      t += ms;
      if (!fire) return;
      const due = timers.filter((x) => x.at <= t);
      timers = timers.filter((x) => x.at > t);
      for (const x of due) x.fn();
    },
    pending: () => timers.length,
  };
}

async function cli(base: string, args: string[], stdin?: string) {
  const proc = Bun.spawn([process.execPath, join(ROOT, "hud.ts"), ...args], {
    env: { ...process.env, HUD_URL: base },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

// ---- a) set, read through a pipe, expire: real CLI, real secret routes, fake clock ----

describe("a) set, pipe read, expiry on a fake clock", () => {
  const fake = fakeClock(Date.now());
  let changes = 0;
  const store = createSecretStore({ clock: fake.clock, onChange: () => changes++ });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, s) {
      const path = new URL(req.url).pathname;
      if (!isSecretPath(path)) return new Response("not found", { status: 404 });
      return secretRoute(req, path, s.requestIP(req)?.address, store, { host: "127.0.0.1" });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  afterAll(() => server.stop(true));
  const VALUE = "TEST_ONLY_VALUE_123";

  test("readable through a pipe until the deadline, then gone from reads and listings", async () => {
    const set = await cli(base, ["secret", "set", "TEST_KEY_A", "--minutes", "5"], VALUE + "\n");
    expect(set.code).toBe(0);
    expect(set.out + set.err).not.toContain(VALUE);

    const read = await cli(base, ["secret", "get", "TEST_KEY_A"]);
    expect(read.code).toBe(0);
    expect(read.out).toBe(VALUE);

    const listed = await cli(base, ["secret", "list"]);
    expect(listed.out).toContain("TEST_KEY_A");
    expect(listed.out).not.toContain(VALUE);

    fake.advance(5 * 60_000 - 1);
    expect((await cli(base, ["secret", "get", "TEST_KEY_A"])).out).toBe(VALUE);

    // At the deadline, with the expiry timer deliberately not fired.
    fake.advance(1);
    const late = await cli(base, ["secret", "get", "TEST_KEY_A"]);
    expect(late.code).not.toBe(0);
    expect(late.out).toBe("");
    expect(late.err).not.toContain(VALUE);
    expect((await cli(base, ["secret", "list"])).out).not.toContain("TEST_KEY_A");
    expect(await (await fetch(`${base}/api/secrets`)).json()).toEqual([]);
  });

  test("the timer alone removes it at the deadline", () => {
    store.set("TEST_KEY_T", "TEST_ONLY_VALUE_TIMER", 1, "hq");
    const before = changes;
    fake.advance(60_000, true);
    expect(changes).toBe(before + 1);
    expect(store.list()).toEqual([]);
    expect(fake.pending()).toBe(0);
  });
});

// ---- b) to e): the real server.ts, restarted once ----

let BASE = "";
const DATA = mkdtempSync(join(tmpdir(), "hq-office-secret-"));
const LOG = join(DATA, "server.log");
const PROMPTS = join(DATA, "herdr-prompts.log");
let server: Awaited<ReturnType<typeof spawnServer>> | null = null;

// A stand-in herdr: no agents, and every prompt to HQ lands in a file the grep test searches too.
const HERDR = join(DATA, "fake-herdr");
writeFileSync(HERDR, `#!/bin/sh\nif [ "$2" = "list" ]; then echo '{"result":{"agents":[]}}'; else printf '%s\\n' "$*" >> '${PROMPTS}'; fi\n`);
chmodSync(HERDR, 0o755);

// Both of the server's streams go to one log file, as under launchd.
async function startServer() {
  server = await spawnServer({
    cwd: ROOT,
    env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: HERDR, HUD_LOCAL_MACHINE: "local", HUD_MACHINES: "local" },
    out: (chunk) => writeFileSync(LOG, chunk, { flag: "a" }),
  });
  BASE = server.base;
}
async function stopServer() {
  await server?.stop();
  server = null;
}

beforeAll(startServer);
afterAll(async () => {
  await stopServer();
  rmSync(DATA, { recursive: true, force: true });
});

const hud = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...headers }, body: JSON.stringify(body) });

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

test("b) a value appears in no database file, log, prompt, listing or state response", async () => {
  const VALUE = "TEST_ONLY_VALUE_GREP_456";
  const ASK_VALUE = "TEST_ONLY_VALUE_GREP_ASK_789";
  const seen: string[] = [];
  const keep = async (res: Response) => {
    const text = await res.text();
    seen.push(text);
    return text;
  };

  expect((await cli(BASE, ["secret", "set", "TEST_KEY_GREP", "--minutes", "30"], VALUE)).code).toBe(0);
  const read = await cli(BASE, ["secret", "get", "TEST_KEY_GREP"]);
  expect(read.out).toBe(VALUE);
  const listed = await cli(BASE, ["secret", "list"]);
  seen.push(listed.out, listed.err);
  expect(listed.out).toContain("TEST_KEY_GREP");

  const asked = await cli(BASE, ["ask", "--lane", "test-lane", "--title", "Need a test key", "--secret", "TEST_KEY_ASK"]);
  const id = Number(asked.out.match(/#(\d+)/)![1]);
  const state = JSON.parse(await keep(await fetch(`${BASE}/api/state`)));
  expect(state.open.find((a: any) => a.id === id).secrets).toEqual(["TEST_KEY_ASK"]);
  expect(state.secrets.map((s: any) => s.name)).toEqual(["TEST_KEY_GREP"]);
  expect(Object.keys(state.secrets[0]).sort()).toEqual(["by", "expiresAt", "name", "setAt"]);

  const answered = await hud(`/api/asks/${id}/secrets`, { values: { TEST_KEY_ASK: ASK_VALUE }, minutes: 10, note: "here you go" });
  expect(answered.status).toBe(200);
  await keep(answered);
  expect((await cli(BASE, ["secret", "get", "TEST_KEY_ASK"])).out).toBe(ASK_VALUE);

  const inbox = JSON.parse(await keep(await fetch(`${BASE}/api/inbox`)));
  const answer = inbox.answers.find((a: any) => a.id === id).answer;
  expect(answer).toContain("TEST_KEY_ASK");
  await keep(await fetch(`${BASE}/api/state`));
  await keep(await fetch(`${BASE}/api/secrets`));
  await keep(await fetch(`${BASE}/api/machines`));
  await keep(await fetch(`${BASE}/`));

  // HQ hears of the answer through the stand-in herdr, a process the server starts and does not wait for.
  for (const end = Date.now() + 10_000; Date.now() < end && !(existsSync(PROMPTS) && readFileSync(PROMPTS, "utf8").includes("TEST_KEY_ASK")); ) await Bun.sleep(50);
  await stopServer();
  await startServer();
  // A restart without the plugin's handover loses every value; the names stay, listed as lost.
  const after = await (await fetch(`${BASE}/api/secrets`)).json();
  expect(after.map((x: any) => [x.name, !!x.lostAt]).sort()).toEqual([["TEST_KEY_ASK", true], ["TEST_KEY_GREP", true]]);
  expect((await cli(BASE, ["secret", "get", "TEST_KEY_GREP"])).code).not.toBe(0);
  await keep(await fetch(`${BASE}/api/state`));
  await keep(await fetch(`${BASE}/api/inbox`));
  seen.push((await cli(BASE, ["secret", "list"])).out);

  const files = filesUnder(DATA);
  expect(files.some((f) => f.endsWith("hud.db"))).toBe(true);
  expect(files).toContain(LOG);
  // The ledger's table and the handover token are searched like everything else.
  expect(files).toContain(join(DATA, "secret-handover.token"));
  expect(files.filter((f) => f.includes("hud.db")).some((f) => readFileSync(f).toString("latin1").includes("TEST_KEY_GREP"))).toBe(true);
  expect(readFileSync(PROMPTS, "utf8")).toContain("TEST_KEY_ASK");
  for (const f of files) {
    const bytes = readFileSync(f).toString("latin1");
    expect({ f, hit: bytes.includes(VALUE) }).toEqual({ f, hit: false });
    expect({ f, hit: bytes.includes(ASK_VALUE) }).toEqual({ f, hit: false });
  }
  for (const text of seen) {
    expect(text).not.toContain(VALUE);
    expect(text).not.toContain(ASK_VALUE);
  }
});

test("c) get refuses a terminal and prints no value", async () => {
  const VALUE = "TEST_ONLY_VALUE_TTY_321";
  await cli(BASE, ["secret", "set", "TEST_KEY_TTY", "--minutes", "5"], VALUE);
  // script(1) runs the CLI with a pseudo-terminal as stdout.
  const cmd = [process.execPath, join(ROOT, "hud.ts"), "secret", "get", "TEST_KEY_TTY"];
  const args = process.platform === "darwin" ? ["script", "-q", "/dev/null", ...cmd] : ["script", "-qec", cmd.join(" "), "/dev/null"];
  const proc = Bun.spawn(args, { env: { ...process.env, HUD_URL: BASE }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  expect(out + err).toContain("refusing to print secret TEST_KEY_TTY to a terminal");
  expect(out + err).not.toContain(VALUE);
  // The refusal happens before any request, so the value is still there for a pipe.
  expect((await cli(BASE, ["secret", "get", "TEST_KEY_TTY"])).out).toBe(VALUE);
});

test("d) --once deletes the secret on read", async () => {
  const VALUE = "TEST_ONLY_VALUE_ONCE_654";
  await cli(BASE, ["secret", "set", "TEST_KEY_ONCE", "--minutes", "5"], VALUE);
  const first = await cli(BASE, ["secret", "get", "TEST_KEY_ONCE", "--once"]);
  expect(first.out).toBe(VALUE);
  const second = await cli(BASE, ["secret", "get", "TEST_KEY_ONCE"]);
  expect(second.code).not.toBe(0);
  expect(second.out).toBe("");
  expect((await cli(BASE, ["secret", "list"])).out).not.toContain("TEST_KEY_ONCE");
});

test("e) a foreign Origin is refused on the secret routes", async () => {
  const VALUE = "TEST_ONLY_VALUE_ORIGIN_987";
  const foreign = { origin: "http://evil.example" };
  expect((await hud("/api/secrets", { name: "TEST_KEY_ORIGIN", value: VALUE, minutes: 5 }, foreign)).status).toBe(403);
  expect((await fetch(`${BASE}/api/secrets`, { headers: foreign })).status).toBe(403);
  expect((await fetch(`${BASE}/api/state`, { headers: foreign })).status).toBe(403);
  expect(await (await fetch(`${BASE}/api/secrets`)).json()).toEqual(expect.not.arrayContaining([expect.objectContaining({ name: "TEST_KEY_ORIGIN" })]));

  // The page's own origin may set one, the way the SECRETS form does.
  const own = { origin: BASE };
  expect((await hud("/api/secrets", { name: "TEST_KEY_ORIGIN", value: VALUE, minutes: 5, by: "owner" }, own)).status).toBe(200);
  for (const headers of [foreign, own, { "sec-fetch-site": "same-origin" }]) {
    const res = await hud("/api/secrets/get", { name: "TEST_KEY_ORIGIN" }, headers);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(VALUE);
  }
  expect((await hud("/api/secrets/rm", { name: "TEST_KEY_ORIGIN" }, foreign)).status).toBe(403);
  // A rebound DNS name: Origin matches Host, but Host is not this machine.
  const rebound = await hud("/api/secrets/get", { name: "TEST_KEY_ORIGIN" }, { origin: `http://rebound.example:${server!.port}`, host: `rebound.example:${server!.port}` });
  expect(rebound.status).toBe(403);
  // Without the x-hud header the read is refused too.
  const bare = await fetch(`${BASE}/api/secrets/get`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "TEST_KEY_ORIGIN" }) });
  expect(bare.status).toBe(403);
  // Still there for the CLI, which sends no Origin.
  expect((await cli(BASE, ["secret", "get", "TEST_KEY_ORIGIN"])).out).toBe(VALUE);
  expect((await cli(BASE, ["secret", "rm", "TEST_KEY_ORIGIN"])).code).toBe(0);
  expect((await cli(BASE, ["secret", "get", "TEST_KEY_ORIGIN"])).code).not.toBe(0);
});

test("set refuses a value given as an argument", async () => {
  const r = await cli(BASE, ["secret", "set", "TEST_KEY_ARG", "TEST_ONLY_VALUE_ARG", "--minutes", "5"]);
  expect(r.code).toBe(2);
  expect(r.err).toContain("read from stdin");
  expect((await cli(BASE, ["secret", "list"])).out).not.toContain("TEST_KEY_ARG");
});

// A secret that expires is a change even when an access finds it expired before its timer fires: the access drops it
// and clears the timer, and what was masked with it must be made again (push.ts secretsGen; the review's fix 4).
test("a secret an access finds expired counts as a change, once", async () => {
  const fake = fakeClock(1_000_000);
  let changes = 0;
  const store = createSecretStore({ clock: fake.clock, onChange: () => changes++ });
  store.set("TEST_KEY_GONE", "TEST_ONLY_GONE_VALUE", 1, "owner");
  expect(changes).toBe(1);
  expect(store.mask("say TEST_ONLY_GONE_VALUE")).toBe("say [secret TEST_KEY_GONE]");
  // Past the deadline, the timer not yet run: the next access drops it.
  fake.advance(61_000);
  expect(store.mask("say TEST_ONLY_GONE_VALUE")).toBe("say TEST_ONLY_GONE_VALUE");
  await Promise.resolve();
  expect(changes).toBe(2);
  // Further accesses, and the timer, find nothing more to change.
  expect(store.get("TEST_KEY_GONE")).toBeNull();
  fake.advance(1_000, true);
  await Promise.resolve();
  expect(changes).toBe(2);
});
