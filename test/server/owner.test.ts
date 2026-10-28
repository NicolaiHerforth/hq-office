// What HQ is sent and what the event log says name the configured owner (HUD_OWNER), or "the owner" when unset.
// Each server runs on a spare port with a throwaway data dir and a stub herdr that records what it is asked.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { LEGACY_OWNER_WHO } from "../../src/server/config.ts";

const ROOT = join(import.meta.dir, "..", "..");
const stops: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function office(owner: string | undefined) {
  const data = mkdtempSync(join(tmpdir(), "hq-owner-test-"));
  const herdr = join(data, "herdr");
  const log = join(data, "herdr.log");
  writeFileSync(herdr, `#!/bin/sh\necho "$*" >> "${log}"\ncase "$*" in\n  *"agent list"*) echo '{"result":{"agents":[]}}' ;;\nesac\nexit 0\n`);
  chmodSync(herdr, 0o755);
  const env: Record<string, string | undefined> = { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_OWNER: owner };
  if (owner === undefined) delete env.HUD_OWNER;
  const server = await spawnServer({ cwd: ROOT, env });
  stops.push(async () => {
    await server.stop();
    rmSync(data, { recursive: true, force: true });
  });
  const { base } = server;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...headers }, body: JSON.stringify(body) });
  const state = async () => (await fetch(`${base}/api/state`)).json();
  // The stub runs after the request returns: wait until it has written the line.
  const sent = async (part: string) => {
    for (let i = 0; i < 40; i++) {
      const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("agent prompt")) : [];
      if (lines.some((l) => l.includes(part)) || i === 39) return lines;
      await Bun.sleep(50);
    }
    return [];
  };
  const events = async () => (await state()).events.map((e: any) => `${e.who} ${e.text}`);
  return { base, post, state, sent, events };
}

describe("HUD_OWNER set", async () => {
  const o = await office("Pat");

  test("an urgent note reaches HQ under the owner's name, and the log says who told it", async () => {
    expect((await o.post("/api/notes", { text: "ship it", urgent: true })).status).toBe(200);
    expect(await o.sent("ship it")).toContain("agent prompt hq URGENT from Pat: ship it");
    expect(await o.events()).toContain("Pat told HQ: ship it");
  });

  test("an answer is logged under the owner's name", async () => {
    const { id } = await (await o.post("/api/asks", { title: "Left or right?", options: ["Left", "Right"], recommended: "Left" })).json();
    expect((await o.post(`/api/asks/${id}/answer`, { answer: "Left" })).status).toBe(200);
    expect(await o.events()).toContain('Pat answered "Left or right?": Left');
  });

  test("a secret set on the page is announced to HQ under the owner's name", async () => {
    const res = await o.post("/api/secrets", { name: "TEST_KEY_OWNER", value: "TEST_ONLY_VALUE_OWNER_135", minutes: 5, by: "owner" }, { origin: o.base });
    expect(res.status).toBe(200);
    const lines = await o.sent("TEST_KEY_OWNER");
    expect(lines.some((l) => l.includes("HUD secret from Pat: TEST_KEY_OWNER"))).toBe(true);
    expect(lines.join("\n")).not.toContain("TEST_ONLY_VALUE_OWNER_135");
  });

  test("events 0.1.0 logged under its fixed word read as the owner's", async () => {
    await o.post("/api/events", { who: LEGACY_OWNER_WHO, text: "told HQ: an old note" });
    expect(await o.events()).toContain("Pat told HQ: an old note");
    expect((await o.state()).events.some((e: any) => e.who === LEGACY_OWNER_WHO)).toBe(false);
  });
});

describe("HUD_OWNER unset", async () => {
  const o = await office(undefined);

  test("the note says the owner", async () => {
    await o.post("/api/notes", { text: "ship it", urgent: true });
    expect(await o.sent("ship it")).toContain("agent prompt hq URGENT from the owner: ship it");
    expect(await o.events()).toContain("the owner told HQ: ship it");
    expect((await o.state()).events.some((e: any) => e.who === LEGACY_OWNER_WHO)).toBe(false);
  });
});
