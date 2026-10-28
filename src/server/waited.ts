// The minutes an ask waited between `from` and `to`, leaving out the spans the owner deferred it for (ask_defers). No
// database, so the bank (score.ts) and its tests share it without opening one.
export function waitedMinutes(from: number, to: number, defers: { from_at: number; to_at: number }[]) {
  const off = defers.reduce((ms, d) => ms + Math.max(0, Math.min(to, d.to_at) - Math.max(from, d.from_at)), 0);
  return Math.floor((to - from - off) / 60_000);
}
