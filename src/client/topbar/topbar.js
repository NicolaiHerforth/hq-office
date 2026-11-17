// The top bar: waiting count, oldest wait, working, on HQ, bank, machines. With floors it counts every floor. HQ's
// unread messages are the MESSAGES tab's count.
import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { dur, esc, setClass, setHTML, setText } from "../core/format.js";
import { on } from "../core/bus.js";
import { officeOf, readingOf } from "../core/floors.js";
import { bossOf } from "../core/status.js";
import "./fit.js";

// All machines in one small box: one square per machine, and a word. It only speaks up when one is past 90% CPU or
// memory, or offline. The per-machine numbers are in the tooltip. The word's machine has the square marked w, and its
// name is the long part: a full top bar keeps only that square, then only the number (fit.js).
// The machine the monitor runs on is the exception: its word is the monitor's (S.monitor, there only while the
// monitor has a fresh sample), so this box and the monitor's page never disagree about it. A machine that swaps by
// design reads past 90% of memory for days and is not capped.
const MONITOR = [{ state: "", word: "OK" }, { state: "close", word: "CLOSE" }, { state: "bad", word: "CAPPED" }];
export function renderMachines() {
  const ms = S.machines ?? [];
  const rows = ms.map(({ machine, sample, ok }) => {
    const name = machine.toUpperCase();
    const monitor = S.monitor?.machine === machine ? S.monitor : null;
    if (!monitor && (!sample || !ok)) return { name, state: "off", word: "OFF", tip: `${name}: offline${sample?.error ? ` (${sample.error})` : ""}` };
    const read = sample && ok ? `CPU ${Math.round(sample.cpu_busy)}% · MEM ${Math.round(sample.mem_used)}% · load ${sample.load1.toFixed(1)} on ${sample.cores} cores, ${dur(Date.now() - sample.at)} ago` : "";
    if (monitor) return { name, here: true, ...MONITOR[monitor.state], tip: `${name}: ${monitor.said}${read && ` · ${read}`}` };
    const bad = sample.cpu_busy > 90 || sample.mem_used > 90;
    return { name, state: bad ? "bad" : "", word: bad ? `${Math.round(Math.max(sample.cpu_busy, sample.mem_used))}%` : "OK", tip: `${name}: ${read}` };
  });
  const named = ["bad", "off", "close"].map((state) => rows.find((r) => r.state === state)).find(Boolean) ?? rows[0];
  const word = named?.word ?? "-";
  // On a phone an alarmed box shares its row with the floor switch. The monitor's words are longer than a percentage,
  // and the machine it speaks of is this one: there the name goes (topbar.css), so the switch keeps its room.
  const name = named?.state ? `<span class="long${named.here ? " here" : ""}">${esc(named.name)} </span>` : "";
  const box = $("machines");
  setClass(box, "box health " + (named?.state ?? ""));
  const tip = rows.map((r) => r.tip).join("\n");
  if (box.title !== tip) box.title = tip;
  setHTML(box, `<span class="k">MACHINES</span><span class="v">${rows.map((r) => `<i class="${r.state}${r === named ? " w" : ""}"></i>`).join("")}<span>${name}${word}</span></span>`);
}

let stallStep = 0;
// The page clock: the office's stall shows after 3 minutes and reddens after 20.
on("tick", () => { if (S && readingOf(officeOf(S)).stall !== stallStep) renderStats(); });
// The top bar. The oldest wait ticks with the page clock (tick), the rest changes only with the state.
export function renderStats() {
  const n = S.open.length;
  const sw = $("sWait");
  setClass(sw, "box urgent " + (n ? "alert" : "ok"));
  setText(sw.querySelector(".count"), n);
  // WORKING: the office's readings (S.office), the same definitions as every floor's (docs/floors.md): working of
  // active, and the box turns amber, then red, when nothing moves and nothing waits on you.
  const o = readingOf(officeOf(S));
  setText($("sMove"), `${o.working}/${Math.max(o.active, o.working)}`);
  stallStep = o.stall;
  setClass($("sMove").closest(".strip"), "box strip" + (o.stall ? ` nomove${o.stall === 2 ? " late" : ""}` : ""));
  setHTML($("sMove").previousElementSibling, o.stall ? `<span class="long">NOTHING MOVING</span><span class="short">STALLED</span>` : "WORKING");
  // ON HQ: lanes whose boss is HQ; one waiting on the lane it reports to is that lane's to move.
  setText($("sHq"), S.lanes.filter((l) => ["hq_turn", "stale", "gone"].includes(l.status) && !bossOf(l)).length);
  setText($("sBank"), S.score.bank);
  setText($("mBank"), S.score.bank);
  // HQ QUEUE (when on): what waits in every floor's HQ queue, unread plus waiting for HQ's answer; red when unread.
  const q = S.queue?.on ? Object.values(S.queue.floors ?? {}).reduce((n, f) => ({ unread: n.unread + f.unread, waiting: n.waiting + f.waiting }), { unread: 0, waiting: 0 }) : null;
  $("sQueueCell").hidden = !q;
  if (q) {
    setText($("sQueue"), q.unread + q.waiting);
    $("sQueue").classList.toggle("hot", q.unread > 0);
    $("sQueueCell").title = `${q.unread} unread in HQ's queue, ${q.waiting} waiting for HQ's answer`;
  }
  // Any floor's HQ (docs/floors.md); with one floor, S.hq.
  const down = S.hq?.ok === false || (S.floors ?? []).some((f) => f.receiving === false);
  const title = (down ? "HQ ISN'T RECEIVING · " : "") + (n ? `(${n}) HQ Office` : "HQ Office");
  if (document.title !== title) document.title = title;
}
