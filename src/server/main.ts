// Starts the server: loads every module in the order server.ts ran them, then the herdr sync and the machine
// sampler.
import "./config.ts";
import "./db.ts";
import "./types.ts";
import "./push.ts";
import "./updates.ts";
import "./events.ts";
import "./herdr.ts";
import "./lanes.ts";
import "./score.ts";
import "./state.ts";
import "./inbox.ts";
import "./asks.ts";
import "./machines.ts";
import "./work-board.ts";
import "./the-page-stream.ts";
import "./json.ts";
import "./http.ts";
import { HOST, PORT, SYNC_MS } from "./config.ts";
import { syncHerdr } from "./herdr.ts";
import { STATS_MS, sampleMachines } from "./machines.ts";
import { board } from "./work-board.ts";
import { watchStalls } from "./stall-watch.ts";

syncHerdr();
setInterval(() => void syncHerdr(), SYNC_MS);
// Fills the GitHub cache once, and starts the board poll if there are open items.
board.refresh(0).catch(() => {});
// The machine sample bumps once a minute, which also keeps stale detection and the score fresh;
// timers on the page tick on their own.
sampleMachines();
setInterval(sampleMachines, STATS_MS);
// A thread that stops is noticed, logged and, under a service, ended so it starts again (stall-watch.ts).
watchStalls();
console.log(`${new Date().toISOString()} HQ command centre on http://${HOST}:${PORT}`);
