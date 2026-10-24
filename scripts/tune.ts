// Reads data/matches.jsonl, reports how the bot has been doing, then
// hill-climbs strategy.json by replaying logged matches under mutated params.
//
//   npm run report               stats only
//   npm run tune                 stats, tuning, and write strategy.json if better
//   npm run tune -- --dry-run    tune but don't write
//   flags: --rounds N (3), --samples N (100), --min-matches N (5)
//
// The replay is counterfactual and approximate: opponents' bids are fixed
// from the log, and they don't react to what we do differently.
//   - Opponent won: their best bid is the archived top bid, else what they paid.
//   - We won, Vickrey: their best bid is what we paid (the second price).
//   - We won, first-price: unknown; assumed 75% of our logged bid.
//   - Nobody won: no opponent bid.
// We win a replayed auction only by bidding strictly more than that.

import * as fs from "node:fs";
import { loadDictionary } from "../src/dictionary.js";
import { Intel, resetPriceHistory, wordPayout } from "../src/intel.js";
import { LOG_PATH } from "../src/logger.js";
import {
  DEFAULT_PARAMS,
  loadParams,
  PARAMS,
  PARAMS_PATH,
  saveParams,
  TUNABLE,
  type NumericParamKey,
  type ParamKey,
  type Params,
} from "../src/params.js";
import { seedRandom } from "../src/random.js";
import { bestPlay, initSimulator, setDeterministic } from "../src/simulator.js";
import { chooseWord, decideBid } from "../src/strategy.js";

// fitness = avgScore - UNSPENT_WEIGHT * avgUnspent - UNPLAYED_WEIGHT * avgUnplayed
const UNSPENT_WEIGHT = 0.5;
const UNPLAYED_WEIGHT = 2;
const STARTING_BALANCE = 100;
const FIRST_PRICE_UNKNOWN_OPP = 0.75;
const UNKNOWN_OPPONENT = 0n;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const num = (name: string, dflt: number) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? Number(args[i + 1]) : dflt;
};
const REPORT_ONLY = flag("--report-only");
const DRY_RUN = flag("--dry-run");
const ROUNDS = num("--rounds", 3);
const SAMPLES = num("--samples", 100);
const MIN_MATCHES = num("--min-matches", 5);

// ---------- Log parsing ----------

interface Event {
  type: string;
  matchId: string | null;
  [k: string]: unknown;
}

interface MatchLog {
  id: string;
  start?: Event;
  end?: Event;
  events: Event[]; // auction_result and word_play, in arrival order
  topBids: Map<string, number>;
  myBids: Map<string, number>;
}

function readLog(): MatchLog[] {
  if (!fs.existsSync(LOG_PATH)) return [];
  const matches = new Map<string, MatchLog>();
  const lines = fs.readFileSync(LOG_PATH, "utf8").split("\n");
  let bad = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: Event;
    try {
      e = JSON.parse(line);
    } catch {
      bad++;
      continue;
    }
    if (!e.matchId) continue;
    let m = matches.get(e.matchId);
    if (!m) {
      m = { id: e.matchId, events: [], topBids: new Map(), myBids: new Map() };
      matches.set(e.matchId, m);
    }
    switch (e.type) {
      case "match_start":
        // A restart logs a second, resumed start; keep the first.
        if (!m.start) m.start = e;
        break;
      case "match_end":
        m.end = e;
        break;
      case "auction_result":
      case "word_play":
        m.events.push(e);
        break;
      case "auction_top_bid":
        m.topBids.set(String(e.auctionId), Number(e.topBid));
        break;
      case "my_bid":
        if (e.auctionId != null) m.myBids.set(String(e.auctionId), Number(e.myBid));
        break;
    }
  }
  if (bad > 0) console.warn(`skipped ${bad} unparseable log line(s)`);
  return [...matches.values()];
}

