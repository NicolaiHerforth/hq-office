// A floor's colour is its identity; red, amber and green are reserved for the three readings (blocking, nothing
// moving, working: docs/floors.md, "The floor UI rules"), so no floor wears them. The palette is blue, teal, purple,
// magenta, slate, brown and cyan. A reserved colour (from before this rule, or asked for) becomes the nearest allowed
// one: red to magenta, amber and yellow to brown, green to teal. And no two floors wear one colour: a colour another
// floor wears moves to the nearest one nobody does (freeColor); only with all seven worn may a floor repeat one.
export const FLOOR_PALETTE = ["#3c6fd6", "#1a9a8a", "#7a4fc9", "#b0469a", "#5f6b85", "#8a5a3c", "#2a9fc9"];

function hsl(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}
// The status family a colour reads as, if any: "red", "amber" or "green"; null for a colour a floor may wear.
export function reservedAs(hex: string): "red" | "amber" | "green" | null {
  const { h, s, l } = hsl(hex.toLowerCase());
  if (s < 0.3 || l < 0.15 || l > 0.9) return null;
  if (h < 18 || h >= 340) return "red";
  if (h < 70) return l < 0.4 && s < 0.6 ? null : "amber"; // a dark, muted orange is brown
  if (h < 165) return "green";
  return null;
}
const INSTEAD = { red: "#b0469a", amber: "#8a5a3c", green: "#1a9a8a" } as const;
export function allowedColor(hex: string) {
  const c = hex.toLowerCase();
  const r = reservedAs(c);
  return r ? INSTEAD[r] : c;
}

// How far apart two colours look: the hue around the wheel first, then saturation and lightness.
function distance(a: string, b: string) {
  const x = hsl(a.toLowerCase()), y = hsl(b.toLowerCase());
  const dh = Math.min(Math.abs(x.h - y.h), 360 - Math.abs(x.h - y.h));
  return dh + Math.abs(x.s - y.s) * 50 + Math.abs(x.l - y.l) * 100;
}
// The colour a floor gets for `hex` when the other floors wear `worn`: the allowed colour itself if nobody wears it,
// else the nearest palette colour nobody wears, else (all seven worn) the allowed colour after all.
export function freeColor(hex: string, worn: Iterable<string>) {
  const c = allowedColor(hex), taken = new Set([...worn].map((w) => w.toLowerCase()));
  if (!taken.has(c)) return c;
  const free = FLOOR_PALETTE.filter((p) => !taken.has(p));
  return free.length ? free.reduce((best, p) => (distance(c, p) < distance(c, best) ? p : best)) : c;
}
