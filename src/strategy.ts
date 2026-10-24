// Edit this file to implement your bidding and word-forming strategy.
// Tunable numbers live in strategy.json (see ./params.ts), not here.

import { payoutFor, wordPayout, type Intel } from "./intel.js";
import { LETTER_VALUE } from "./letters.js";
import { logger, rackString } from "./logger.js";
import { marketPrice } from "./market.js";
import { PARAMS } from "./params.js";
import { predictedTopBid } from "./priceModel.js";
import { rand } from "./random.js";
import {
  builtFrom,
  estimateLetterValue,
  forEachWord,
  playGain,
  simulatorReady,
} from "./simulator.js";

// Standard Scrabble letter values — useful for valuation.
export { LETTER_VALUE };

export interface BidContext {
  letter: string;        // Letter being auctioned, e.g. "Q"
  myBalance: number;     // Current balance
  myRack: Map<string, number>; // Letters you currently own, letter -> count
  intel?: Intel;         // Inferred match state, when the caller tracks it
  auctionType?: "FirstPrice" | "Vickrey";
  matchId?: bigint;      // For the match log
  auctionId?: bigint;
  bagRemaining?: number; // Tiles left in the bag (matchState.bagTotal)
  scoreDiff?: number;    // Our score minus the best opponent's
}

const VOWELS = new Set(["A", "E", "I", "O", "U"]);

function rackTiles(rack: Map<string, number>): number {
  let tiles = 0;
  for (const count of rack.values()) tiles += count;
  return tiles;
}

/**
 * Decide how much to bid for `letter`. Return 0 to skip.
 * With intel and a big enough rack, the letter's value is a Monte Carlo
 * estimate of how much it adds to the best play; otherwise a face-value
 * heuristic. Market adjustments (denial, shading, endgame) apply to both.
 */
