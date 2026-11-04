// Secrets across restarts: a planned restart through the plugin hands the values over (memory to memory), a crash
// loses them loudly (LOST in listings, the state and `hud secret get`, and a note to HQ), and every expiry is said
// with its date. Every server here is a throwaway one on a spare port with a temporary data dir; launchctl and
// systemctl are test/fake-service.ts. Values are obviously fake.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { freePort, spawnServer } from "../../scripts/room-hash.ts";
import { createHandover, createSecretStore, secretRoute, HANDOVER_WINDOW_MS, type Clock } from "../../src/server/secrets.ts";
import { atText, expiresText, untilText } from "../../src/client/secrets/expiry.js";

const ROOT = join(import.meta.dir, "..", "..");
const FAKE = join(ROOT, "test", "fake-service.ts");

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
const listing = async (base: string) => (await (await fetch(`${base}/api/secrets`)).json()) as any[];
const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? filesUnder(join(dir, f)) : [join(dir, f)]));
const tokenOf = (data: string) => readFileSync(join(data, "secret-handover.token"), "utf8").trim();
const handoverPost = (base: string, path: string, token: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", "x-hud-handover": token, ...headers }, body: JSON.stringify(body) });

// ---- the dates ----

describe("expiry is said relatively and with its date", () => {
  const now = new Date(2026, 9, 26, 13, 45, 0).getTime(); // Mon 26 Oct, 13:45 local time
  const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m, 0).getTime();

  test("days, hours, minutes and seconds", () => {
    expect(untilText(now + (6 * 24 + 23) * 3_600_000, now)).toBe("6d 23h");
    expect(untilText(now + 23 * 3_600_000, now)).toBe("23h");
    expect(untilText(now + 5 * 3_600_000 + 10 * 60_000, now)).toBe("5h 10m");
    expect(untilText(now + 42 * 60_000, now)).toBe("42m");
    expect(untilText(now + 30_000, now)).toBe("30s");
    expect(untilText(now + 2 * 86_400_000, now)).toBe("2d");
  });
  test("today, tomorrow, then the weekday and the date", () => {
    expect(atText(at(26, 18, 5), now)).toBe("today 18:05");
    expect(atText(at(27, 13, 45), now)).toBe("tomorrow 13:45");
    expect(atText(new Date(2026, 10, 2, 13, 45).getTime(), now)).toBe("Mon 2 Nov, 13:45");
  });
  test("the whole phrase", () => {
    expect(expiresText(new Date(2026, 10, 2, 12, 45).getTime(), now)).toBe("expires in 6d 23h (Mon 2 Nov, 12:45)");
    expect(expiresText(at(27, 12, 45), now)).toBe("expires in 23h (tomorrow 12:45)");
  });
});

// ---- the import's guards, on the route itself ----

