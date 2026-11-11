// REQUESTS, the part with no page in it: which requests still run, which have not moved for more than a day, and the
// order they are read in. Pure functions of S.requests and a time, so the tab, its badge and the tests agree.
export const DAY = 86_400_000;
export const STATUS = { new: "NEW", open: "OPEN", assigned: "ASSIGNED", waiting: "WAITING ON YOU", delivered: "DELIVERED", withdrawn: "WITHDRAWN" };
const LIVE = new Set(["new", "open", "assigned", "waiting"]);

// Still on its way: not delivered, not given up.
export const live = (r) => LIVE.has(r.status);
// Over, and shown until the owner has seen it: delivered, or withdrawn by HQ with its reason.
export const ended = (r) => r.status === "delivered" || r.status === "withdrawn";
// When it last moved; one nobody has touched yet has only the time it was sent.
export const movedAt = (r) => r.movedAt ?? r.at;
// Amber: on its way and unmoved for more than a day.
export const stale = (r, now) => live(r) && now - movedAt(r) > DAY;
export const staleCount = (list, now) => list.filter((r) => stale(r, now)).length;
export const oldestFirst = (list) => [...list].sort((a, b) => a.at - b.at || a.id - b.id);
// The next moment a request turns amber by itself, or null: the one time the tab changes with no news from the server.
export function nextStaleAt(list, now) {
  const at = list.filter((r) => live(r) && !stale(r, now)).map((r) => movedAt(r) + DAY + 1);
  return at.length ? Math.min(...at) : null;
}
// A PR as HQ gave it: "12", "#12" or its address. The number when there is one, to link it in the configured repo.
export function prOf(pr) {
  const s = String(pr ?? "").trim();
  if (!s) return null;
  if (/^https?:\/\/\S+$/.test(s)) return { href: s, label: s.match(/\/pull\/(\d+)/) ? `PR #${s.match(/\/pull\/(\d+)/)[1]}` : "PR" };
  const n = s.match(/^#?(\d{1,9})$/)?.[1];
  return n ? { number: n, label: `PR #${n}` } : { label: `PR ${s}` };
}
