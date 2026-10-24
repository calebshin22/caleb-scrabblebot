// Local match simulator: our strategy against a field of opponents, under
// the server's rules (../spacetimedb/src/game.ts). eval.py drives it.
//
//   npx tsx scripts/arena.ts --strategy strategy.json --games 40 --seed 1 \
//     [--samples 100] [--field real|sim] [--auction Vickrey|FirstPrice|mixed] [--out file]
//
// Rules mirrored: 98-tile bag, 5 hidden tiles each, 100 starting money,
// sealed bids, Vickrey (second price, or 1 when alone) or first-price,
// random tie-breaks, no tile if the winner can't pay, length-multiplied
// payouts, and the match ends when the bag is empty.
//
// Field "real" (default): 5 opponents sampled from data/opponents.json,
// weighted by matches played. Each bids from a per-letter normal fitted to
// data/market.json so that, as a field of 5, their top and second bids
// match the observed average top bid and price; scaled by the bot's
// aggression. They hold out for 7+ letter words (5-6 for bots whose words
// average shorter) and dump what they can when the bag runs low. Field "sim": the server's simulated bots, exactly.
//
// Same --seed, same games: runs of different strategies are paired.

import * as fs from "node:fs";
import * as path from "node:path";
import { loadDictionary } from "../src/dictionary.js";
import { Intel, resetPriceHistory, STARTING_BAG, wordPayout } from "../src/intel.js";
import { LETTER_VALUE } from "../src/letters.js";
import { loadOpponents, pickCounter, type OpponentProfile } from "../src/counters.js";
import { PARAMS, readStrategy, type Params } from "../src/params.js";
import { seedRandom } from "../src/random.js";
import { forEachWord, initSimulator, setDeterministic } from "../src/simulator.js";
import { chooseWord, decideBid } from "../src/strategy.js";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const STRATEGY = opt("--strategy", "strategy.json");
const GAMES = Number(opt("--games", "40"));
const SEED = Number(opt("--seed", "1"));
const SAMPLES = Number(opt("--samples", "100"));
const FIELD = opt("--field", "real");
const AUCTION = opt("--auction", "Vickrey");
const OUT = opt("--out", "");
const DATA = path.join(process.cwd(), "data");

const STARTING_BALANCE = 100;
const RACK_SIZE = 5;
const OPPONENTS = 5;
const ME = 100n;

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// ---------- market calibration ----------

interface LetterMarket {
  mu: number;
  sigma: number;
}

function loadMarket(): Record<string, LetterMarket> {
  const file = path.join(DATA, "market.json");
  const out: Record<string, LetterMarket> = {};
  let letters: Record<string, { avg_paid: number; avg_top: number }> = {};
  try {
    letters = JSON.parse(fs.readFileSync(file, "utf8")).letters;
  } catch {
    // No scraped data: prices ~ 9 + 2.5 x face, roughly what the field pays.
  }
  for (const L of Object.keys(LETTER_VALUE)) {
    const m = letters[L];
    const paid = m?.avg_paid ?? 9 + 2.5 * LETTER_VALUE[L];
    const top = m?.avg_top ?? paid * 1.35;
    // For 5 iid normals: E[max] ~ mu + 1.163 sigma, E[2nd] ~ mu + 0.495 sigma.
    const sigma = Math.max(0.5, (top - paid) / 0.668);
    out[L] = { mu: paid - 0.495 * sigma, sigma };
  }
  return out;
}

// ---------- players ----------

interface Player {
  id: bigint;
  kind: "me" | "field" | "sim";
  profile?: OpponentProfile;
  simStrategy?: string;
  aggression: number;
  minLen: number;
  balance: number;
  score: number;
  rack: Map<string, number>;
  tilesWon: number;
  spent: number;
}

function addTile(rack: Map<string, number>, letter: string) {
  rack.set(letter, (rack.get(letter) ?? 0) + 1);
}

function removeWord(rack: Map<string, number>, word: string) {
  for (const c of word) {
    const n = (rack.get(c) ?? 0) - 1;
    if (n <= 0) rack.delete(c);
    else rack.set(c, n);
  }
}

function tiles(rack: Map<string, number>): number {
  let n = 0;
  for (const c of rack.values()) n += c;
  return n;
}

// Best word by payout (field bots) or longest (server sim bots).
function bestWord(rack: Map<string, number>, minLen: number, longest: boolean): string | null {
  let best: string | null = null;
  let bestKey = -1;
  forEachWord(rack, (w) => {
    if (w.length < minLen) return;
    const key = longest ? w.length : wordPayout(w);
    if (key > bestKey) {
      best = w;
      bestKey = key;
    }
  });
  return best;
}