function parseRack(s: string): Map<string, number> {
  const rack = new Map<string, number>();
  for (const c of s) rack.set(c, (rack.get(c) ?? 0) + 1);
  return rack;
}

function tiles(rack: Map<string, number>): number {
  let n = 0;
  for (const c of rack.values()) n += c;
  return n;
}

// ---------- Report from what actually happened ----------

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function report(matches: MatchLog[]) {
  const ended = matches.filter((m) => m.end && m.end.myScore != null);
  console.log(`Matches logged: ${matches.length}, finished: ${ended.length}`);
  if (ended.length === 0) return;

  const scores = ended.map((m) => Number(m.end!.myScore));
  const placements = ended
    .map((m) => m.end!.placement)
    .filter((p): p is number => typeof p === "number");
  const wins = placements.filter((p) => p === 1).length;
  console.log(`  avg score          ${avg(scores).toFixed(1)}`);
  console.log(`  win rate           ${pct(placements.length ? wins / placements.length : 0)} (${wins}/${placements.length})`);
  console.log(`  avg placement      ${avg(placements).toFixed(2)}`);
  console.log(`  avg unspent balance ${avg(ended.map((m) => Number(m.end!.myBalance ?? 0))).toFixed(1)}`);
  console.log(`  avg unplayed tiles ${avg(ended.map((m) => String(m.end!.myRackLeft ?? "").length)).toFixed(1)}`);

  // Tiles we won that were still on the rack at the end. Assumes starting
  // tiles were played first, so it's a lower bound.
  let won = 0;
  let wasted = 0;
  for (const m of ended) {
    if (!m.start) continue;
    const me = String(m.start.myBotId);
    const wonLetters = new Map<string, number>();
    for (const e of m.events) {
      if (e.type === "auction_result" && String(e.winner) === me) {
        const l = String(e.letter);
        wonLetters.set(l, (wonLetters.get(l) ?? 0) + 1);
        won++;
      }
    }
    const left = parseRack(String(m.end!.myRackLeft ?? ""));
    for (const [l, n] of wonLetters) wasted += Math.min(n, left.get(l) ?? 0);
  }
  console.log(`  overbid rate       ${pct(won ? wasted / won : 0)} (won tiles never played: ${wasted}/${won})`);

  // Matches that ended with a playable word still on the rack.
  const missed = ended.filter(
    (m) => bestPlay(parseRack(String(m.end!.myRackLeft ?? ""))) !== null,
  ).length;
  console.log(`  missed word rate   ${pct(missed / ended.length)} (ended holding a playable word)`);

  console.log("  win rate by score:");
  const buckets = new Map<number, { n: number; wins: number }>();
  for (const m of ended) {
    const b = Math.floor(Number(m.end!.myScore) / 20) * 20;
    const entry = buckets.get(b) ?? { n: 0, wins: 0 };
    entry.n++;
    if (m.end!.placement === 1) entry.wins++;
    buckets.set(b, entry);
  }
  for (const [b, { n, wins: w }] of [...buckets].sort(([a], [b2]) => a - b2)) {
    console.log(`    ${String(b).padStart(4)}-${b + 19}: ${pct(w / n).padStart(6)} of ${n}`);
  }
}

// ---------- Counterfactual replay ----------

interface Outcome {
  score: number;
  unspent: number;
  unplayed: number;
  fitness: number;
}

const playCache = new Map<string, string | null>();

function cachedChooseWord(
  rack: Map<string, number>,
  dictionary: string[],
  bagRemaining: number,
): string | null {
  const endgame = bagRemaining < tiles(rack);
  const key = [
    [...rack].sort().join(""),
    endgame,
    PARAMS.play_min_length,
    PARAMS.play_min_score,
    PARAMS.hold_rack_size,
    PARAMS.leave_weight,
    PARAMS.bingo_bonus,
  ].join("|");
  if (playCache.has(key)) return playCache.get(key)!;
  const word = chooseWord({ myRack: rack, dictionary, bagRemaining });
  playCache.set(key, word);
  return word;
}

