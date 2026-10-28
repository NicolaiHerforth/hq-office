// A question's link opens from the page, so the server keeps only web addresses: http:// or https://, on ask and on update.
import { afterAll, describe, expect, test } from "bun:test";
import { office } from "./office.ts";

const o = await office();
afterAll(async () => {
  await o.stop();
  o.remove();
});
const linkOf = async (id: number) => (await o.state()).open.find((a: any) => a.id === id)?.link ?? null;

describe("a question's link", () => {
  test("an ask keeps an http(s) link and refuses any other, saving nothing", async () => {
    const ok = (await (await o.send("/api/asks", { title: "Read this", link: "https://example.com/pr/1" })).json()) as any;
    expect(await linkOf(ok.id)).toBe("https://example.com/pr/1");
    for (const link of ["javascript:void(0)", "JavaScript:void(0)", "data:text/html,x", "ftp://example.com/x", "file:///tmp/x", "example.com/x"]) {
      const res = await o.send("/api/asks", { title: `Bad ${link}`, link });
      expect(res.ok).toBe(false);
      expect(await res.text()).toContain("http:// or https://");
    }
    expect((await o.state()).open.filter((a: any) => a.title.startsWith("Bad "))).toEqual([]);
  });

  test("an update refuses any other link and leaves the question as it was; an empty link clears it", async () => {
    const { id } = (await (await o.send("/api/asks", { title: "Edit my link", link: "http://example.com/a" })).json()) as any;
    const res = await o.send(`/api/asks/${id}/update`, { title: "Changed", link: "ftp://example.com/b" });
    expect(res.ok).toBe(false);
    const a = (await o.state()).open.find((x: any) => x.id === id);
    expect([a.title, a.link]).toEqual(["Edit my link", "http://example.com/a"]);
    expect((await o.send(`/api/asks/${id}/update`, { link: "" })).ok).toBe(true);
    expect(await linkOf(id)).toBeNull();
  });
});
