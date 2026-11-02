// Who an ask is for: the lane that asked it (S.askers, a PM asking for its lanes), else HQ. Its answer goes there.
import { S } from "../core/state.js";

export const askerOf = (a) => S?.askers?.[a.id]?.name ?? null;
export const forWhom = (a) => askerOf(a) ?? "HQ";
// The asker's pick: its name when short enough for the chip, else PICK.
export const pickWord = (a) => { const w = forWhom(a).toUpperCase(); return w.length <= 12 ? `${w} PICK` : "PICK"; };
// Where an answer sent now stands: typed in at once, or kept while the asker is away or busy (S.askers[id].now).
export const keptFor = (a) => S?.askers?.[a.id]?.now ?? null;
