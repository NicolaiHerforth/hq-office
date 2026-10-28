// Where the layer over the room puts things, as pure geometry in the room's own units (a 16 px tile, the room 24 by 16
// tiles: 384 by 256), so `bun test` imports it. Frames hang on the wall in a few fixed places; a marker takes the nearest
// spot beside the agent it marks that is clear of everything the room draws there. No DOM.

export const TILE = 16, RW = 24 * TILE, RH = 16 * TILE;

// Where frames hang: at the two ends of each stretch of wall between the windows (x 64 to 112, 144 to 192) and between
// the last window and the sign (224 to 272), then the corner. A season's wall decoration tends to hang in a stretch's middle.
export const WALL = [66, 97, 146, 177, 226, 257, 8];
export const FRAME = { y: 8, w: 14, h: 12 };
// What the layer never paints over: the three windows, the sign, your counter, the terminal (x, y, w, h).
export const KEEP_CLEAR = [[32, 4, 32, 18], [112, 4, 32, 18], [192, 4, 32, 18], [272, 5, 96, 18], [272, 46, 96, 10], [256, 66, 16, 14]];
// The head's figure at the terminal (room/loop.js draws it at 16 by 5 tiles, 6 up).
export const TERMINAL = { sx: 16 * TILE, sy: 5 * TILE - 6 };

// Wall places for the first n frames, each as { x, y, w, h }.
export const frameSlots = (n) => WALL.slice(0, n).map((x) => ({ x, ...FRAME }));
// A frame's click area: the frame, its nail above and its frame edge.
export const frameBox = (f) => ({ x: f.x - 1, y: f.y - 3, w: f.w + 2, h: f.h + 5 });

// Do two boxes meet, with `m` px to spare?
export const meets = (a, b, m = 1) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;
// A sprite is 16 by 16 with its top 6 above its tile; a hat sits above it, and input.js's click area runs 22 down.
export const figure = (sx, sy) => ({ x: sx, y: sy - 3, w: 16, h: 25 });
// A bubble is 10 by 11, up to 12 above the sprite, from 9 across (room/scene.js drawBubble).
export const bubble = (sx, sy) => ({ x: sx + 9, y: sy - 12, w: 10, h: 14 });

// Zoomed out the room is small on screen, so its markers are bigger.
export const MARK_SIZE = { in: { w: 7, h: 9 }, out: { w: 12, h: 15 } };
const REACH = { in: 24, out: 28 };

// Where a marker may sit, as offsets of its corner from the sprite's, nearest first and the left side before the right.
// Cached by size: the list is the same for every agent.
const SPOTS = new Map();
function spotsFor(mode) {
  let list = SPOTS.get(mode);
  if (list) return list;
  const { w, h } = MARK_SIZE[mode];
  list = [];
  for (let dx = -(w + 32); dx <= 40; dx++) {
    for (let dy = -(h + 16); dy <= 30; dy++) {
      const cx = dx + w / 2, cy = dy + h / 2;
      const cost = Math.hypot(cx - 8, cy - 4) + (cx > 8 ? 0.5 : 0);
      if (cost <= REACH[mode]) list.push({ dx, dy, cost });
    }
  }
  list.sort((a, b) => a.cost - b.cost || a.dx - b.dx || a.dy - b.dy);
  SPOTS.set(mode, list);
  return list;
}

// A marker for each agent in `agents` ({ lane, state, sx, sy }: its sprite's corner), at the nearest spot that is clear of:
// every label (`labels`, boxes), every sprite and bubble (`sprites`, corners), the general at the terminal, the wall pieces,
// the room's edge and the markers already placed. An agent with no clear spot gets no marker; the NEED HELP rows list it.
export function placeMarks({ agents, sprites = [], labels = [], zoomedIn }) {
  const mode = zoomedIn ? "in" : "out", { w, h } = MARK_SIZE[mode], spots = spotsFor(mode);
  const avoid = [
    ...labels,
    ...[...sprites, TERMINAL].flatMap((p) => [figure(p.sx, p.sy), bubble(p.sx, p.sy)]),
    ...KEEP_CLEAR.map(([x, y, kw, kh]) => ({ x, y, w: kw, h: kh })),
  ];
  const clear = (b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= RW && b.y + b.h <= RH && !avoid.some((a) => meets(a, b)) && !placed.some((p) => meets(p.box, b));
  const placed = [];
  for (const a of agents) {
    for (const s of spots) {
      const box = { x: a.sx + s.dx, y: a.sy + s.dy, w, h };
      if (clear(box)) { placed.push({ ...a, box }); break; }
    }
  }
  return placed;
}
