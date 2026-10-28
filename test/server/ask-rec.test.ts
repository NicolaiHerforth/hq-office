// The owner's rule: every ask carries the agent's pick. `hud ask` and the route behind it refuse a decision filed with options and no
// --rec, say what is missing and show the line to send; a question with no options is not refused. The guide teaches the rule.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GUIDE } from "../../src/hq-guide.ts";
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
const titles = async () => (await o.state()).open.map((a: any) => a.title);

describe("a decision with options needs a recommendation", () => {
  test("hud ask refuses it, says what is missing and shows the line with --rec", async () => {
    const r = await hud("ask", "--title", "Which database?", "--opt", "SQLite", "--opt", "Postgres");
    expect(r.code).toBe(1);
    expect(r.err.trim()).toBe(
      `This decision has options but no recommendation. Every question to the owner carries your pick and why: add --rec with the option you recommend, and say why in --body. Example:\n` +
        `  hud ask --title 'Which database?' --opt 'SQLite' --opt 'Postgres' --rec 'SQLite' --body 'I recommend SQLite because ...'\n` +
        `A question with no options (--kind action or info) needs no --rec.`,
    );
    expect(await titles()).toEqual([]);
  });

  test("the route refuses it too, a blank pick counts as none, and the ledger's route as well", async () => {
    for (const path of ["/api/asks", "/api/ledger/asks"]) {
      for (const recommended of [undefined, "", "  "]) {
        const res = await o.send(path, { title: "Left or right?", options: ["Left", "Right"], recommended });
        expect(res.status).not.toBe(200);
        expect(((await res.json()) as any).error).toContain("no recommendation");
      }
    }
    expect(await titles()).toEqual([]);
  });

  test("with --rec, with no options, or as an action or info, it is filed", async () => {
    expect((await hud("ask", "--title", "Picked", "--opt", "A", "--opt", "B", "--rec", "A")).code).toBe(0);
    expect((await hud("ask", "--title", "Open question")).code).toBe(0);
    expect((await hud("ask", "--title", "Do the thing", "--kind", "action")).code).toBe(0);
    expect((await hud("ask", "--title", "FYI", "--kind", "info", "--opt", "Noted")).code).toBe(0);
    expect(await titles()).toEqual(["Picked", "Open question", "Do the thing", "FYI"]);
  });

  test("hud update refuses an edit that would leave options with no pick, and allows the rest", async () => {
    const ask = async (body: object) => ((await (await o.send("/api/asks", body)).json()) as any).id as number;
    const ask_ = async (id: number) => (await o.state()).open.find((a: any) => a.id === id);
    const bare = await ask({ title: "Bare" });
    const r = await hud("update", String(bare), "--opt", "Yes", "--opt", "No");
    expect(r.code).toBe(1);
    expect(r.err).toContain("This decision has options but no recommendation.");
    // The fix is an update of this question, and the why goes in a comment: a hud ask here would file it twice.
    expect(r.err).toContain(`hud update ${bare} --opt 'Yes' --opt 'No' --rec 'Yes' && hud comment ${bare} 'I recommend Yes because ...'`);
    expect(r.err).not.toContain("hud ask");
    expect((await ask_(bare)).options ?? []).toEqual([]);
    expect((await hud("update", String(bare), "--opt", "Yes", "--opt", "No", "--rec", "Yes")).code).toBe(0);
    expect((await ask_(bare)).recommended).toBe("Yes");
    // A blank --rec on a question with options takes its pick away: refused.
    expect((await hud("update", String(bare), "--rec", " ")).code).toBe(1);
    // New options that leave the old pick out leave no pick either: refused, and the fix keeps the new options.
    const gone = await hud("update", String(bare), "--opt", "Maybe", "--opt", "Later");
    expect(gone.code).toBe(1);
    expect(gone.err).toContain(`This decision's --rec 'Yes' is not one of its options.`);
    expect(gone.err).toContain(`hud update ${bare} --opt 'Maybe' --opt 'Later' --rec 'Maybe'`);
    expect((await ask_(bare)).options).toEqual(["Yes", "No"]);
    // An edit that leaves the options and the pick alone is not this rule's business.
    expect((await hud("update", String(bare), "--title", "Bare, renamed")).code).toBe(0);
    const info = await ask({ title: "FYI 2", kind: "info" });
    expect((await hud("update", String(info), "--opt", "Noted")).code).toBe(0);
  });

  test("a --rec that is not one of the options is refused, since the owner would see no pick", async () => {
    const r = await hud("ask", "--title", "Left or right?", "--opt", "Left", "--opt", "Right", "--rec", "Up");
    expect(r.code).toBe(1);
    expect(r.err).toContain(`This decision's --rec 'Up' is not one of its options.`);
    expect((await o.state()).open.map((a: any) => a.title)).not.toContain("Left or right?");
  });

  test("the hud ask example keeps where the question goes and when it is due", async () => {
    expect((await hud("lane", "app-lane")).code).toBe(0);
    const r = await hud("ask", "--title", "Ship?", "--lane", "app-lane", "--kind", "decision", "--opt", "Now", "--opt", "Later", "--link", "https://example.com/pr/1", "--due", "17:30");
    expect(r.code).toBe(1);
    expect(r.err).toContain(`hud ask --title 'Ship?' --lane 'app-lane' --kind 'decision' --opt 'Now' --opt 'Later' --rec 'Now' --body 'I recommend Now because ...' --link 'https://example.com/pr/1' --due 17:30`);
  });

  // An agent copies the example into its shell. Every value must arrive as it was, and nothing in it may run: a body is
  // markdown with newlines, $ and backticks. A stub hud prints the arguments the shell hands it.
  // Each shell without its startup files, so this machine's profile cannot change what it does with the line.
  const SHELL_ARGS: Record<string, string[]> = { bash: ["bash", "--noprofile", "--norc", "-c"], zsh: ["zsh", "-f", "-c"] };
  const SHELLS = Object.keys(SHELL_ARGS).filter((sh) => Bun.which(sh));
  for (const sh of Object.keys(SHELL_ARGS)) if (!SHELLS.includes(sh)) console.warn(`ask-rec: ${sh} is not installed here, so the example is not run in it`);
  const ranInShell = async (sh: string, line: string) => {
    const proc = Bun.spawn([...SHELL_ARGS[sh], `hud() { for a in "$@"; do printf '%s\\0' "$a"; done; printf '\\036'; }\n${line}`], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.split("\x1e").filter(Boolean).map((cmd) => cmd.split("\0").filter((a, i, all) => i < all.length - 1));
  };
  const exampleOf = (err: string) => err.match(/Example:\n {2}([\s\S]*)\nA question with no options/)![1];
  const marker = join(o.data, "ran");
  const tricky = `line one\nline $HOME and \`touch ${marker}\` and it's "quoted"`;

  test("the hud ask example runs in a real shell with every value exactly as filed, and runs nothing", async () => {
    expect(SHELLS.length).toBeGreaterThan(0);
    const r = await hud("ask", "--title", "Ship $HOME?", "--body", tricky, "--opt", "Now", "--opt", "Later");
    expect(r.code).toBe(1);
    for (const sh of SHELLS) {
      const [args] = await ranInShell(sh, exampleOf(r.err));
      expect(args[args.indexOf("--title") + 1]).toBe("Ship $HOME?");
      expect(args[args.indexOf("--body") + 1]).toBe(tricky);
      expect(args[args.indexOf("--rec") + 1]).toBe("Now");
      expect(existsSync(marker)).toBe(false);
    }
  });

  test("the hud update example carries the whole refused edit, and runs in a real shell exactly as filed", async () => {
    expect(SHELLS.length).toBeGreaterThan(0);
    const { id } = (await (await o.send("/api/asks", { title: "Edit me" })).json()) as any;
    const r = await hud("update", String(id), "--title", "New $HOME title", "--body", tricky, "--link", "https://example.com/x", "--opt", "A", "--opt", "B");
    expect(r.code).toBe(1);
    // Nothing was applied.
    expect((await o.state()).open.find((a: any) => a.id === id).title).toBe("Edit me");
    for (const sh of SHELLS) {
      const [update, comment] = await ranInShell(sh, exampleOf(r.err));
      expect(update.slice(0, 2)).toEqual(["update", String(id)]);
      expect(update[update.indexOf("--title") + 1]).toBe("New $HOME title");
      expect(update[update.indexOf("--body") + 1]).toBe(tricky);
      expect(update[update.indexOf("--link") + 1]).toBe("https://example.com/x");
      expect(update[update.indexOf("--rec") + 1]).toBe("A");
      expect(comment.slice(0, 2)).toEqual(["comment", String(id)]);
      expect(existsSync(marker)).toBe(false);
    }
  });

  test("options and the pick are stored trimmed, so a padded option still shows as the pick", async () => {
    const r = await hud("ask", "--title", "Padded", "--opt", "Left ", "--opt", " Right", "--rec", " Left");
    expect(r.code).toBe(0);
    const a = (await o.state()).open.find((x: any) => x.title === "Padded");
    expect(a.options).toEqual(["Left", "Right"]);
    expect(a.recommended).toBe("Left");
    expect((await hud("update", String(a.id), "--opt", " Left", "--opt", "Up ")).code).toBe(0);
    expect((await o.state()).open.find((x: any) => x.id === a.id).options).toEqual(["Left", "Up"]);
  });

  test("a new pick on a row stored before trimming keeps matching its option", async () => {
    const { id } = (await (await o.send("/api/asks", { title: "Old row", options: ["Left", "Right"], recommended: "Left" })).json()) as any;
    const old = new Database(join(o.data, "hud.db"));
    old.query("UPDATE asks SET options = ?, recommended = ? WHERE id = ?").run(JSON.stringify(["Left ", "Right "]), "Left ", id);
    old.close();
    expect((await hud("update", String(id), "--rec", "Right ")).code).toBe(0);
    const a = (await o.state()).open.find((x: any) => x.id === id);
    expect(a.recommended).toBe("Right");
    expect(a.options).toContain(a.recommended);
  });

  test("the guide teaches the rule, with the same flag the refusal shows", () => {
    const line = GUIDE.split("\n").find((l) => l.includes("refuse options without"))!;
    expect(line).toContain("--rec A");
    expect(line).toContain("--opt A --opt B");
  });
});
