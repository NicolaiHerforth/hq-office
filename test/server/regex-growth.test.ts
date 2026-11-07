// A small page must not be able to hang the server: no search over text an agent wrote may blow up with its size. Each
// case runs in a process of its own that doubles the input; the test compares the time at 8x the size with the time at
// 1x, from the first size slow enough to time, so a fast or a loaded machine gets the same answer. Linear is 8,
// quadratic 64. A case that never comes back is killed and fails; the kill is only ever reached by a blow-up. The limit
// of 24 sits just above n^1.5 (22.6), so that shape passes here: a nesting staircase costs that, and is not caught.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CASES } from "../regex-growth-child.ts";

const MAX_GROWTH = 24, NO_ANSWER_MS = 15_000;
const CHILD = join(import.meta.dir, "..", "regex-growth-child.ts");
const DATA = mkdtempSync(join(tmpdir(), "hq-regex-growth-")), SUBS = mkdtempSync(join(tmpdir(), "hq-regex-growth-subs-"));
const env = { ...process.env, HUD_DATA_DIR: DATA, HUD_SUBS_HOME: SUBS };
afterAll(() => { for (const dir of [DATA, SUBS]) rmSync(dir, { recursive: true, force: true }); });

async function growth(name: string) {
  const child = Bun.spawn([process.execPath, CHILD, name], { env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), NO_ANSWER_MS);
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  const sizes = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { bytes: number; ms: number });
  if (code !== 0) return { growth: Infinity, why: child.signalCode ? `no answer at ${NO_ANSWER_MS / 1000} s, ${sizes.at(-1)?.bytes} bytes done` : err.slice(0, 300) };
  const timed = sizes.filter((s) => s.ms >= 10);
  if (timed.length < 4) return { growth: 0, why: "too fast to time at the largest size" };
  const [a, b] = [timed.at(-4)!, timed.at(-1)!];
  return { growth: b.ms / a.ms, why: `${a.bytes} bytes ${a.ms.toFixed(1)} ms, ${b.bytes} bytes ${b.ms.toFixed(1)} ms` };
}

for (const name of Object.keys(CASES)) {
  test(`${name} grows with its size`, async () => {
    // A busy moment can spoil one reading, so a high one gets a second look. A case that had to be killed does not.
    let got = await growth(name);
    if (got.growth > MAX_GROWTH && got.growth !== Infinity) got = await growth(name);
    expect(`${got.growth <= MAX_GROWTH ? "ok" : "blew up"}: ${got.why}`).toStartWith("ok");
  }, 2 * NO_ANSWER_MS + 5_000);
}