export function decideBid(ctx: BidContext): number {
  const P = PARAMS;
  const intel = ctx.intel;
  const have = ctx.myRack.get(ctx.letter) ?? 0;
  const tiles = rackTiles(ctx.myRack);
  const adjustments: string[] = [];

  let value: number;
  let source: "sim" | "heuristic";
  let simSamples = 0;
  if (intel && tiles >= P.sim_min_rack_size && simulatorReady()) {
    source = "sim";
    const est = estimateLetterValue({
      rack: ctx.myRack,
      letter: ctx.letter,
      unseen: intel.unseen,
      samples: P.sim_samples,
      drawSize: P.sim_draw_size,
      budgetMs: P.sim_budget_ms,
      bingoBonus: P.bingo_bonus,
    });
    value = est.value;
    simSamples = est.samples;
  } else {
    // The simulator already sees scarcity and Q/U, so these only apply here.
    source = "heuristic";
    const face = LETTER_VALUE[ctx.letter] ?? 1;
    value =
      have === 0
        ? face + P.new_letter_premium
        : Math.max(1, face) * P.duplicate_penalty;
    if (intel) {
      if (VOWELS.has(ctx.letter) && intel.pInBag(ctx.letter) < P.vowel_scarcity_threshold) {
        value *= P.vowel_scarcity_mult;
        adjustments.push("scarceVowel");
      }
      if (ctx.letter === "U" && (ctx.myRack.get("Q") ?? 0) > 0) {
        value *= P.u_with_q_mult;
        adjustments.push("uWithQ");
      }
      if (
        ctx.letter === "Q" &&
        intel.pInBag("U") === 0 &&
        (ctx.myRack.get("U") ?? 0) === 0
      ) {
        value *= P.q_without_u_mult;
        adjustments.push("qWithoutU");
      }
    }
  }

  let want = value * P.bid_aggression;

  // Score-dependent mode: behind, take more risk to catch up.
  const behind = P.open_board_when_behind && (ctx.scoreDiff ?? 0) < 0;
  const ahead = P.close_board_when_ahead && (ctx.scoreDiff ?? 0) > 0;
  if (behind) {
    want *= P.behind_aggression;
    adjustments.push("behind");
  }

  // Defense: what this letter would add to the best word of the opponent
  // likeliest to win it, i.e. their best reply. Inferred racks miss the
  // hidden starting tiles, so this underestimates.
  let defense = 0;
  if (intel && P.defense_weight > 0 && simulatorReady()) {
    let risk = 0;
    for (const rack of intel.inferredRacks.values()) {
      if (rackTiles(rack) >= 2) risk = Math.max(risk, playGain(rack, ctx.letter, P.bingo_bonus));
    }
    defense = risk * P.defense_weight * (ahead ? P.ahead_defense_mult : 1);
    if (defense > 0) adjustments.push("defense");
    want += defense;
  }

  let typical = 0;
  if (intel) {
    typical = intel.typicalTopBid(ctx.letter);
    if (ctx.auctionType === "Vickrey") {
      // Deny letters to an opponent close to a long word. Vickrey only: we'd
      // usually pay the second price, not this bid.
      if (typical > 0 && intel.maxOpponentRackSize() >= P.denial_rack_size) {
        const floor = typical * P.denial_fraction;
        if (floor > want) adjustments.push("denial");
        want = Math.max(want, floor);
      }
    } else if (ctx.auctionType === "FirstPrice" && typical > 0) {
      // Shade toward what the market pays, never above our true value.
      const shaded = Math.min(want, Math.max(typical * P.first_price_shade, want * P.first_price_floor));
      if (shaded < want) adjustments.push("shade");
      want = shaded;
    }
  }

  // Market anchor: for letters that help us, bid at least the going rate,
  // so we actually win the tiles our words need.
  if (P.market_floor > 0 && value > 0) {
    const price = marketPrice(ctx.letter);
    if (price) {
      const floor = price.avgPaid * P.market_floor;
      if (floor > want) adjustments.push("market");
      want = Math.max(want, floor);
    }
  }

  // Top-bot anchor: they win ~23% of auctions by bidding the market's typical
  // winning bid on letters their words need and letting the rest go.
  if (P.top_anchor > 0 && value > 0) {
    const price = marketPrice(ctx.letter);
    if (price) {
      const anchor = price.avgTop * P.top_anchor * Math.min(1, value / P.useful_value);
      if (anchor > want) adjustments.push("top_anchor");
      want = Math.max(want, anchor);
    }
  }

  // Regression anchor: the model's predicted winning bid for this letter at
  // this stage of the match, scaled by how much the letter helps us.
  if (P.regression_anchor > 0 && value > 0) {
    const predicted = predictedTopBid(ctx.letter, ctx.bagRemaining);
    if (predicted !== null) {
      const anchor = predicted * P.regression_anchor * Math.min(1, value / P.useful_value);
      if (anchor > want) adjustments.push("regression");
      want = Math.max(want, anchor);
    }
  }

  // Balance is worthless once the match ends; spend it on useful tiles.
  if (
    value > 0 &&
    P.endgame_spend_fraction > 0 &&
    ctx.bagRemaining !== undefined &&
    ctx.bagRemaining <= P.endgame_bag_size
  ) {
    const spend = (ctx.myBalance * P.endgame_spend_fraction) / (ctx.bagRemaining + 1);
    if (spend > want) adjustments.push("endgame");
    want = Math.max(want, spend);
  }

  // Deception: make our bids harder for opponents to model.
  let priceSet = false;
  let jitter = 1;
  let skipped = false;
  if (P.deception_enabled) {
    // Vickrey only: the winner pays the second price, so a high bid we
    // expect to lose raises what the richest, near-complete opponent pays.
    // In first-price we'd pay our own bid, so never there.
    const target = intel?.richestOpponent();
    if (
      ctx.auctionType === "Vickrey" &&
      target &&
      target.rackSize >= P.price_set_rack_size &&
      value < P.price_set_max_value &&
      typical > 0
    ) {
      const priceBid = Math.min(
        typical * P.price_set_fraction,
        ctx.myBalance * P.price_set_cap_fraction,
      );
      if (priceBid > want) {
        want = priceBid;
        priceSet = true;
        adjustments.push("PRICE_SET");
        logger.logPriceSet(ctx.matchId, {
          letter: ctx.letter,
          target: target.botKey,
          value,
          bid: Math.round(want),
        });
      }
    }
    jitter = 1 - P.bid_jitter + rand() * 2 * P.bid_jitter;
    want *= jitter;
    if (value < P.skip_max_value && rand() < P.skip_chance) {
      want = 0;
      skipped = true;
      adjustments.push("skip");
    }
  }

  const bid = Math.max(0, Math.min(Math.round(want), ctx.myBalance));
  logger.logBid(ctx.matchId, {
    auctionId: ctx.auctionId,
    letter: ctx.letter,
    myRack: rackString(ctx.myRack),
    myValue: value,
    myBid: bid,
    balance: ctx.myBalance,
    inferredBagLeft: intel ? intel.unseenTotal() : null,
    bagRemaining: ctx.bagRemaining ?? null,
    auctionType: ctx.auctionType ?? null,
    breakdown: {
      source,
      simSamples,
      defense,
      typical,
      adjustments,
      trueValue: value,
      preJitterBid: skipped ? null : want / jitter,
      jitter,
      priceSet,
      skipped,
    },
  });
  return bid;
}

export interface WordContext {
  myRack: Map<string, number>;
  dictionary: string[]; // Sorted uppercase list, shared at startup
  matchId?: bigint;      // For the match log
  bagRemaining?: number; // Tiles left in the bag (matchState.bagTotal)
  scoreDiff?: number;    // Our score minus the best opponent's
}

// How good the tiles left after a play are, always <= 0: penalises a vowel
// mix far from 40%, duplicates, and a Q without a U.
function leaveQuality(leave: Map<string, number>): number {
  const n = rackTiles(leave);
  if (n === 0) return 0;
  let vowels = 0;
  let dupes = 0;
  for (const [letter, count] of leave) {
    if (VOWELS.has(letter)) vowels += count;
    dupes += count - 1;
  }
  let q = -Math.abs(vowels - 0.4 * n) - 0.5 * dupes;
  if ((leave.get("Q") ?? 0) > 0 && (leave.get("U") ?? 0) === 0) q -= 2;
  return q;
}