function replayMatch(m: MatchLog, dictionary: string[]) {
  const start = m.start!;
  const me = BigInt(String(start.myBotId));
  const auctionType = start.auctionType === "FirstPrice" ? "FirstPrice" : "Vickrey";
  const rack = parseRack(String(start.startingRack));
  const intel = new Intel(me, rack);
  let balance = STARTING_BALANCE;
  let score = 0;
  const auctions = m.events.filter((e) => e.type === "auction_result").length;
  let auctionIndex = 0;

  const playAll = (bagRemaining: number) => {
    for (;;) {
      const word = cachedChooseWord(rack, dictionary, bagRemaining);
      if (!word) return;
      const reward = wordPayout(word);
      score += reward;
      balance += reward;
      for (const c of word) {
        const n = (rack.get(c) ?? 0) - 1;
        if (n <= 0) rack.delete(c);
        else rack.set(c, n);
      }
    }
  };

  playAll(auctions);
  for (const e of m.events) {
    if (e.type === "word_play") {
      if (String(e.botId) !== String(me)) {
        intel.onWordPlay({ botId: BigInt(String(e.botId)), word: String(e.word) });
      }
      continue;
    }
    const bagRemaining = auctions - ++auctionIndex;
    const letter = String(e.letter);
    const actualWinner = e.winner == null ? null : String(e.winner);
    const paid = Number(e.paid);
    const auctionId = String(e.auctionId);

    let oppBest = 0;
    if (actualWinner !== null && actualWinner !== String(me)) {
      oppBest = m.topBids.get(auctionId) ?? paid;
    } else if (actualWinner === String(me)) {
      oppBest =
        auctionType === "Vickrey"
          ? paid
          : Math.floor((m.myBids.get(auctionId) ?? paid) * FIRST_PRICE_UNKNOWN_OPP);
    }

    const bid = decideBid({ letter, myBalance: balance, myRack: rack, intel, auctionType, bagRemaining });
    let price = 0;
    let weWin = bid > 0 && bid > oppBest;
    if (weWin) {
      price = auctionType === "FirstPrice" ? bid : oppBest > 0 ? oppBest : Math.min(1, bid);
      if (balance < price) weWin = false;
    }

    if (weWin) {
      balance -= price;
      rack.set(letter, (rack.get(letter) ?? 0) + 1);
      intel.onAuctionResult({ letter, winnerBotId: me, paid: BigInt(price) });
    } else if (oppBest > 0) {
      const winner =
        actualWinner !== null && actualWinner !== String(me)
          ? BigInt(actualWinner)
          : UNKNOWN_OPPONENT;
      // Losing a Vickrey auction we really won: they pay our bid instead.
      const theyPaid =
        actualWinner === String(me)
          ? auctionType === "Vickrey" ? Math.max(bid, 1) : oppBest
          : paid;
      intel.onAuctionResult({ letter, winnerBotId: winner, paid: BigInt(theyPaid) });
    } else {
      intel.onAuctionResult({ letter, winnerBotId: null, paid: 0n });
    }
    playAll(bagRemaining);
  }
  return { score, unspent: balance, unplayed: tiles(rack) };
}

function evaluate(params: Params, matches: MatchLog[], dictionary: string[]): Outcome {
  Object.assign(PARAMS, params, { sim_samples: SAMPLES });
  resetPriceHistory();
  // Same jitter stream for every candidate, so fitness differences come
  // from the params, not the dice.
  seedRandom(1);
  const outs = matches.map((m) => replayMatch(m, dictionary));
  const score = avg(outs.map((o) => o.score));
  const unspent = avg(outs.map((o) => o.unspent));
  const unplayed = avg(outs.map((o) => o.unplayed));
  return {
    score,
    unspent,
    unplayed,
    fitness: score - unspent * UNSPENT_WEIGHT - unplayed * UNPLAYED_WEIGHT,
  };
}

