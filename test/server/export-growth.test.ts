// A small page must not be able to hang the server: no search over a page's text in brief-export*.ts may blow up with its
// size. Each case runs in a process of its own that doubles the input; the test compares the time at 8x the size with the
// time at 1x, from the first size slow enough to time, so a fast or a loaded machine gets the same answer. Linear is 8,
// quadratic 64. A case that takes 30 s over one step is killed and fails; the kill is only ever reached by a blow-up.
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CASES } from "../export-growth-child.ts";

const MAX_GROWTH = 24, STEP_MS = 30_000;
const CHILD = join(import.meta.dir, "..", "export-growth-child.ts");
const DATA = mkdtempSync(join(tmpdir(), "hq-export-growth-")), SUBS = mkdtempSync(join(tmpdir(), "hq-export-growth-subs-"));
const env = { ...process.env, HUD_DATA_DIR: DATA, HUD_SUBS_HOME: SUBS };
afterAll(() => { for (const dir of [DATA, SUBS]) rmSync(dir, { recursive: true, force: true }); });

async function growth(name: string) {
  const child = Bun.spawn([process.execPath, CHILD, name], { env, stdout: "pipe", stderr: "pipe" });
  let timer = setTimeout(() => child.kill("SIGKILL"), STEP_MS), text = "";
  const reading = (async () => {
    for await (const chunk of child.stdout) {
      text += new TextDecoder().decode(chunk);
      clearTimeout(timer);
      timer = setTimeout(() => child.kill("SIGKILL"), STEP_MS);
    }
  })();
  const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited, reading]);
  clearTimeout(timer);
  const sizes = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { bytes: number; ms: number });
  const curve = sizes.slice(-4).map((s) => `${s.bytes}:${s.ms.toFixed(1)}`).join(" ");
  if (code !== 0) return { growth: Infinity, why: child.signalCode ? `no answer at ${STEP_MS / 1000} s, ${sizes.at(-1)?.bytes} bytes done`: err.slice(0, 300), curve };
  const timed = sizes.filter((s) => s.ms >= 10);
  if (timed.length < 4) return { growth: 0, why: "too fast to time at the largest size", curve };
  const [a, b] = [timed.at(-4)!, timed.at(-1)!];
  return { growth: b.ms / a.ms, why: `${a.bytes} bytes ${a.ms.toFixed(1)} ms, ${b.bytes} bytes ${b.ms.toFixed(1)} ms`, curve };
}

for (const name of Object.keys(CASES)) {
  test(`${name} grows with its size`, async () => {
    // A busy moment can spoil one reading, so a high one gets a second look. A case that had to be killed does not.
    let got = await growth(name);
    if (got.growth > MAX_GROWTH && got.growth !== Infinity) got = await growth(name);
    if (process.env.GROWTH_LOG) appendFileSync(process.env.GROWTH_LOG, `${name.padEnd(46)} x${got.growth.toFixed(1).padStart(6)}  ${got.curve}\n`);
    expect(`${got.growth <= MAX_GROWTH ? "ok" : "blew up"}: ${got.why}`).toStartWith("ok");
  }, 4 * STEP_MS);
}