function without(rack: Map<string, number>, word: string): Map<string, number> {
  const leave = new Map(rack);
  for (const c of word) leave.set(c, (leave.get(c) ?? 0) - 1);
  for (const [c, n] of leave) if (n <= 0) leave.delete(c);
  return leave;
}

/**
 * Try to form a word using letters from `myRack`.
 * Return the word (uppercase) to play, or null to skip.
 *
 * Scores every playable word as
 *   point_weight * payout + leave_weight * leave quality + bingo bonus
 * and plays one of the `random_top_k` best at random (k = 1: the best).
 * Holds when the rack is under `hold_rack_size` or the word is under
 * `play_min_length` / `play_min_score`, unless the bag has fewer tiles left
 * than the rack, when it always plays. Behind on score with
 * `open_board_when_behind`, holds out for `behind_min_word_length`; ahead
 * with `close_board_when_ahead`, never holds.
 *
 * Keep this fast. The bot runs it on every rack change, and while it runs
 * the bot can't see the match move on: a search that takes longer than an
 * auction means bids on closed auctions and words from spent letters.
 */
export function chooseWord(ctx: WordContext): string | null {
  const P = PARAMS;
  const tiles = rackTiles(ctx.myRack);
  const endgame = ctx.bagRemaining !== undefined && ctx.bagRemaining < tiles;
  const behind = P.open_board_when_behind && (ctx.scoreDiff ?? 0) < 0;
  const ahead = P.close_board_when_ahead && (ctx.scoreDiff ?? 0) > 0;
  const hold = !endgame && !ahead;
  if (hold && tiles < P.hold_rack_size) return null;
  let minLength = hold ? P.play_min_length : 0;
  if (hold && behind) minLength = Math.max(minLength, P.behind_min_word_length);
  const minScore = hold ? P.play_min_score : -Infinity;

  const k = Math.max(1, Math.round(P.random_top_k));
  const top: { word: string; score: number }[] = []; // best first, at most k
  const threshold = () => (top.length < k ? -Infinity : top[top.length - 1].score);
  const consider = (word: string) => {
    if (word.length < minLength) return;
    const payout = wordPayout(word);
    if (payout < minScore) return;
    let score = P.point_weight * payout + (word.length >= 7 ? P.bingo_bonus : 0);
    if (P.leave_weight > 0) {
      score += P.leave_weight * leaveQuality(without(ctx.myRack, word));
    }
    if (score <= threshold()) return;
    let i = top.length;
    while (i > 0 && top[i - 1].score < score) i--;
    top.splice(i, 0, { word, score });
    if (top.length > k) top.pop();
  };

  if (builtFrom(ctx.dictionary)) {
    // The trie walks only spellable words: fast even for big racks.
    forEachWord(ctx.myRack, consider);
  } else {
    // Upper bound on a word's score for each length, from the rack's
    // highest letter values; lets the scan stop early. Leave quality is
    // never positive, so it can't raise the bound.
    const values = [...ctx.myRack]
      .flatMap(([letter, n]) => Array<number>(n).fill(LETTER_VALUE[letter] ?? 0))
      .sort((a, b) => b - a);
    const bound = (len: number) => {
      let base = 0;
      for (let i = 0; i < len; i++) base += values[i];
      return P.point_weight * payoutFor(base, len) + (len >= 7 ? P.bingo_bonus : 0);
    };
    // The dictionary is longest first, so once even a perfect word of this
    // length can't make the top k, no later word can.
    for (const word of ctx.dictionary) {
      if (word.length > tiles) continue;
      if (top.length === k && bound(word.length) <= threshold()) break;
      if (canSpell(word, ctx.myRack)) consider(word);
    }
  }
  if (top.length === 0) return null;
  const best = top[top.length === 1 ? 0 : Math.floor(rand() * top.length)].word;
  const payout = wordPayout(best);

  // Tempo hold, disabled: sometimes sit on a weak early rack so opponents
  // can't read our hand from how often we play. Uncomment to try it with
  // tempo_hold_enabled in strategy.json.
  // if (
  //   P.tempo_hold_enabled &&
  //   !endgame &&
  //   tiles < 7 &&
  //   payout < 25 &&
  //   (ctx.bagRemaining ?? 0) > 20 &&
  //   rand() < 0.3
  // ) {
  //   return null;
  // }

  logger.logPlay(ctx.matchId, { word: best, score: payout });
  return best;
}

// Whether `rack` has every letter of `word`, counting repeats.
function canSpell(word: string, rack: Map<string, number>): boolean {
  const used: Record<string, number> = {};
  for (const c of word) {
    used[c] = (used[c] ?? 0) + 1;
    if (used[c] > (rack.get(c) ?? 0)) return false;
  }
  return true;
}
