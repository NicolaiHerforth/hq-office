// Loads the state, renders every panel, listens to the server's stream and reloads the page when its files change.
import { PANELS, keepDrafts } from "../questions/drafts.js";
import { CONFIG, S, setCONFIG, setS } from "./state.js";
import { announce } from "../questions/announce.js";
import { announceUpdates } from "../messages/messages.js";
import { syncWorkers } from "../room/workers.js";
import { scheduleTick, tick } from "../questions/questions.js";
import { emit } from "./bus.js";

let first = true, pageStamp = null;
function apply(part, whole) {
  setS(whole ? part : Object.assign(S, part));
  const changed = (k) => whole || k in part;
  setCONFIG(S.config ?? CONFIG);
  if (pageStamp == null) pageStamp = S.page;
  else if (S.page !== pageStamp) { keepDrafts(); location.reload(); return; }
  if (changed("open")) announce();
  if (changed("updates")) announceUpdates();
  if (changed("lanes") || changed("open")) { syncWorkers(first); first = false; }
  for (const [keys, render] of PANELS) if (keys.some(changed)) render();
  emit("state", S);
  tick();
  scheduleTick();
}
async function load() { apply(await (await fetch("/api/state")).json(), true); }
let stream = null;
function connect() {
  const es = (stream = new EventSource("/api/stream"));
  es.onmessage = (e) => {
    if (e.data[0] === "{") { apply(JSON.parse(e.data), !S); return; }
    // An older server sends only its version number, and the page fetches the whole state.
    if (!S || Number(e.data) !== S.version) load().catch(() => {});
  };
}
// A page that goes away (reload, navigation, or into the back-forward cache) closes its stream, so old streams
// never hold the browser's six connections to this server. Shown again from that cache, it opens a new one.
addEventListener("pagehide", () => { stream?.close(); stream = null; });
addEventListener("pageshow", (e) => { if (e.persisted && !stream) connect(); });
connect();
