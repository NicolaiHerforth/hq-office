// Lane status labels and colours. A contract shared by the card and anything else that names a status.
import { S } from "./state.js";
export const STATUS_TEXT = {
  blocked: ["Blocked on a prompt", "#b01e1e"], // blocked-prompts: its agent waits at a prompt in its herdr pane
  needs_you: ["Waiting on you", "#d63c3c"],
  hq_turn: ["Waiting on HQ", "#e0901e"],
  stale: ["Waiting on HQ 15+ min", "#c0501e"],
  gone: ["Agent gone", "#6a6a82"],
  moving: ["Working", "#2f9e57"],
  waiting: ["Waiting on CI / other", "#3c6fd6"],
  parked: ["Parked", "#6a6a82"],
  done: ["Done", "#2f9e57"],
};

// The lane a lane reports to, or null for HQ: straight under HQ, or under a floor's HQ that is also registered as a lane.
export const bossOf = (lane) => (lane.parent && !(S?.floors ?? []).some((f) => f.hq === lane.parent) ? lane.parent : null);

// A lane waiting on its boss waits on the lane it reports to (bossOf), or on HQ when it reports to HQ.
export function statusText(status, boss) {
  const [label, color] = STATUS_TEXT[status] ?? [status, "#6a6a82"];
  return [boss && (status === "hq_turn" || status === "stale") ? label.replace("HQ", boss) : label, color];
}
export const laneStatusText = (lane) => statusText(lane.status, bossOf(lane));