function fieldBid(p: Player, letter: string, market: Record<string, LetterMarket>, rng: () => number): number {
  if (p.kind === "sim") {
    // The server's simulated bots, from game.ts decideBid.
    const v = LETTER_VALUE[letter] ?? 0;
    const jitter = Math.floor(rng() * 5) - 2;
    let base: number;
    switch (p.simStrategy) {
      case "Cheapskate": base = v - 1; break;
      case "ValueBidder": base = v; break;
      case "Aggressive": base = v + ("AEIOU".includes(letter) ? 4 : 2); break;
      default: return 0;
    }
    return Math.max(Math.min(Math.max(base + jitter, 1), p.balance), 0);
  }
  const m = market[letter];
  const bid = Math.round((m.mu + m.sigma * gaussian(rng)) * p.aggression);
  return Math.max(0, Math.min(bid, p.balance));
}

// ---------- one game ----------

interface GameResult {
  game: number;
  auctionType: string;
  counter: string;
  myScore: number;
  bestOpponent: number;
  placement: number;
  won: boolean;
  tilesWon: number;
  spent: number;
  unspent: number;
  tilesLeft: number;
  fieldAvgScore: number;
}

function sampleField(rng: () => number, profiles: [string, OpponentProfile][]): Player[] {
  const field: Player[] = [];
  const total = profiles.reduce((s, [, p]) => s + (p.matches ?? 1), 0);
  for (let i = 0; i < OPPONENTS; i++) {
    const id = BigInt(i + 1);
    const base = { id, balance: STARTING_BALANCE, score: 0, rack: new Map(), tilesWon: 0, spent: 0 };
    if (FIELD === "sim" || profiles.length === 0) {
      const strategies = ["Cheapskate", "ValueBidder", "Aggressive", "Aggressive", "ValueBidder"];
      const s = strategies[i % strategies.length];
      field.push({ ...base, kind: "sim", simStrategy: s, aggression: 1, minLen: 3,
        profile: { name: `${s}-sim`, simulated: true, sim_strategy: s, counter: s === "Aggressive" ? "price_set_aggressive" : "outbid_cheap" } });
      continue;
    }
    let r = rng() * total;
    let pick = profiles[0][1];
    for (const [, p] of profiles) {
      r -= p.matches ?? 1;
      if (r <= 0) {
        pick = p;
        break;
      }
    }
    // Real bots mostly hold out for 7+ letters (the 3x multiplier) and dump
    // the rest at the end; shorter average words mean they settle earlier.
    const len = pick.avg_word_len ?? 5.6;
    field.push({
      ...base,
      kind: "field",
      profile: pick,
      aggression: pick.aggression ?? 1,
      minLen: len >= 5.3 ? 7 : len >= 4.8 ? 6 : 5,
    });
  }
  return field;
}

