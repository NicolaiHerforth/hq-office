// The top bar: waiting count, oldest wait, working, on HQ, bank, machines. With floors it counts every floor. HQ's
// unread messages are the MESSAGES tab's count.
import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { dur, esc, setClass, setHTML, setText } from "../core/format.js";
import { on } from "../core/bus.js";
import { officeOf, readingOf } from "../core/floors.js";

// All machines in one small box: one square per machine, and a word. It only speaks up when one is past 90% CPU or
// memory, or offline. The per-machine numbers are in the tooltip.
export function renderMachines() {
  const ms = S.machines ?? [];
  const rows = ms.map(({ machine, sample, age, ok }) => {
    const name = machine.toUpperCase();
    if (!sample || !ok) return { name, state: "off", tip: `${name}: offline${sample?.error ? ` (${sample.error})` : ""}` };
    const bad = sample.cpu_busy > 90 || sample.mem_used > 90;
    return { name, state: bad ? "bad" : "", cpu: Math.round(sample.cpu_busy), mem: Math.round(sample.mem_used), tip: `${name}: CPU ${Math.round(sample.cpu_busy)}% · MEM ${Math.round(sample.mem_used)}% · load ${sample.load1.toFixed(1)} on ${sample.cores} cores, ${dur(age)} ago` };
  });
  const bad = rows.find((r) => r.state === "bad"), off = rows.find((r) => r.state === "off");
  const word = bad ? `${bad.name} ${Math.max(bad.cpu, bad.mem)}%` : off ? `${off.name} OFF` : rows.length ? "OK" : "-";
  const box = $("machines");
  setClass(box, "box health " + (bad ? "bad" : off ? "off" : ""));
  const tip = rows.map((r) => r.tip).join("\n");
  if (box.title !== tip) box.title = tip;
  setHTML(box, `<span class="k">MACHINES</span><span class="v">${rows.map((r) => `<i class="${r.state}"></i>`).join("")}${esc(word)}</span>`);
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
  setClass($("sMove").closest(".strip"), "box strip" + (o.stall ? ` stall${o.stall === 2 ? " late" : ""}` : ""));
  setText($("sMove").previousElementSibling, o.stall ? "NOTHING MOVING" : "WORKING");
  setText($("sHq"), S.lanes.filter((l) => ["hq_turn", "stale", "gone"].includes(l.status)).length);
  setText($("sBank"), S.score.bank);
  // Any floor's HQ (docs/floors.md); with one floor, S.hq.
  const down = S.hq?.ok === false || (S.floors ?? []).some((f) => f.receiving === false);
  const title = (down ? "HQ ISN'T RECEIVING · " : "") + (n ? `(${n}) HQ Office` : "HQ Office");
  if (document.title !== title) document.title = title;
}
