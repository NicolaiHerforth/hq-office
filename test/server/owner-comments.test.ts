// The owner talks a question through: a comment to HQ or to the question's lane. It is saved first, reaches its recipient, and
// the question stays open. Today's rows (HQ's comments, author NULL) read as HQ's.
import { afterAll, describe, expect, test } from "bun:test";
import { office } from "./office.ts";

const offices: Awaited<ReturnType<typeof office>>[] = [];
afterAll(async () => {
  for (const o of offices) {
    await o.stop();
    o.remove();
  }
});
const start = async (opts: Parameters<typeof office>[0] = {}) => {
  const o = await office({ agents: ["hq", "app"], ...opts });
  offices.push(o);
  await o.post("/api/lanes", { name: "app" });
  return o;
};
const comments = async (o: Awaited<ReturnType<typeof office>>, ask: number) => (await o.state()).ledger[ask].comments as any[];

describe("talk a question through", () => {
  test("a comment to HQ is typed into HQ, saved with the owner as author, and the question stays open", async () => {
    const o = await start();
    const { id } = await o.post("/api/asks", { title: "Which db?", lane: "app" });
    await o.post(`/api/asks/${id}/talk`, { text: "why not sqlite?" });
    const typed = await o.prompted("why not sqlite?");
    expect(typed.startsWith("hq|")).toBe(true);
    expect(typed).toContain("Which db?");
    const [c] = await comments(o, id);
    expect([c.author, c.to, c.text, c.delivery]).toEqual(["owner", null, "why not sqlite?", null]);
    expect((await o.state()).open.map((a: any) => a.title)).toEqual(["Which db?"]);
  });

  test("a comment to the question's lane is typed into that lane, with how to answer it", async () => {
    const o = await start();
    const { id } = await o.post("/api/asks", { title: "Which db?", lane: "app" });
    await o.post(`/api/asks/${id}/talk`, { text: "can you try sqlite?", to: "app" });
    const typed = await o.prompted("can you try sqlite?");
    expect(typed.startsWith("app|")).toBe(true);
    expect(typed).toContain(`hud comment ${id} "<your reply>" --as app`);
    await Bun.sleep(100);
    const [c] = await comments(o, id);
    expect([c.author, c.to, c.delivery, c.error]).toEqual(["owner", "app", "sent", null]);
    // The lane answers under the question as itself.
    await o.post(`/api/asks/${id}/comment`, { text: "sqlite works", as: "app" });
    expect((await comments(o, id)).map((x) => [x.author, x.text])).toEqual([["owner", "can you try sqlite?"], ["app", "sqlite works"]]);
  });

  test("a comment is kept when delivery fails: to a lane it says failed and can be sent again; to HQ it is held", async () => {
    const o = await start();
    const { id } = await o.post("/api/asks", { title: "Which db?", lane: "app" });
    o.failing(true);
    await o.post(`/api/asks/${id}/talk`, { text: "to the lane", to: "app" });
    await o.post(`/api/asks/${id}/talk`, { text: "to hq" });
    await Bun.sleep(400);
    const [toLane, toHq] = await comments(o, id);
    expect([toLane.text, toLane.delivery]).toEqual(["to the lane", "failed"]);
    expect(toLane.error).toContain("stub refuses");
    expect(toHq.text).toBe("to hq");
    expect((await o.state()).hq.held.map((h: any) => h.ref)).toEqual([`comment:${toHq.id}`]);
    expect(o.prompts()).toEqual([]);
    o.failing(false);
    await o.post(`/api/asks/${id}/comments/${toLane.id}/resend`, {});
    await o.prompted("to the lane");
    await Bun.sleep(100);
    expect((await comments(o, id))[0].delivery).toBe("sent");
    expect((await o.send(`/api/asks/${id}/comments/${toLane.id}/resend`, {})).status).not.toBe(200);
  });

  test("a lane that is not running fails at once and the comment stays", async () => {
    const o = await start();
    await o.post("/api/lanes", { name: "gone-lane" });
    await o.post("/api/sync", {}); // herdr lists no agent named gone-lane
    const { id } = await o.post("/api/asks", { title: "Q", lane: "gone-lane" });
    await o.post(`/api/asks/${id}/talk`, { text: "hello?", to: "gone-lane" });
    await Bun.sleep(100);
    const [c] = await comments(o, id);
    expect(c.text).toBe("hello?");
    expect([c.delivery, c.error]).toEqual(["failed", "gone-lane is not running in herdr"]);
    expect(o.prompts()).toEqual([]);
  });

  test("only HQ or the question's lane can be addressed, and only an open question", async () => {
    const o = await start();
    const a = (await o.post("/api/asks", { title: "Q", lane: "app" })).id;
    const b = (await o.post("/api/asks", { title: "No lane" })).id;
    expect((await o.send(`/api/asks/${a}/talk`, { text: "x", to: "other" })).status).not.toBe(200);
    expect((await o.send(`/api/asks/${b}/talk`, { text: "x", to: "app" })).status).not.toBe(200);
    expect((await o.send(`/api/asks/${a}/talk`, { text: "  " })).status).not.toBe(200);
    await o.post(`/api/asks/${a}/answer`, { answer: "yes" });
    expect((await o.send(`/api/asks/${a}/talk`, { text: "late" })).status).not.toBe(200);
  });

  test("HQ's own comments still read as HQ's: author null", async () => {
    const o = await start();
    const { id } = await o.post("/api/asks", { title: "Q" });
    await o.post(`/api/asks/${id}/comment`, { text: "a note from HQ" });
    const [c] = await comments(o, id);
    expect([c.author, c.to, c.delivery]).toEqual([null, null, null]);
    expect(o.prompts()).toEqual([]);
  });
});
