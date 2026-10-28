// hud ask --room SLUG names the room a question is about; hud update --room sets or clears it. A room must exist and be open,
// and a room is never guessed from the lane.
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { office, ROOT } from "./office.ts";

const o = await office();
afterAll(async () => {
  await o.stop();
  o.remove();
});
async function hud(...args: string[]) {
  const proc = Bun.spawn([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: o.base }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}
const asked = async (title: string) => {
  const s = await o.state();
  return [...s.open, ...s.deferred].find((q: any) => q.title === title);
};

test("--room is kept on the question and reaches open and deferred questions; without it the question has none, even in a room's lane", async () => {
  expect((await hud("lane", "app-lane")).code).toBe(0);
  expect((await hud("room", "create", "launch", "--title", "Launch", "--owner", "app-lane")).code).toBe(0);
  expect((await hud("ask", "--title", "Named", "--lane", "app-lane", "--room", "launch")).code).toBe(0);
  expect((await hud("ask", "--title", "Not named", "--lane", "app-lane")).code).toBe(0);
  // A checklist question goes through the ledger's route and keeps it too.
  expect((await hud("ask", "--title", "With items", "--room", "launch", "--item", "one")).code).toBe(0);
  const later = await hud("ask", "--title", "Later", "--room", "launch");
  const id = Number(later.out.match(/ask #(\d+)/)![1]);
  await o.post(`/api/asks/${id}/defer`, { until: Date.now() + 3600_000 });
  const s = await o.state();
  expect(s.open.map((q: any) => [q.title, q.room])).toEqual([["Named", "launch"], ["Not named", null], ["With items", "launch"]]);
  expect(s.deferred.map((q: any) => [q.title, q.room])).toEqual([["Later", "launch"]]);
});

test("an unknown room or an archived one refuses the ask with a reason, and files nothing", async () => {
  const unknown = await hud("ask", "--title", "Nowhere", "--room", "no-such-room");
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain("no room no-such-room");
  expect(unknown.err).toContain("hud room create no-such-room");
  expect((await hud("lane", "refused-lane")).code).toBe(0);
  expect((await hud("room", "create", "old-one", "--title", "Old", "--owner", "refused-lane")).code).toBe(0);
  expect((await hud("room", "archive", "old-one")).code).toBe(0);
  const archived = await hud("ask", "--title", "In the past", "--room", "old-one");
  expect(archived.code).toBe(1);
  expect(archived.err).toContain("room old-one is archived");
  const withItems = await hud("ask", "--title", "In the past too", "--room", "old-one", "--item", "one");
  expect(withItems.code).toBe(1);
  const titles = (await o.state()).open.map((q: any) => q.title);
  expect(titles).not.toContain("Nowhere");
  expect(titles).not.toContain("In the past");
  expect(titles).not.toContain("In the past too");
});

test("hud update --room sets, changes and clears it, and refuses a room that is not open; moving the question keeps it", async () => {
  expect((await hud("lane", "update-lane")).code).toBe(0);
  for (const slug of ["first", "second", "gone"]) expect((await hud("room", "create", slug, "--title", slug, "--owner", "update-lane")).code).toBe(0);
  expect((await hud("room", "archive", "gone")).code).toBe(0);
  const id = Number((await hud("ask", "--title", "Settable", "--kind", "action")).out.match(/ask #(\d+)/)![1]);
  expect((await asked("Settable")).room).toBeNull();
  expect((await hud("update", String(id), "--room", "first")).code).toBe(0);
  expect((await asked("Settable")).room).toBe("first");
  expect((await hud("update", String(id), "--room", "second")).code).toBe(0);
  expect((await asked("Settable")).room).toBe("second");
  // A title edit leaves the room; a move to another lane leaves it too.
  expect((await hud("update", String(id), "--title", "Settable, edited")).code).toBe(0);
  expect((await hud("lane", "other-lane")).code).toBe(0);
  expect((await hud("update", String(id), "--lane", "other-lane")).code).toBe(0);
  const moved = await asked("Settable, edited");
  expect([moved.lane, moved.room]).toEqual(["other-lane", "second"]);
  const refused = await hud("update", String(id), "--room", "gone");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("room gone is archived");
  expect((await asked("Settable, edited")).room).toBe("second");
  expect((await hud("update", String(id), "--room", "")).code).toBe(0);
  expect((await asked("Settable, edited")).room).toBeNull();
});

test("the HQ guide tells a lane to name the room, and says what a question without one is", async () => {
  const { GUIDE } = await import("../../src/hq-guide.ts");
  const line = GUIDE.split("\n").find((l) => l.includes("--room"))!;
  expect(line).toContain("hud ask ... --room SLUG");
  expect(line).toContain("belongs to no project");
});
