// Linear-regression estimate of an auction's winning bid, from
// data/price_model.json (price_model.py). Reloaded when the file changes.
import * as fs from "node:fs";
import * as path from "node:path";
import { LETTER_VALUE } from "./letters.js";

const FILE = path.join(process.cwd(), "data", "price_model.json");
const BAG: Record<string, number> = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4, M: 2,
  N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1, Y: 2, Z: 1,
};
const AUCTIONS_PER_MATCH = 68; // 98 tiles - 6 x 5 dealt
let coef: number[] | null = null;
let mtime = 0;

export function predictedTopBid(letter: string, bagRemaining: number | undefined): number | null {
  try {
    const m = fs.statSync(FILE).mtimeMs;
    if (m !== mtime) {
      coef = JSON.parse(fs.readFileSync(FILE, "utf8")).coef;
      mtime = m;
    }
  } catch {
    return null;
  }
  if (!coef || !(letter in BAG)) return null;
  const stage = bagRemaining === undefined ? 0.5 : Math.min(1, Math.max(0, 1 - bagRemaining / AUCTIONS_PER_MATCH));
  const x = [1, LETTER_VALUE[letter], "AEIOU".includes(letter) ? 1 : 0, BAG[letter] / 98, stage, stage * stage];
  return x.reduce((s, v, i) => s + v * coef![i], 0);
}