describe("the handover import is refused unless fresh, empty, local and not a browser", () => {
  let t = 1_000_000;
  const clock: Clock = { now: () => t, setTimeout: () => 0, clearTimeout: () => {} };
  const TOKEN = "a".repeat(64);
  const one = [{ name: "TEST_KEY_H", value: "TEST_ONLY_VALUE_HANDOVER_1", by: "owner", setAt: t, expiresAt: t + 60_000 }];
  const call = (store: any, handover: any, ip = "127.0.0.1", headers: Record<string, string> = {}, token = TOKEN) =>
    secretRoute(
      new Request("http://127.0.0.1:1/api/secrets/import", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1:1", "x-hud": "1", "x-hud-handover": token, ...headers }, body: JSON.stringify({ secrets: one }) }),
      "/api/secrets/import",
      ip,
      store,
      { host: "127.0.0.1", handover },
    );

  test("not fresh: more than 2 minutes after the start", async () => {
    const store = createSecretStore({ clock });
    const h = createHandover({ token: TOKEN, startedAt: t - HANDOVER_WINDOW_MS - 1, clock });
    const res = await call(store, h);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("more than 2 minutes");
    expect(store.size()).toBe(0);
  });
  test("not empty: the server already holds a secret", async () => {
    const store = createSecretStore({ clock });
    store.set("TEST_KEY_OTHER", "TEST_ONLY_VALUE_OTHER", 5, "hq");
    const res = await call(store, createHandover({ token: TOKEN, startedAt: t, clock }));
    expect(res.status).toBe(409);
    expect(store.get("TEST_KEY_H")).toBeNull();
  });
  test("from another machine, from a browser, without or with a wrong token", async () => {
    const h = createHandover({ token: TOKEN, startedAt: t, clock });
    const store = createSecretStore({ clock });
    expect((await call(store, h, "192.168.1.9")).status).toBe(403);
    expect((await call(store, h, "127.0.0.1", { origin: "http://127.0.0.1:1" })).status).toBe(403);
    expect((await call(store, h, "127.0.0.1", { origin: "http://evil.example" })).status).toBe(403);
    expect((await call(store, h, "127.0.0.1", { "sec-fetch-site": "same-origin" })).status).toBe(403);
    expect((await call(store, h, "127.0.0.1", {}, "")).status).toBe(403);
    expect((await call(store, h, "127.0.0.1", {}, "b".repeat(64))).status).toBe(403);
    expect((await call(store, createHandover({ token: "", startedAt: t, clock }), "127.0.0.1", {}, "")).status).toBe(403);
    expect(store.size()).toBe(0);
    // The right caller gets in once, keeping the deadline it brought.
    const ok = await call(store, h);
    expect(ok.status).toBe(200);
    expect(await ok.text()).not.toContain("TEST_ONLY_VALUE");
    expect(store.list()).toEqual([{ name: "TEST_KEY_H", by: "owner", setAt: t, expiresAt: t + 60_000 }]);
    store.remove("TEST_KEY_H");
    expect((await call(store, h)).status).toBe(409); // once only
  });
});

// ---- a real server: token, browser refusal and the loss path ----

describe("a real server killed hard loses its secrets loudly", () => {
  const DATA = mkdtempSync(join(tmpdir(), "hq-office-secret-loss-"));
  const PROMPTS = join(DATA, "herdr-prompts.log");
  const HERDR = join(DATA, "fake-herdr");
  writeFileSync(HERDR, `#!/bin/sh\nif [ "$2" = "list" ]; then echo '{"result":{"agents":[]}}'; else printf '%s\\n' "$*" >> '${PROMPTS}'; fi\n`);
  chmodSync(HERDR, 0o755);
  let server: Awaited<ReturnType<typeof spawnServer>> | null = null;
  const start = async () => {
    server = await spawnServer({
      cwd: ROOT,
      env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: HERDR, HUD_LOCAL_MACHINE: "local", HUD_MACHINES: "local", HUD_SECRET_LOST_NOTE_MS: "300" },
      out: (chunk) => writeFileSync(join(DATA, "server.log"), chunk, { flag: "a" }),
    });
    return server.base;
  };
  afterAll(async () => {
    await server?.stop();
    rmSync(DATA, { recursive: true, force: true });
  });
  const VALUE = "TEST_ONLY_VALUE_LOSS_1";

  test("the token file is this user's only, and export refuses a browser and a wrong token", async () => {
    const base = await start();
    const f = join(DATA, "secret-handover.token");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const token = tokenOf(DATA);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    await cli(base, ["secret", "set", "TEST_KEY_LOSS", "--minutes", "60", "--by", "owner"], VALUE);
    for (const headers of [{ origin: base }, { "sec-fetch-mode": "cors" }]) {
      const res = await handoverPost(base, "/api/secrets/export", token, {}, headers);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain(VALUE);
    }
    expect((await handoverPost(base, "/api/secrets/export", "0".repeat(64), {})).status).toBe(403);
    // Not fresh-and-empty: this server holds a secret.
    const imp = await handoverPost(base, "/api/secrets/import", token, { secrets: [{ name: "TEST_KEY_X", value: "TEST_ONLY_VALUE_X", by: "owner", setAt: Date.now(), expiresAt: Date.now() + 60_000 }] });
    expect(imp.status).toBe(409);
  });

  test("after SIGKILL and a restart: LOST in list, state and get, a note to HQ; expired names are cleaned", async () => {
    let base = server!.base;
    const before = (await listing(base)).find((x) => x.name === "TEST_KEY_LOSS");
    await cli(base, ["secret", "set", "TEST_KEY_BRIEF", "--minutes", "0.01"], "TEST_ONLY_VALUE_BRIEF");
    server!.kill("SIGKILL");
    await server!.stop();
    await Bun.sleep(700); // TEST_KEY_BRIEF's deadline passes while the server is down
    base = await start();

    const list = await listing(base);
    expect(list).toEqual([{ ...before, lostAt: expect.any(Number) }]);
    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.secrets).toEqual([]);
    expect(state.secretsLost.map((x: any) => x.name)).toEqual(["TEST_KEY_LOSS"]);
    const listed = await cli(base, ["secret", "list"]);
    expect(listed.out).toContain("TEST_KEY_LOSS\tLOST (lost in a restart at ");
    expect(listed.out).not.toContain("TEST_KEY_BRIEF");

    const got = await cli(base, ["secret", "get", "TEST_KEY_LOSS"]);
    expect(got.code).not.toBe(0);
    expect(got.out).toBe("");
    expect(got.err).toMatch(/^TEST_KEY_LOSS was lost when the server restarted at \d\d:\d\d; ask the owner to set it again\n$/);

    // One line to HQ, through herdr.
    for (const end = Date.now() + 10_000; Date.now() < end && !(existsSync(PROMPTS) && readFileSync(PROMPTS, "utf8").includes("lost TEST_KEY_LOSS")); ) await Bun.sleep(50);
    expect(readFileSync(PROMPTS, "utf8")).toContain("HUD secrets lost: the server restarted at ");

    const db = new Database(join(DATA, "hud.db"), { readonly: true });
    expect((db.query("SELECT name FROM secret_meta").all() as any[]).map((r) => r.name)).toEqual(["TEST_KEY_LOSS"]);
    db.close();

    // Set again: no longer lost.
    await cli(base, ["secret", "set", "TEST_KEY_LOSS", "--minutes", "5"], VALUE);
    expect((await listing(base)).map((x) => [x.name, !!x.lostAt])).toEqual([["TEST_KEY_LOSS", false]]);
    expect((await cli(base, ["secret", "get", "TEST_KEY_LOSS"])).out).toBe(VALUE);

    // A lost name can be dismissed with rm.
    server!.kill("SIGKILL");
    await server!.stop();
    base = await start();
    expect((await listing(base))[0].lostAt).toBeNumber();
    expect((await cli(base, ["secret", "rm", "TEST_KEY_LOSS"])).code).toBe(0);
    expect(await listing(base)).toEqual([]);
    expect((await cli(base, ["secret", "get", "TEST_KEY_LOSS"])).err).toContain("no secret TEST_KEY_LOSS");

    for (const f of filesUnder(DATA)) expect({ f, hit: readFileSync(f).toString("latin1").includes(VALUE) }).toEqual({ f, hit: false });
  });
});

