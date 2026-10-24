// Edit this file to implement your bidding and word-forming strategy.
// Tunable numbers live in params.json (see ./params.ts), not here.

import { payoutFor, wordPayout, type Intel } from "./intel.js";
import { LETTER_VALUE } from "./letters.js";
import { logger, rackString } from "./logger.js";
import { PARAMS } from "./params.js";
import { rand } from "./random.js";
import { estimateLetterValue, simulatorReady } from "./simulator.js";

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
  if (intel && tiles >= P.simMinRackSize && simulatorReady()) {
    source = "sim";
    const est = estimateLetterValue({
      rack: ctx.myRack,
      letter: ctx.letter,
      unseen: intel.unseen,
      samples: P.simSamples,
      drawSize: P.simDrawSize,
      budgetMs: P.simBudgetMs,
      bingoBonus: P.bingoBonus,
    });
    value = est.value;
    simSamples = est.samples;
  } else {
    // The simulator already sees scarcity and Q/U, so these only apply here.
    source = "heuristic";
    const face = LETTER_VALUE[ctx.letter] ?? 1;
    value =
      have === 0
        ? face + P.newLetterPremium
        : Math.max(1, face) * P.duplicatePenalty;
    if (intel) {
      if (VOWELS.has(ctx.letter) && intel.pInBag(ctx.letter) < P.vowelScarcityThreshold) {
        value *= P.vowelScarcityMult;
        adjustments.push("scarceVowel");
      }
      if (ctx.letter === "U" && (ctx.myRack.get("Q") ?? 0) > 0) {
        value *= P.uWithQMult;
        adjustments.push("uWithQ");
      }
      if (
        ctx.letter === "Q" &&
        intel.pInBag("U") === 0 &&
        (ctx.myRack.get("U") ?? 0) === 0
      ) {
        value *= P.qWithoutUMult;
        adjustments.push("qWithoutU");
      }
    }
  }

  let want = value * P.bidAggression;
  let typical = 0;
  if (intel) {
    typical = intel.typicalTopBid(ctx.letter);
    if (ctx.auctionType === "Vickrey") {
      // Deny letters to an opponent close to a long word. Vickrey only: we'd
      // usually pay the second price, not this bid.
      if (typical > 0 && intel.maxOpponentRackSize() >= P.denialRackSize) {
        const floor = typical * P.denialFraction;
        if (floor > want) adjustments.push("denial");
        want = Math.max(want, floor);
      }
    } else if (ctx.auctionType === "FirstPrice" && typical > 0) {
      // Shade toward what the market pays, never above our true value.
      const shaded = Math.min(want, Math.max(typical * P.firstPriceShade, want * P.firstPriceFloor));
      if (shaded < want) adjustments.push("shade");
      want = shaded;
    }
  }

  // Balance is worthless once the match ends; spend it on useful tiles.
  if (
    value > 0 &&
    P.endgameSpendFraction > 0 &&
    ctx.bagRemaining !== undefined &&
    ctx.bagRemaining <= P.endgameBagSize
  ) {
    const spend = (ctx.myBalance * P.endgameSpendFraction) / (ctx.bagRemaining + 1);
    if (spend > want) adjustments.push("endgame");
    want = Math.max(want, spend);
  }

  // Deception: make our bids harder for opponents to model.
  let priceSet = false;
  let jitter = 1;
  let skipped = false;
  if (P.deceptionEnabled) {
    // Vickrey only: the winner pays the second price, so a high bid we
    // expect to lose raises what the richest, near-complete opponent pays.
    // In first-price we'd pay our own bid, so never there.
    const target = intel?.richestOpponent();
    if (
      ctx.auctionType === "Vickrey" &&
      target &&
      target.rackSize >= P.priceSetRackSize &&
      value < P.priceSetMaxValue &&
      typical > 0
    ) {
      const priceBid = Math.min(
        typical * P.priceSetFraction,
        ctx.myBalance * P.priceSetCapFraction,
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
    jitter = 1 - P.bidJitter + rand() * 2 * P.bidJitter;
    want *= jitter;
    if (value < P.skipMaxValue && rand() < P.skipChance) {
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
}

// The value chooseWord maximises: payout, plus a bonus for 7+ letters.
function playValue(word: string): number {
  return wordPayout(word) + (word.length >= 7 ? PARAMS.bingoBonus : 0);
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
 * Picks the playable word with the highest payout (plus bingo bonus and
 * weighted leave quality). Holds when the rack is under `holdRackSize` or the
 * best word is under `playMinLength` / `playMinScore`, unless the bag has
 * fewer tiles left than the rack, when it always plays the best word.
 *
 * Keep this fast. The bot runs it on every rack change, and while it runs
 * the bot can't see the match move on: a search that takes longer than an
 * auction means bids on closed auctions and words from spent letters.
 */
export function chooseWord(ctx: WordContext): string | null {
  const P = PARAMS;
  const tiles = rackTiles(ctx.myRack);
  const endgame = ctx.bagRemaining !== undefined && ctx.bagRemaining < tiles;
  if (!endgame && tiles < P.holdRackSize) return null;
  const minLength = endgame ? 0 : P.playMinLength;

  // Upper bound on playValue for a word of each length, from the rack's
  // highest letter values; lets the scan stop early.
  const values = [...ctx.myRack]
    .flatMap(([letter, n]) => Array<number>(n).fill(LETTER_VALUE[letter] ?? 0))
    .sort((a, b) => b - a);
  const bound = (len: number) => {
    let base = 0;
    for (let i = 0; i < len; i++) base += values[i];
    return payoutFor(base, len) + (len >= 7 ? P.bingoBonus : 0);
  };

  let best: string | null = null;
  let bestScore = -Infinity;
  // The dictionary is longest first, so once even a perfect word of this
  // length can't beat the best, no later word can.
  for (const word of ctx.dictionary) {
    if (word.length > tiles) continue;
    if (best !== null && bound(word.length) <= bestScore) break;
    if (word.length < minLength) continue;
    if (!canSpell(word, ctx.myRack)) continue;
    let score = playValue(word);
    if (P.leaveQualityWeight > 0) {
      score += P.leaveQualityWeight * leaveQuality(without(ctx.myRack, word));
    }
    if (score > bestScore) {
      best = word;
      bestScore = score;
    }
  }
  if (best === null) return null;
  const payout = wordPayout(best);
  if (!endgame && payout < P.playMinScore) return null;

  // Tempo hold, disabled: sometimes sit on a weak early rack so opponents
  // can't read our hand from how often we play. Uncomment to try it with
  // tempoHoldEnabled in params.json (also import rand from ./random.js).
  // if (
  //   P.tempoHoldEnabled &&
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