function mutate(params: Params, key: NumericParamKey, dir: 1 | -1): Params {
  const spec = TUNABLE[key]!;
  const v = params[key];
  let next: number;
  if (spec.kind === "int") next = v + dir;
  // 10% of zero is zero, so step off zero by 2% of the range.
  else if (v === 0) next = dir * (spec.max - spec.min) * 0.02;
  else next = v * (1 + 0.1 * dir);
  next = Math.min(spec.max, Math.max(spec.min, next));
  if (spec.kind === "float") next = Math.round(next * 1e4) / 1e4;
  return { ...params, [key]: next };
}

const fmt = (o: Outcome) =>
  `fitness ${o.fitness.toFixed(2)} (score ${o.score.toFixed(1)}, unspent ${o.unspent.toFixed(1)}, unplayed ${o.unplayed.toFixed(1)})`;

function main() {
  const matches = readLog();
  if (matches.length === 0) {
    console.log(`No data yet: ${LOG_PATH} is missing or empty. Run the bot to collect matches.`);
    return;
  }
  const dictionary = loadDictionary();
  initSimulator(dictionary);
  console.log("=== Report ===");
  report(matches);
  if (REPORT_ONLY) return;

  const replayable = matches.filter(
    (m) => m.start && m.end && m.start.resumed !== true && m.events.length > 0,
  );
  console.log(`\n=== Tuning (${replayable.length} replayable matches, ${SAMPLES} sim samples) ===`);
  if (replayable.length < MIN_MATCHES) {
    console.log(`Need at least ${MIN_MATCHES} replayable matches to tune; not changing strategy.json.`);
    return;
  }

  setDeterministic(true);
  const current = { ...loadParams() };
  const t0 = performance.now();
  const baseline = evaluate(current, replayable, dictionary);
  console.log(`current params: ${fmt(baseline)}`);

  let best = current;
  let bestOut = baseline;
  const keys = Object.keys(TUNABLE) as NumericParamKey[];
  for (let round = 1; round <= ROUNDS; round++) {
    let roundBest: { params: Params; out: Outcome; change: string } | null = null;
    for (const key of keys) {
      for (const dir of [1, -1] as const) {
        const cand = mutate(best, key, dir);
        if (cand[key] === best[key]) continue;
        const out = evaluate(cand, replayable, dictionary);
        if (out.fitness > (roundBest?.out.fitness ?? bestOut.fitness) + 1e-9) {
          roundBest = { params: cand, out, change: `${key} ${best[key]} -> ${cand[key]}` };
        }
      }
    }
    if (!roundBest) {
      console.log(`round ${round}: no improving step`);
      break;
    }
    best = roundBest.params;
    bestOut = roundBest.out;
    console.log(`round ${round}: ${roundBest.change}: ${fmt(bestOut)}`);
  }
  console.log(`tuning took ${((performance.now() - t0) / 1000).toFixed(1)} s`);

  const changed = (Object.keys(DEFAULT_PARAMS) as ParamKey[]).filter((k) => best[k] !== current[k]);
  if (changed.length === 0 || bestOut.fitness <= baseline.fitness) {
    console.log("\nNo improvement found; strategy.json unchanged.");
    return;
  }
  console.log(`\nBest: ${fmt(bestOut)}  (was ${baseline.fitness.toFixed(2)})`);
  for (const k of changed) console.log(`  ${k}: ${current[k]} -> ${best[k]}`);
  if (DRY_RUN) {
    console.log("--dry-run: strategy.json unchanged.");
    return;
  }
  // Compute knobs were overridden for the replay; keep the file's values.
  saveParams({ ...best, sim_samples: current.sim_samples, sim_budget_ms: current.sim_budget_ms }, PARAMS_PATH);
  console.log(`Wrote ${PARAMS_PATH}. The bot picks it up at its next match start.`);
}

main();