function playGame(
  g: number,
  params: Params,
  counters: Record<string, Partial<Params>>,
  market: Record<string, LetterMarket>,
  profiles: [string, OpponentProfile][],
  dictionary: string[],
): GameResult {
  const rng = mulberry32(SEED * 100003 + g);
  seedRandom(SEED * 7919 + g);
  const auctionType =
    AUCTION === "mixed" ? (g % 2 === 0 ? "Vickrey" : "FirstPrice") : AUCTION === "FirstPrice" ? "FirstPrice" : "Vickrey";

  const field = sampleField(rng, profiles);
  Object.assign(PARAMS, params, { sim_samples: SAMPLES });
  let counter = "default";
  if (params.counters_enabled) {
    counter = pickCounter(field.map((p) => p.profile)).counter;
    Object.assign(PARAMS, counters[counter] ?? {});
  }
  const me: Player = { id: ME, kind: "me", aggression: 1, minLen: 2, balance: STARTING_BALANCE,
    score: 0, rack: new Map(), tilesWon: 0, spent: 0 };
  const players = [me, ...field];

  const bag: string[] = [];
  for (const [l, n] of Object.entries(STARTING_BAG)) for (let i = 0; i < n; i++) bag.push(l);
  const draw = (): string | undefined => {
    if (bag.length === 0) return undefined;
    const i = Math.floor(rng() * bag.length);
    const l = bag[i];
    bag[i] = bag[bag.length - 1];
    bag.pop();
    return l;
  };
  for (const p of players) for (let i = 0; i < RACK_SIZE; i++) {
    const l = draw();
    if (l) addTile(p.rack, l);
  }
  const intel = new Intel(ME, me.rack);

  const scoreDiff = () => me.score - Math.max(...field.map((p) => p.score));
  const playMine = () => {
    for (;;) {
      const word = chooseWord({ myRack: me.rack, dictionary, bagRemaining: bag.length, scoreDiff: scoreDiff() });
      if (!word) return;
      const r = wordPayout(word);
      me.score += r;
      me.balance += r;
      removeWord(me.rack, word);
    }
  };
  const playField = (p: Player) => {
    for (;;) {
      const endgame = bag.length < tiles(p.rack);
      const word = bestWord(p.rack, endgame ? 2 : p.minLen, p.kind === "sim");
      if (!word) return;
      const r = wordPayout(word);
      p.score += r;
      p.balance += r;
      removeWord(p.rack, word);
      intel.onWordPlay({ botId: p.id, word });
      if (p.kind === "sim") return; // the server plays one word per win
    }
  };

  playMine();
  for (const p of field) if (p.kind === "field") playField(p);

  for (let letter = draw(); letter !== undefined; ) {
    const bids: { p: Player; amount: number }[] = [];
    const mine = decideBid({
      letter, myBalance: me.balance, myRack: me.rack, intel, auctionType,
      bagRemaining: bag.length, scoreDiff: scoreDiff(),
    });
    if (mine > 0) bids.push({ p: me, amount: mine });
    for (const p of field) {
      const b = fieldBid(p, letter, market, rng);
      if (b > 0) bids.push({ p, amount: b });
    }
    // Shuffle, then stable sort: random tie-breaks, as on the server.
    for (let i = bids.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [bids[i], bids[j]] = [bids[j], bids[i]];
    }
    bids.sort((a, b) => b.amount - a.amount);

    let winner: Player | null = null;
    let paid = 0;
    if (bids.length > 0) {
      winner = bids[0].p;
      paid = auctionType === "FirstPrice" ? bids[0].amount : bids[1] ? bids[1].amount : Math.min(1, bids[0].amount);
      if (winner.balance >= paid) {
        winner.balance -= paid;
        winner.spent += paid;
        winner.tilesWon++;
        addTile(winner.rack, letter);
      }
    }
    intel.onAuctionResult({ letter, winnerBotId: winner ? winner.id : null, paid: BigInt(paid) });

    // A sim winner plays before the next draw; then the match may end.
    if (winner && winner.kind === "sim") playField(winner);
    const next = draw();
    if (next === undefined) break;
    letter = next;
    playMine();
    for (const p of field) if (p.kind === "field") playField(p);
  }

  const best = Math.max(...field.map((p) => p.score));
  return {
    game: g,
    auctionType,
    counter,
    myScore: me.score,
    bestOpponent: best,
    placement: 1 + field.filter((p) => p.score > me.score).length,
    won: me.score >= best, // ties for first share the win, as on the server
    tilesWon: me.tilesWon,
    spent: me.spent,
    unspent: me.balance,
    tilesLeft: tiles(me.rack),
    fieldAvgScore: field.reduce((s, p) => s + p.score, 0) / field.length,
  };
}

function main() {
  const { params, counters } = readStrategy(path.resolve(STRATEGY));
  const dictionary = loadDictionary();
  initSimulator(dictionary);
  setDeterministic(true);
  resetPriceHistory();
  const market = loadMarket();
  const profiles = Object.entries(loadOpponents(path.join(DATA, "opponents.json"))).filter(
    ([, p]) => !p.simulated && (p.matches ?? 0) >= 10,
  );

  const t0 = performance.now();
  const games: GameResult[] = [];
  for (let g = 0; g < GAMES; g++) games.push(playGame(g, params, counters, market, profiles, dictionary));
  const avg = (f: (r: GameResult) => number) => games.reduce((s, r) => s + f(r), 0) / games.length;
  const summary = {
    strategy: STRATEGY,
    games: GAMES,
    seed: SEED,
    samples: SAMPLES,
    field: profiles.length > 0 && FIELD !== "sim" ? "real" : "sim",
    winrate: avg((r) => (r.won ? 1 : 0)),
    avgScore: avg((r) => r.myScore),
    avgDiff: avg((r) => r.myScore - r.bestOpponent),
    avgPlacement: avg((r) => r.placement),
    avgTilesWon: avg((r) => r.tilesWon),
    avgUnspent: avg((r) => r.unspent),
    avgTilesLeft: avg((r) => r.tilesLeft),
    fieldAvgScore: avg((r) => r.fieldAvgScore),
    fieldWinnerScore: avg((r) => r.bestOpponent),
    seconds: (performance.now() - t0) / 1000,
  };
  const out = JSON.stringify({ summary, games }, null, 2);
  if (OUT) fs.writeFileSync(OUT, out);
  else console.log(out);
}

main();
