// Settings from the environment: ports, paths, machines, the owner and links shown on the page.
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

// The repo root: the server is started from there (bun server.ts) and serves the page from there.
export const DIR = resolve(import.meta.dir, "..", "..");
// Data (database, uploads) lives beside the code unless HUD_DATA_DIR says otherwise.
export const DATA = process.env.HUD_DATA_DIR ?? DIR;
export const UPLOADS = `${DATA}/uploads`;
export const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
export const MAX_UPLOAD = 10 * 1024 * 1024;
mkdirSync(UPLOADS, { recursive: true });
export const PORT = Number(process.env.HUD_PORT ?? 4747);
export const HOST = process.env.HUD_HOST ?? "127.0.0.1";
// Page addresses besides this machine's own that may use the page, such as a Tailscale serve URL for a phone
// (https://name.tailnet.ts.net:4747). Comma-separated, exact. Secrets stay reachable from this machine's own page only.
export const TRUSTED_ORIGINS = (process.env.HUD_TRUSTED_ORIGINS ?? "").split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);
export const HERDR = process.env.HERDR_BIN ?? "herdr";
export const LOCAL = process.env.HUD_LOCAL_MACHINE ?? "local";
export const MACHINES = (process.env.HUD_MACHINES ?? LOCAL).split(",").map((m) => m.trim()).filter(Boolean);
// Shown on the page: the room's sign, and links from lanes to GitHub and Linear. Empty means no link.
export const CONFIG = {
  owner: process.env.HUD_OWNER ?? "",
  githubRepo: process.env.HUD_GITHUB_REPO ?? "",
  linearWorkspace: process.env.HUD_LINEAR_WORKSPACE ?? "",
};
// How messages to HQ and the event log name the person at the page: HUD_OWNER, else a neutral word.
export const OWNER = CONFIG.owner.trim() || "the owner";
// Version 0.1.0 logged the owner's events under this fixed word. Such rows read as the owner's.
export const LEGACY_OWNER_WHO = "nico";
export const whoOf = (who: string) => (who === LEGACY_OWNER_WHO ? OWNER : who);
export const SYNC_MS = 20_000;
export const STALE_MS = 15 * 60_000;
// The orchestration registry (JSON): which orchestrator or PM a lane's requests go to. Empty means everything goes to HQ.
export const ORCHESTRATION = (process.env.HUD_ORCHESTRATION ?? "").trim();
