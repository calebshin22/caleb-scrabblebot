// Runs Doppio's AdaptiveStrategy (see ./strategy.ts) on cortado's live state.
// Keeps a per-match history of public events, so building a decision context
// never rescans the whole database.

import { loadDictionary } from "./dictionary.js";
import { AdaptiveStrategy } from "./strategy.js";
import type { DecisionContext, ParticipantObservation } from "./types.js";

let engine: AdaptiveStrategy | null = null;

export function doppio(): AdaptiveStrategy {
  engine ??= new AdaptiveStrategy(loadDictionary());
  return engine;
}

interface Event {
  t: bigint; // micros since epoch, for interleaving wins and plays
  auction?: { auctionId: string; letter: string; winnerBotId: string | null; paid: number };
  word?: { botId: string; word: string; totalReward: number };
}

export class MatchHistory {
  private events: Event[] = [];
  readonly myBids = new Map<string, number>();

  constructor(readonly initialRack: number[]) {}

  addAuction(t: bigint, auctionId: bigint, letter: string, winner: bigint | null | undefined, paid: bigint) {
    this.events.push({
      t,
      auction: {
        auctionId: String(auctionId),
        letter,
        winnerBotId: winner === undefined || winner === null ? null : String(winner),
        paid: Number(paid),
      },
    });
  }

  addWord(t: bigint, botId: bigint, word: string, totalReward: bigint) {
    this.events.push({ t, word: { botId: String(botId), word, totalReward: Number(totalReward) } });
  }

  sorted(): Event[] {
    // Wins before plays at the same instant, as the module orders them.
    return [...this.events].sort((a, b) =>
      a.t < b.t ? -1 : a.t > b.t ? 1 : Number(!!b.auction) - Number(!!a.auction),
    );
  }
}

export function rackArray(rack: Map<string, number>): number[] {
  const out = new Array<number>(26).fill(0);
  for (const [letter, n] of rack) {
    const i = letter.charCodeAt(0) - 65;
    if (i >= 0 && i < 26) out[i] += n;
  }
  return out;
}

export function buildContext(a: {
  matchId: bigint;
  auctionId: bigint | null;
  letter: string;
  myBotId: bigint;
  myRack: Map<string, number>;
  myBalance: number;
  myScore: number;
  bagTotal: number;
  startingRackSize: number;
  auctionType: "Vickrey" | "FirstPrice";
  participants: { botId: bigint; balance: bigint; score: bigint }[];
  simulatedStrategy: (botId: bigint) => string | undefined;
  history: MatchHistory;
}): DecisionContext {
  const events = a.history.sorted();
  const auctions = events.filter((e) => e.auction).map((e) => ({
    ...e.auction!,
    myBid: a.history.myBids.get(e.auction!.auctionId),
  }));
  const words = events.filter((e) => e.word).map((e) => e.word!);
  const opponents: ParticipantObservation[] = a.participants
    .filter((p) => p.botId !== a.myBotId)
    .map((p) => {
      const id = String(p.botId);
      const known = new Array<number>(26).fill(0);
      let rackSize = a.startingRackSize;
      for (const e of events) {
        if (e.auction?.winnerBotId === id) {
          known[e.auction.letter.charCodeAt(0) - 65]++;
          rackSize++;
        } else if (e.word?.botId === id) {
          for (const c of e.word.word) {
            const i = c.charCodeAt(0) - 65;
            known[i] = Math.max(0, known[i] - 1);
          }
          rackSize -= e.word.word.length;
        }
      }
      return {
        botId: id,
        balance: Number(p.balance),
        score: Number(p.score),
        rackSize: Math.max(0, rackSize),
        knownLetters: known,
        simulatedStrategy: a.simulatedStrategy(p.botId),
      };
    });
  return {
    matchId: String(a.matchId),
    auctionId: a.auctionId === null ? "" : String(a.auctionId),
    letter: a.letter,
    myBotId: String(a.myBotId),
    myRack: rackArray(a.myRack),
    myBalance: a.myBalance,
    myScore: a.myScore,
    // The bag count excludes the tile on auction now.
    remainingAuctions: a.bagTotal + 1,
    startingRackSize: a.startingRackSize,
    auctionType: a.auctionType,
    phase: "practice",
    opponents,
    auctionHistory: auctions,
    wordHistory: words,
    initialRack: a.history.initialRack,
  };
}
