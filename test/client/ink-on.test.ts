// The text on a floor's colour is whichever of ink and white reads better, and the flip sits where the two read the same.
import { expect, test } from "bun:test";
import { inkOn } from "../../src/client/core/floors.js";
import { FLOOR_PALETTE } from "../../src/server/floor-colors.ts";

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const expand = (c: string) => (c === "#fff" ? "#ffffff" : c);

test("every greyscale step, and every colour in the floor palette: the ink chosen has the higher contrast", () => {
  const grey = Array.from({ length: 256 }, (_, i) => `#${i.toString(16).padStart(2, "0").repeat(3)}`);
  for (const color of [...grey, ...FLOOR_PALETTE]) {
    const chosen = expand(inkOn(color)), other = chosen === "#ffffff" ? "#23233a" : "#ffffff";
    expect(contrast(chosen, color)).toBeGreaterThanOrEqual(contrast(other, color));
  }
});

test("no colour reads under 3.9:1, the worst the crossover of the two inks allows", () => {
  for (const color of Array.from({ length: 256 }, (_, i) => `#${i.toString(16).padStart(2, "0").repeat(3)}`)) expect(contrast(expand(inkOn(color)), color)).toBeGreaterThanOrEqual(3.9);
});

test("a colour that is not #rrggbb gets white", () => {
  expect(inkOn("teal")).toBe("#fff");
  expect(inkOn(undefined)).toBe("#fff");
});
