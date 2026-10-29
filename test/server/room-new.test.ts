// A room the owner opens on the page (+ NEW ROOM): a title, the owning lane, other lanes, an issue or a PR, and an
// optional first message. The slug comes from the title (a taken one gets -2), the event is the owner's, HQ hears of
// it, and the first message goes to the owning lane like any message in a room. A stub herdr records every prompt.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-room-new-"));
// One file per prompt (fake-herdr.ts), so two prompts at the same moment never mix.
const herdr = fakeHerdr(DATA, ["hq", "pm", "eng"].map((name, i) => ({ name, agent_status: "idle", pane_id: `p${i}`, agent: "claude" })));
let server: Awaited<ReturnType<typeof spawnServer>>;

beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_OWNER: "Sam", HUD_HQ_HINT: "0" } });
  for (const name of ["pm", "eng"]) await post("/api/lanes", { name, machine: "local" });
  await post("/api/sync", {});
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(DATA, { recursive: true, force: true });
});
const post = async (path: string, body: unknown) => {
  const res = await fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) });
  return { status: res.status, ...(await res.json()) };
};
// [agent, text] for every prompt typed in
const prompts = () => herdr.typed().map(([agent, text]) => ["agent", "prompt", agent, text]);
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 320; i++) { if (ok()) return; await Bun.sleep(25); }
  throw new Error(`timed out waiting for ${what}`);
};

test("the owner opens a room from a title: the slug follows it, lanes, an issue and a PR join, HQ hears of it", async () => {
  const r = await post("/api/rooms", { by: "owner", title: "Pricing page: copy & layout", owner: "pm", members: ["eng"], issues: ["ope-12"], prs: ["34"] });
  expect(r).toMatchObject({ status: 200, slug: "pricing-page-copy-layout", created: true });
  const v = await (await fetch(`${server.base}/api/rooms/pricing-page-copy-layout`)).json();
  expect(v).toMatchObject({ title: "Pricing page: copy & layout", owner: "pm", members: ["eng"], issues: ["OPE-12"] });
  const s = await (await fetch(`${server.base}/api/state`)).json();
  expect(s.events.some((e: any) => e.who === "Sam" && /opened room pricing-page-copy-layout/.test(e.text))).toBe(true);
  await until(() => prompts().some((p) => p[2] === "hq" && p[3].includes("Sam opened room pricing-page-copy-layout")), "HQ told");
  const told = prompts().find((p) => p[2] === "hq" && p[3].includes("opened room"))![3];
  expect(told).toContain("pm owns it");
}, 20_000);

test("the same title again gets the next free slug, never the room that has it", async () => {
  const r = await post("/api/rooms", { by: "owner", title: "Pricing page: copy & layout", owner: "eng" });
  expect(r).toMatchObject({ status: 200, slug: "pricing-page-copy-layout-2", created: true });
  const first = await (await fetch(`${server.base}/api/rooms/pricing-page-copy-layout`)).json();
  expect(first.owner).toBe("pm");
}, 20_000);

test("a first message goes to the owning lane, with how to answer in the room", async () => {
  const r = await post("/api/rooms", { by: "owner", title: "Onboarding video", owner: "eng", text: "Please draft the script here." });
  expect(r.status).toBe(200);
  await until(() => prompts().some((p) => p[2] === "eng" && p[3].includes("Please draft the script here.")), "the lane prompted");
  const p = prompts().find((x) => x[2] === "eng" && x[3].includes("Please draft the script here."))![3];
  expect(p).toContain(`HUD room ${r.slug}`);
  expect(p).toContain(`hud room say ${r.slug}`);
}, 20_000);

test("refused without a title or an owning lane, or with a lane that does not exist", async () => {
  expect((await post("/api/rooms", { by: "owner", title: "", owner: "pm" })).status).toBe(400);
  expect((await post("/api/rooms", { by: "owner", title: "No owner" })).status).toBe(400);
  expect((await post("/api/rooms", { by: "owner", title: "Ghost", owner: "nobody" })).status).toBe(400);
  expect((await post("/api/rooms", { by: "owner", title: "!!!", owner: "pm" })).status).toBe(400);
}, 20_000);
