// Monte Carlo letter valuation over a compact trie of the wordlist.
//
// estimateLetterValue samples future draws from the unseen pool and averages
// how much the auctioned letter raises the best single play.

import { payoutFor } from "./intel.js";
import { LETTER_VALUE } from "./letters.js";

// Trie as first-child / next-sibling arrays; node 0 is the root.
let letterOf = new Uint8Array(0);
let firstChild = new Int32Array(0);
let nextSibling = new Int32Array(0);
let terminal = new Uint8Array(0);
let ready = false;

const VALUES = new Int32Array(26);
for (let c = 0; c < 26; c++) VALUES[c] = LETTER_VALUE[String.fromCharCode(65 + c)] ?? 0;

export function initSimulator(dictionary: readonly string[]) {
  const L: number[] = [0];
  const FC: number[] = [-1];
  const NS: number[] = [-1];
  const T: number[] = [0];
  for (const word of dictionary) {
    let node = 0;
    for (let i = 0; i < word.length && node !== -1; i++) {
      const c = word.charCodeAt(i) - 65;
      if (c < 0 || c > 25) {
        node = -1;
        break;
      }
      let child = FC[node];
      let prev = -1;
      while (child !== -1 && L[child] !== c) {
        prev = child;
        child = NS[child];
      }
      if (child === -1) {
        child = L.length;
        L.push(c);
        FC.push(-1);
        NS.push(-1);
        T.push(0);
        if (prev === -1) FC[node] = child;
        else NS[prev] = child;
      }
      node = child;
    }
    if (node > 0 && word.length >= 2) T[node] = 1;
  }
  letterOf = Uint8Array.from(L);
  firstChild = Int32Array.from(FC);
  nextSibling = Int32Array.from(NS);
  terminal = Uint8Array.from(T);
  ready = true;
}

export function simulatorReady(): boolean {
  return ready;
}

// Best play value for letter counts `counts` (mutated and restored).
function bestValue(counts: Int32Array, bingoBonus: number): number {
  let best = 0;
  const visit = (node: number, depth: number, base: number) => {
    for (let child = firstChild[node]; child !== -1; child = nextSibling[child]) {
      const c = letterOf[child];
      if (counts[c] === 0) continue;
      counts[c]--;
      const b = base + VALUES[c];
      const d = depth + 1;
      if (terminal[child]) {
        const v = payoutFor(b, d) + (d >= 7 ? bingoBonus : 0);
        if (v > best) best = v;
      }
      visit(child, d, b);
      counts[c]++;
    }
  };
  visit(0, 0, 0);
  return best;
}

function toCounts(rack: Map<string, number>): Int32Array {
  const counts = new Int32Array(26);
  for (const [letter, n] of rack) {
    const c = letter.charCodeAt(0) - 65;
    if (c >= 0 && c < 26) counts[c] += n;
  }
  return counts;
}

// Best word `rack` can spell, by payout plus bingo bonus.
export function bestPlay(
  rack: Map<string, number>,
  bingoBonus = 0,
): { word: string; value: number } | null {
  const counts = toCounts(rack);
  const path: number[] = [];
  let best: { word: string; value: number } | null = null;
  const visit = (node: number, base: number) => {
    for (let child = firstChild[node]; child !== -1; child = nextSibling[child]) {
      const c = letterOf[child];
      if (counts[c] === 0) continue;
      counts[c]--;
      path.push(c);
      const b = base + VALUES[c];
      if (terminal[child]) {
        const v = payoutFor(b, path.length) + (path.length >= 7 ? bingoBonus : 0);
        if (!best || v > best.value) {
          best = { word: String.fromCharCode(...path.map((x) => x + 65)), value: v };
        }
      }
      visit(child, b);
      path.pop();
      counts[c]++;
    }
  };
  visit(0, 0);
  return best;
}

export interface EstimateOptions {
  rack: Map<string, number>;
  letter: string;
  unseen: Map<string, number>; // includes the letter being auctioned
  samples: number;
  drawSize: number;
  budgetMs: number;
  bingoBonus: number;
}

// Deterministic mode for the tuner: seeded per input, memoised, no time limit.
let cache: Map<string, { value: number; samples: number }> | null = null;
export function setDeterministic(on: boolean) {
  cache = on ? new Map() : null;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function estimateLetterValue(o: EstimateOptions): {
  value: number;
  samples: number;
} {
  const target = o.letter.charCodeAt(0) - 65;
  const pool: number[] = [];
  let skippedTarget = false;
  for (const [letter, n] of o.unseen) {
    const c = letter.charCodeAt(0) - 65;
    for (let i = 0; i < n; i++) {
      // The auctioned tile is already out of the bag.
      if (c === target && !skippedTarget) skippedTarget = true;
      else pool.push(c);
    }
  }

  let key = "";
  let rng = Math.random;
  if (cache) {
    key = [
      [...toCounts(o.rack)].join(","),
      o.letter,
      pool.slice().sort((a, b) => a - b).join(","),
      o.samples,
      o.drawSize,
      o.bingoBonus,
    ].join("|");
    const hit = cache.get(key);
    if (hit) return hit;
    rng = mulberry32(hash(key));
  }

  const counts = toCounts(o.rack);
  const draw = Math.min(o.drawSize, pool.length);
  const start = performance.now();
  let total = 0;
  let n = 0;
  for (; n < o.samples; n++) {
    if (!cache && n > 0 && (n & 15) === 0 && performance.now() - start > o.budgetMs) break;
    // Partial Fisher-Yates: the first `draw` slots become the sample.
    for (let i = 0; i < draw; i++) {
      const j = i + Math.floor(rng() * (pool.length - i));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
      counts[pool[i]]++;
    }
    const without = bestValue(counts, o.bingoBonus);
    counts[target]++;
    const withLetter = bestValue(counts, o.bingoBonus);
    counts[target]--;
    for (let i = 0; i < draw; i++) counts[pool[i]]--;
    total += withLetter - without;
  }
  const result = { value: n === 0 ? 0 : total / n, samples: n };
  if (cache) cache.set(key, result);
  return result;
}
