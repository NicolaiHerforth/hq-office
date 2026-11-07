// A PDF of an exported page (brief-export.ts builds the page). Only on request, one at a time, and nothing stays running:
// each print starts its own helper program (brief-export-print-helper.ts), which starts its own Chrome with a temporary
// profile and drives it. The server holds no descriptor of Chrome's: if the helper or Chrome dies, one PDF fails and says
// so. What stays here is what Chrome must not hold: the document it prints, served once, and the profile's removal.
import { existsSync, mkdtempSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HOST, PORT, TRUSTED_ORIGINS } from "./config.ts";
import type { PrintJob } from "./brief-export-print-helper.ts";

export const NO_CHROME = "This machine has no Chrome, so HQ Office cannot make a PDF here. Install Google Chrome or set HUD_CHROME_PATH to a Chrome or Chromium browser, then try again. Or download the HTML file and print it from your browser.";
const CHROMES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
];
export function findChrome() {
  const set = process.env.HUD_CHROME_PATH;
  if (set !== undefined) return existsSync(set) ? set : null;
  return CHROMES.find((p) => existsSync(p)) ?? null;
}

const TIMEOUT_MS = Number(process.env.HUD_PRINT_TIMEOUT_MS ?? 60_000);
// The helper keeps its own time limit; this is for a helper that cannot, with room for it to close Chrome.
const HELPER_GRACE_MS = 15_000;
const HELPER = join(import.meta.dir, "brief-export-print-helper.ts");
// The owner's pid is in the name, so the next print can tell a profile left by a server that died from one in use.
const PROFILE_PREFIX = "hq-office-print-";
const HELPER_DIED = "The program that prints stopped before the PDF was made. HQ Office itself is fine. Download the HTML file and print it from your browser, or try again.";

// The served document: one read, then it is gone.
const jobs = new Map<string, string>();
export function takePrintJob(token: string) {
  const html = jobs.get(token);
  jobs.delete(token);
  return html ?? null;
}

export const trustedHosts = () => TRUSTED_ORIGINS.flatMap((o) => { try { return [new URL(o).hostname.toLowerCase()]; } catch { return []; } });

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};
// A server that died leaves its profile: the next print clears any whose owner is gone, and any old enough not to be in use.
function sweepOldProfiles() {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const path = join(tmpdir(), name), owner = Number(name.slice(PROFILE_PREFIX.length).match(/^(\d+)-/)?.[1]);
    try { if ((owner && !alive(owner)) || Date.now() - statSync(path).mtimeMs > 3_600_000) removeProfile(path); } catch {}
  }
}

// Now, and once more shortly: the helpers of a Chrome that had to be killed can still write there for a moment.
function removeProfile(profile: string) {
  const remove = () => { try { rmSync(profile, { recursive: true, force: true }); } catch {} };
  // Chrome keeps its singleton socket in a folder of its own in the temp dir, linked from the profile.
  try { rmSync(dirname(readlinkSync(join(profile, "SingletonSocket"))), { recursive: true, force: true }); } catch {}
  remove();
  setTimeout(remove, 4000).unref?.();
}

type Job = { html: string; title: string; date: string; ink: string };
type Printed = { pdf: Uint8Array; warnings: string[]; unfinished: boolean };

async function print(job: Job, bin: string): Promise<Printed> {
  sweepOldProfiles();
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const host = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST.includes(":") ? `[${HOST}]` : HOST;
  const printUrl = `http://${host}:${PORT}/exports/print/${token}`;
  jobs.set(token, job.html);
  const profile = mkdtempSync(join(tmpdir(), `${PROFILE_PREFIX}${process.pid}-`));
  let chrome = 0;
  try {
    const ask: PrintJob = { bin, printUrl, profile, title: job.title, date: job.date, ink: job.ink, timeoutMs: TIMEOUT_MS, trusted: trustedHosts() };
    // Its folder is the new, empty profile: bun reads a config and an env file from where it starts.
    const helper = Bun.spawn([process.execPath, HELPER], {
      cwd: profile,
      stdin: new Blob([JSON.stringify(ask)]),
      stdout: "pipe",
      stderr: "ignore",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? profile, TMPDIR: process.env.TMPDIR ?? tmpdir() },
    });
    const limit = setTimeout(() => helper.kill("SIGKILL"), TIMEOUT_MS + HELPER_GRACE_MS);
    const lines = (await new Response(helper.stdout).text().catch(() => "")).split("\n").filter(Boolean);
    await helper.exited;
    clearTimeout(limit);
    let answer: { pdf?: string; warnings?: string[]; unfinished?: boolean; error?: string } = {};
    for (const line of lines) {
      try {
        const m = JSON.parse(line);
        if (m.chrome) chrome = m.chrome; else answer = m;
      } catch {}
    }
    if (answer.error) throw new Error(answer.error);
    if (!answer.pdf) throw new Error(HELPER_DIED);
    chrome = 0;
    return { pdf: Buffer.from(answer.pdf, "base64"), warnings: answer.warnings ?? [], unfinished: !!answer.unfinished };
  } finally {
    jobs.delete(token);
    // A helper that was killed cannot close its Chrome, which would otherwise wait on a pipe nobody writes to.
    if (chrome) { try { process.kill(chrome, "SIGKILL"); } catch {} await Bun.sleep(200); }
    removeProfile(profile);
  }
}

let tail: Promise<unknown> = Promise.resolve();
export function printPdf(job: Job): Promise<Printed> {
  const bin = findChrome();
  if (!bin) return Promise.reject(new Error(NO_CHROME));
  const run = tail.then(() => print(job, bin));
  tail = run.catch(() => {});
  return run;
}
