// What a lane is (hud lane NAME --role R), worn so it shows at a glance: an orchestrator wears a headset, a PM
// carries a clipboard, a builder wears a hard hat, a walker carries a magnifying glass. Each is an accessory in the
// format of accessory-table.js. A lane with a role wears no season's hat or hand item, so a season's yellow hat is
// never read as a hard hat; its name tag takes the role's colour too.
import { wornBy } from "./accessories.js";

export const ROLE_ITEMS = {
  orchestrator: { id: "role-headset", slot: "head", seasons: "any", pal: { g: "#f0a830", G: "#3a3a4a", m: "#d63c3c" },
    front: { x: -2, y: -1, rows: [".....kkkkkkkkkk.....", "...kkggggggggggkk...", "..kg............gk..", "..kg............gk..", "..kg............gk..", ".kGGk..........kGGk.", ".kGGk..........kGGk.", "..kk...........kgk..", "..............kgk...", ".............kmk....", "..............k....."] },
    side: { x: -2, y: -1, rows: [".....kkkkkkkkkk.....", "...kkggggggggggkk...", "........kgk.........", "........kgk.........", "........kgk.........", ".......kGGGk........", ".......kGGGk........", "........kkgk........", "...........kgk......", "............kgkmk...", "..............kk...."] } },
  pm: { id: "role-clipboard", slot: "hand", seasons: "any", pal: { b: "#a0703a", w: "#f8f8f0", l: "#8a8aa8", y: "#c8c8d8" },
    hand: { y: 6, rows: ["...........kyyk.", "..........kbyybk", "..........kwwwwk", "..........kwllwk", "..........kwwwwk", "..........kwllwk", "..........kwwwwk", "..........kbbbbk", "...........kkkk."] } },
  builder: { id: "role-hardhat", slot: "head", seasons: "any", pal: { y: "#f0c030", Y: "#c08a10", l: "#ffe070" },
    front: { x: -2, y: -3, rows: [".......kkkkkk.......", ".....kkyyyyyykk.....", "....kylyyyyyyyyk....", "...kylyyyyYyyyyyk...", "...kyyyyyyYyyyyyk...", "..kkkkkkkkkkkkkkkk..", ".kYYYYYYYYYYYYYYYYk.", "..kkkkkkkkkkkkkkkk.."] },
    side: { x: -2, y: -3, rows: [".......kkkkkk.......", ".....kkyyyyyykk.....", "....kylyyyyyyyyk....", "...kylyyyyYyyyyyk...", "...kyyyyyyYyyyyyk...", "..kkkkkkkkkkkkkkkkk.", ".kYYYYYYYYYYYYYYYYYk", "..kkkkkkkkkkkkkkkkk."] } },
  walker: { id: "role-magnifier", slot: "hand", seasons: "any", pal: { g: "#bfe4ff", w: "#ffffff", b: "#7a5232" },
    hand: { y: 3, rows: ["...........kkk..", "..........kgggk.", ".........kgwggk.", ".........kggggk.", "..........kggk..", "...........kk...", "...........kb...", "...........kb...", "...........kb..."] } },
};
export const ROLE_COLOR = { orchestrator: "#9a6a10", pm: "#6a3cb0", builder: "rgba(35,35,58,.62)", walker: "#1e7a7a" };

// What a worker wears: the season's body item, if any, and the role's item. Kept per worn list, so the art cache
// (keyed by the list) sees the same list every frame.
const withRole = new WeakMap();
export function wornWithRole(name, role) {
  const worn = wornBy(name), item = ROLE_ITEMS[role];
  if (!item) return worn;
  let byRole = withRole.get(worn);
  if (!byRole) withRole.set(worn, (byRole = new Map()));
  let out = byRole.get(role);
  if (!out) byRole.set(role, (out = [...worn.filter((a) => a.slot === "body"), item]));
  return out;
}
