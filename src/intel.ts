// Per-match intel inferred from public tables: which tiles are still unseen,
// what each opponent probably holds, and roughly what they can afford.
//
// Rules mirrored from ../spacetimedb/src/game.ts:
//   - Every auctioned tile is drawn from the bag first, so it's gone whether
//     or not anyone wins it.
//   - Each bot starts with `startingRackSize` hidden tiles and a balance of 100.
//   - A word pays sum(letter values) * length multiplier (integer division).

import { LETTER_VALUE } from "./letters.js";
import { logger } from "./logger.js";

export const STARTING_BAG: Readonly<Record<string, number>> = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4, M: 2,
  N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1, Y: 2, Z: 1,
};

export const STARTING_BALANCE = 100;

// Same as lengthMultiplier in the module: 1x, 1.5x, 2x, 2.5x, 3x for 7+.
export function payoutFor(base: number, len: number): number {
  const [num, denom] =
    len <= 3 ? [1, 1] : len === 4 ? [3, 2] : len === 5 ? [2, 1] : len === 6 ? [5, 2] : [3, 1];
  return Math.floor((base * num) / denom);
}

export function wordPayout(word: string): number {
  let base = 0;
  for (const c of word) base += LETTER_VALUE[c] ?? 0;
  return payoutFor(base, word.length);
}

// Prices opponents paid per letter, shared across matches so the history grows.
const paidHistory = new Map<string, number[]>();
const PAID_HISTORY_LIMIT = 50;

// For replays that must not carry prices over from earlier runs.
export function resetPriceHistory() {
  paidHistory.clear();
}

export interface AuctionResultRow {
  auctionId?: bigint;
  letter: string;
  winnerBotId?: bigint | null;
  paid: bigint;
}

export interface WordPlayRow {
  botId: bigint;
  word: string;
  totalReward?: bigint;
}

export class Intel {
  myBotId: bigint | null = null;
  readonly matchId: bigint | undefined;
  readonly myStartingRack: Map<string, number>;
  // Whether handlers write to the match log. Off while replaying rows that
  // were already logged.
  logEvents = false;
  // Tiles nobody has been seen to hold: the bag plus opponents' hidden
  // starting tiles.
  readonly unseen = new Map<string, number>(Object.entries(STARTING_BAG));
  readonly inferredRacks = new Map<string, Map<string, number>>();
  readonly balances = new Map<string, number>();

  // `myStartingRack` is subtracted from the unseen pool; pass the rack as
  // dealt, before any auction wins.
  constructor(
    myBotId: bigint | null,
    myStartingRack?: Map<string, number>,
    matchId?: bigint,
  ) {
    this.myBotId = myBotId;
    this.matchId = matchId;
    this.myStartingRack = new Map(myStartingRack ?? []);
    if (myStartingRack) {
      for (const [letter, n] of myStartingRack) this.takeUnseen(letter, n);
    }
  }

  onAuctionResult(r: AuctionResultRow) {
    if (this.logEvents) {
      logger.logAuctionResult(this.matchId, {
        auctionId: r.auctionId,
        letter: r.letter,
        winner: r.winnerBotId ?? null,
        topBid: null,
        paid: Number(r.paid),
      });
    }
    // The tile left the bag when the auction opened, winner or not.
    this.takeUnseen(r.letter, 1);
    if (r.winnerBotId === undefined || r.winnerBotId === null) return;
    if (r.winnerBotId === this.myBotId) return;

    const key = String(r.winnerBotId);
    const paid = Number(r.paid);
    const balance = this.balance(key);
    // The module drops a win the bot can't pay for.
    if (balance < paid) return;
    this.balances.set(key, balance - paid);
    const rack = this.rack(key);
    rack.set(r.letter, (rack.get(r.letter) ?? 0) + 1);

    const prices = paidHistory.get(r.letter) ?? [];
    prices.push(paid);
    if (prices.length > PAID_HISTORY_LIMIT) prices.shift();
    paidHistory.set(r.letter, prices);
  }

  onWordPlay(w: WordPlayRow) {
    if (this.logEvents) {
      logger.logWordPlay(this.matchId, {
        botId: w.botId,
        word: w.word,
        letters: [...w.word],
        totalReward: w.totalReward === undefined ? undefined : Number(w.totalReward),
      });
    }
    if (w.botId === this.myBotId) return;
    const key = String(w.botId);
    const rack = this.rack(key);
    for (const c of w.word) {
      const have = rack.get(c) ?? 0;
      if (have > 0) {
        if (have === 1) rack.delete(c);
        else rack.set(c, have - 1);
      } else {
        // Came from their hidden starting rack, so it's no longer unseen.
        this.takeUnseen(c, 1);
      }
    }
    this.balances.set(key, this.balance(key) + wordPayout(w.word));
  }

  unseenTotal(): number {
    let n = 0;
    for (const c of this.unseen.values()) n += c;
    return n;
  }

  // Chance a given unseen tile is `letter`.
  pInBag(letter: string): number {
    const total = this.unseenTotal();
    return total === 0 ? 0 : (this.unseen.get(letter) ?? 0) / total;
  }

  // Median price opponents have paid for `letter`, or 0 with no data.
  typicalTopBid(letter: string): number {
    const prices = paidHistory.get(letter);
    if (!prices || prices.length === 0) return 0;
    const sorted = [...prices].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  rackSize(botKey: string): number {
    let n = 0;
    for (const c of this.inferredRacks.get(botKey)?.values() ?? []) n += c;
    return n;
  }

  // The opponent with the highest estimated balance, among those we've seen
  // win or play. Ties go to the larger inferred rack.
  richestOpponent(): { botKey: string; balance: number; rackSize: number } | null {
    let best: { botKey: string; balance: number; rackSize: number } | null = null;
    for (const botKey of new Set([...this.balances.keys(), ...this.inferredRacks.keys()])) {
      const balance = this.balance(botKey);
      const rackSize = this.rackSize(botKey);
      if (
        !best ||
        balance > best.balance ||
        (balance === best.balance && rackSize > best.rackSize)
      ) {
        best = { botKey, balance, rackSize };
      }
    }
    return best;
  }

  maxOpponentRackSize(): number {
    let max = 0;
    for (const key of this.inferredRacks.keys()) max = Math.max(max, this.rackSize(key));
    return max;
  }

  snapshot() {
    const racks: Record<string, string> = {};
    for (const [bot, rack] of this.inferredRacks) {
      racks[bot] = Array.from(rack).map(([l, n]) => l.repeat(n)).join("");
    }
    return {
      inferredRacks: racks,
      inferredBalances: Object.fromEntries(this.balances),
      unseenTotal: this.unseenTotal(),
      unseen: Object.fromEntries([...this.unseen].filter(([, n]) => n > 0)),
    };
  }

  private takeUnseen(letter: string, n: number) {
    this.unseen.set(letter, Math.max(0, (this.unseen.get(letter) ?? 0) - n));
  }

  private rack(key: string): Map<string, number> {
    let rack = this.inferredRacks.get(key);
    if (!rack) {
      rack = new Map();
      this.inferredRacks.set(key, rack);
    }
    return rack;
  }

  private balance(key: string): number {
    return this.balances.get(key) ?? STARTING_BALANCE;
  }
}