// ---- the plugin's restart actions hand the secrets over ----

describe("the plugin's reload and install-service hand the secrets over", () => {
  const dir = mkdtempSync(join(tmpdir(), "hq-office-secret-handover-"));
  const t = { home: join(dir, "home"), state: join(dir, "state"), config: join(dir, "config"), fake: join(dir, "fake"), port: freePort() };
  const base = `http://127.0.0.1:${t.port}`;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: t.home,
    TMPDIR: tmpdir(),
    HERDR_PLUGIN_STATE_DIR: t.state,
    HERDR_PLUGIN_CONFIG_DIR: t.config,
    HQ_OFFICE_PLATFORM: "darwin",
    HQ_OFFICE_LAUNCHCTL: join(t.fake, "launchctl"),
    HQ_OFFICE_SYSTEMCTL: join(t.fake, "systemctl"),
    HQ_OFFICE_OPENER: "true",
    FAKE_SERVICE_DIR: t.fake,
  };
  const plugin = (command: string) => {
    const p = Bun.spawnSync([process.execPath, "bin/hud-plugin.ts", command], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
  };
  const VALUES = { TEST_KEY_HAND_A: "TEST_ONLY_VALUE_HAND_A", TEST_KEY_HAND_B: "TEST_ONLY_VALUE_HAND_B" };
  const outputs: string[] = [];

  beforeAll(() => {
    for (const d of [t.home, t.state, t.config, t.fake]) mkdirSync(d, { recursive: true });
    for (const tool of ["launchctl", "systemctl"]) {
      writeFileSync(join(t.fake, tool), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${tool} "$@"\n`);
      chmodSync(join(t.fake, tool), 0o755);
    }
    writeFileSync(join(t.config, "config.env"), [`HUD_PORT=${t.port}`, "HUD_HOST=127.0.0.1", `HERDR_BIN=${join(dir, "no-such-herdr")}`, "HUD_MACHINES=local", "HUD_HQ_AGENT=hq", ""].join("\n"));
  });
  afterAll(() => {
    plugin("remove-service");
    plugin("stop");
    const f = join(t.fake, "state.json");
    if (existsSync(f)) for (const job of Object.values(JSON.parse(readFileSync(f, "utf8"))) as { pid: number | null }[]) try { if (job.pid) process.kill(job.pid, "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  async function expectHandedOver(before: any[], oldToken: string, r: { code: number | null; out: string }) {
    outputs.push(r.out);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Handed 2 secrets over to the new server");
    expect(tokenOf(t.state)).not.toBe(oldToken); // a new process, so a new token
    expect(await listing(base)).toEqual(before); // same names, setters and deadlines; nothing lost
    for (const [name, value] of Object.entries(VALUES)) expect((await cli(base, ["secret", "get", name])).out).toBe(value);
  }

  test("reload of a plain process", async () => {
    expect(plugin("start").code).toBe(0);
    await cli(base, ["secret", "set", "TEST_KEY_HAND_A", "--minutes", "10080", "--by", "owner"], VALUES.TEST_KEY_HAND_A);
    await cli(base, ["secret", "set", "TEST_KEY_HAND_B", "--minutes", "30"], VALUES.TEST_KEY_HAND_B);
    const before = await listing(base);
    expect(before.length).toBe(2);
    const pid = readFileSync(join(t.state, "hud.pid"), "utf8");
    const token = tokenOf(t.state);
    const r = plugin("reload");
    expect(readFileSync(join(t.state, "hud.pid"), "utf8")).not.toBe(pid);
    await expectHandedOver(before, token, r);
  });

  test("install-service taking over, then reload of the service", async () => {
    const before = await listing(base);
    let token = tokenOf(t.state);
    await expectHandedOver(before, token, plugin("install-service"));
    token = tokenOf(t.state);
    await expectHandedOver(before, token, plugin("reload"));
  });

  test("reload of a server from before the handover (no token, no export): read one by one, then handed over", async () => {
    const before = await listing(base);
    const token = tokenOf(t.state);
    rmSync(join(t.state, "secret-handover.token")); // what a server from before the handover looks like to the plugin
    await expectHandedOver(before, token, plugin("reload"));
  });

  test("no value in the plugin's output, the log, the database or the token file", () => {
    for (const out of outputs) for (const v of Object.values(VALUES)) expect(out).not.toContain(v);
    const files = filesUnder(t.state);
    expect(files).toContain(join(t.state, "secret-handover.token"));
    for (const f of files) for (const v of Object.values(VALUES)) expect({ f, hit: readFileSync(f).toString("latin1").includes(v) }).toEqual({ f, hit: false });
  });
});
