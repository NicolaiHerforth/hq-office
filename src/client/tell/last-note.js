// Under Tell HQ: only your last note and where it stands with HQ. The whole conversation, your answers included, is
// the MESSAGES thread.
import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { clock, setHTML } from "../core/format.js";
import { mdInline } from "../core/markdown.js";
import { pick } from "../core/scope.js";
import { linkOf } from "../core/floors.js";

// Where a note or an answer stands with HQ (S.hq.deliveries, see hq-link.ts): acked by HQ, delivered (HQ started
// working on it), typed in while HQ was busy (sent again once it is free), or held (not typed in yet).
// Each floor's HQ has its own link (S.hqLinks); the first floor's is S.hq.
const held = (link, ref) => (link?.held ?? []).some((h) => h.ref === ref);
const mark = (color, text) => `<span style="color:var(--${color})">· ${text}</span>`;
export function deliveryMark(ref, acked, ackedText, waitingText, floor) {
  if (acked) return mark("green", ackedText);
  const link = linkOf(S, floor);
  if (held(link, ref)) return mark("red", "HELD: HQ isn't receiving");
  const d = link?.deliveries?.[ref];
  if (d === "held") return mark("amber", "sending to HQ");
  if (d === "unconfirmed") return mark("amber", "typed in while HQ was busy; sent again once it is free");
  if (d === "delivered") return mark("green", "delivered to HQ");
  return mark("amber", waitingText);
}
export const noteMark = (n) => deliveryMark(`note:${n.id}`, !!n.acked_at, "HQ has it", "not picked up yet", n.floor);
export function renderLastNote() {
  if (!S) return;
  const n = pick(S.notes)[0];
  setHTML($("lastNote"), n
    ? `<b>LAST ${clock(n.at)}</b>${mdInline(n.text)} ${noteMark(n)}`
    : `<span style="color:var(--muted)">Nothing sent yet today.</span>`);
}
