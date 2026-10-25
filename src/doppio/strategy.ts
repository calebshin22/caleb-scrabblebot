// Adapted from mm-nair/ScrabbleBot (teammate's bot "Doppio"), src/strategy.ts.
// Upstream pieces are MIT-licensed (Clockwork Labs); see that repo.

import {
  DEFAULT_COUNTS,
  LETTER_VALUES,
  type WordDictionary,
  type WordEntry,
  subtractWord,
} from "./dictionary.js";
import { RackPlanner } from "./planner.js";
import { createBaseline } from "./baselines.js";
import type { BotStrategy, DecisionContext, Rack } from "./types.js";

export interface StrategyOptions {
  bidScale: number;
  optionWeight: number;
  reserveCoins: number;
  completionLimit: number;
  searchStates: number;
  denialWeight: number;
  acquisitionShare: number;
  rolloutSamples: number;
  rolloutDepth: number;
  rolloutWeight: number;
  coinReturn: number;
  winShare: number;
  reinvestWeight: number;
}

export const DEFAULT_STRATEGY_OPTIONS: StrategyOptions = {
  bidScale: 1.25,
  optionWeight: 0.9,
  reserveCoins: 8,
  completionLimit: 12,
  searchStates: 350,
  denialWeight: 0.2,
  acquisitionShare: 1.8,
  rolloutSamples: 32,
  rolloutDepth: 4,
  rolloutWeight: 0.9,
  coinReturn: 0.7,
  winShare: 0.6,
  reinvestWeight: 0,
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const rackSize = (myRack: Rack): number =>
  myRack.reduce((total, count) => total + count, 0);

function probabilityAtLeast(mean: number, needed: number): number {
  let term = Math.exp(-mean);
  let probability = term;
  for (let count = 1; count < needed; count++) {
    term *= mean / count;
    probability += term;
  }
  return clamp(1 - probability, 0, 1);
}

export function estimateUnseenLetters(context: DecisionContext): number[] {
  const unseenLetters = DEFAULT_COUNTS.map(
    (count, index) => count - (context.initialRack?.[index] ?? 0),
  );
  for (const auction of context.auctionHistory) {
    unseenLetters[auction.letter.charCodeAt(0) - 65]--;
  }
  if (/^[A-Z]$/.test(context.letter)) {
    unseenLetters[context.letter.charCodeAt(0) - 65]--;
  }
  for (const opponent of context.opponents) {
    const acquiredLetters = new Array<number>(26).fill(0);
    const playedLetters = new Array<number>(26).fill(0);
    for (const auction of context.auctionHistory) {
      if (auction.winnerBotId === opponent.botId) {
        acquiredLetters[auction.letter.charCodeAt(0) - 65]++;
      }
    }
    for (const play of context.wordHistory) {
      if (play.botId === opponent.botId) {
        for (const letter of play.word) playedLetters[letter.charCodeAt(0) - 65]++;
      }
    }
    for (let index = 0; index < 26; index++) {
      unseenLetters[index] -= Math.max(0, playedLetters[index] - acquiredLetters[index]);
    }
  }
  return unseenLetters.map((count) => Math.max(0, count));
}

const MARKET_PRIOR_WEIGHT = 2;

export const TYPICAL_LETTER_PRICES = [11, 15, 18, 14, 11, 19, 12, 21, 10, 28, 23, 11, 17, 10, 10, 16, 24, 11, 12, 10, 10, 17, 19, 32, 21, 37];

export function typicalLetterPrice(letter: string): number {
  return TYPICAL_LETTER_PRICES[letter.charCodeAt(0) - 65];
}

export function estimateMarketPrice(context: DecisionContext, letter: string): number {
  let weightedPrice = MARKET_PRIOR_WEIGHT;
  let totalWeight = MARKET_PRIOR_WEIGHT;
  const recentAuctions = context.auctionHistory.slice(-24);
  for (let index = 0; index < recentAuctions.length; index++) {
    const auction = recentAuctions[index];
    if (auction.winnerBotId === null) continue;
    const weight = (0.4 + index / Math.max(1, recentAuctions.length)) *
      (auction.letter === letter ? 2 : 1);
    const lowerBound = auction.winnerBotId === context.myBotId
      ? auction.paid
      : Math.max(auction.paid, auction.myBid ?? 0);
    weightedPrice += weight * lowerBound / typicalLetterPrice(auction.letter);
    totalWeight += weight;
  }
  return Math.max(1, weightedPrice / totalWeight * typicalLetterPrice(letter));
}

export interface InventoryValue {
  value: number;
  liquidation: number;
}

export class AdaptiveStrategy implements BotStrategy {
  readonly name: string = "adaptive";
  private readonly planner: RackPlanner;
  private readonly options: StrategyOptions;
  private readonly headToHeadBidding: BotStrategy;
  private readonly inventoryCache = new Map<string, InventoryValue>();
  private contextKey = "";
  private unseenLetters: number[] = [];
  private unseenTotal = 0;
  private acquisitionShare = 0;
  private futureRacks: { myRack: number[]; score: number }[] = [];

  constructor(private readonly dictionary: WordDictionary, options: Partial<StrategyOptions> = {}) {
    this.options = { ...DEFAULT_STRATEGY_OPTIONS, ...options };
    this.planner = new RackPlanner(dictionary);
    this.headToHeadBidding = createBaseline(dictionary, "aggressive");
  }

  private prepare(context: DecisionContext): void {
    const contextKey = [
      context.matchId, context.auctionId, context.myBalance, context.remainingAuctions,
      context.auctionHistory.length, context.wordHistory.length,
      ...context.opponents.map((opponent) => `${opponent.balance}:${opponent.score}`),
    ].join("|");
    if (contextKey === this.contextKey) return;
    this.contextKey = contextKey;
    this.inventoryCache.clear();
    this.unseenLetters = estimateUnseenLetters(context);
    this.unseenTotal = this.unseenLetters.reduce((total, count) => total + count, 0);
    const totalBalance = context.myBalance + context.opponents.reduce(
      (total, opponent) => total + opponent.balance, 0,
    );
    this.acquisitionShare = clamp(
      this.options.acquisitionShare * context.myBalance / Math.max(1, totalBalance) + 0.12,
      0.12, 0.85,
    );
    const depth = Math.min(this.options.rolloutDepth,
      Math.floor(Math.max(0, context.remainingAuctions - 2) * this.acquisitionShare));
    this.futureRacks = [];
    if (depth > 0 && this.options.rolloutWeight > 0) {
      let randomState = 2166136261;
      for (const character of `${context.matchId}:${context.auctionId}`) {
        randomState = Math.imul(randomState ^ character.charCodeAt(0), 16777619) >>> 0;
      }
      const random = (): number => {
        randomState ^= randomState << 13;
        randomState ^= randomState >>> 17;
        randomState ^= randomState << 5;
        return (randomState >>> 0) / 4294967296;
      };
      for (let sample = 0; sample < this.options.rolloutSamples; sample++) {
        const unseenLetters = this.unseenLetters.slice();
        let unseenTotal = this.unseenTotal;
        const myRack = new Array<number>(26).fill(0);
        for (let draw = 0; draw < depth && unseenTotal > 0; draw++) {
          let selected = Math.floor(random() * unseenTotal);
          for (let letterIndex = 0; letterIndex < 26; letterIndex++) {
            if (selected < unseenLetters[letterIndex]) {
              myRack[letterIndex]++;
              unseenLetters[letterIndex]--;
              unseenTotal--;
              break;
            }
            selected -= unseenLetters[letterIndex];
          }
        }
        this.futureRacks.push({ myRack, score: this.liquidate(myRack).score });
      }
    }
  }

  private liquidate(myRack: Rack) {
    return this.planner.plan(myRack, {
      maxStates: this.options.searchStates,
      maxCandidates: 64,
    });
  }

  protected coinValue(context: DecisionContext, remainingAuctions = context.remainingAuctions): number {
    const marketPrice = estimateMarketPrice(context, "D");
    const winShare = clamp(this.options.winShare / (context.opponents.length + 1), 0.15, 0.6);
    const expectedFutureSpend = Math.max(0, remainingAuctions - 2) * winShare * marketPrice;
    const deployability = clamp(expectedFutureSpend / Math.max(1, context.myBalance), 0.05, 1);
    return this.options.coinReturn * deployability;
  }

  evaluateInventory(context: DecisionContext, myRack: Rack): InventoryValue {
    this.prepare(context);
    return this.inventoryValue(context, myRack);
  }

  protected inventoryValue(context: DecisionContext, myRack: Rack): InventoryValue {
    const cacheKey = myRack.join(",");
    const cached = this.inventoryCache.get(cacheKey);
    if (cached) return cached;
    const liquidation = this.liquidate(myRack).score;
    const futureAuctions = Math.max(0, context.remainingAuctions - 2);
    let optionValue = 0;
    if (futureAuctions > 0 && this.unseenTotal > 0 && this.options.optionWeight > 0) {
      const coinValue = this.coinValue(context);
      const completions = this.dictionary.completions(
        myRack, 2, Math.min(10, rackSize(myRack) + 2), 48,
      );
      const candidates = completions.filter((completion) => completion.missingCount > 0)
        .map((completion) => {
          let completionProbability = 1;
          let acquisitionCost = 0;
          for (let index = 0; index < 26; index++) {
            const needed = completion.missingCounts[index];
            if (needed === 0) continue;
            if (this.unseenLetters[index] < needed) {
              completionProbability = 0;
              break;
            }
            const expectedAcquisitions = futureAuctions * this.unseenLetters[index] /
              this.unseenTotal * this.acquisitionShare;
            completionProbability *= probabilityAtLeast(expectedAcquisitions, needed);
            acquisitionCost += needed * estimateMarketPrice(context, String.fromCharCode(65 + index));
          }
          const upperGain = completion.score - acquisitionCost * coinValue;
          return { completion, completionProbability, acquisitionCost, upperGain };
        })
        .filter((candidate) => candidate.completionProbability > 0 && candidate.upperGain > 0)
        .sort((left, right) =>
          right.completionProbability * right.upperGain - left.completionProbability * left.upperGain,
        )
        .slice(0, this.options.completionLimit);
      const outcomes = candidates.map((candidate) => {
        const remainingRack = myRack.map((count, index) =>
          Math.max(0, count - candidate.completion.counts[index]),
        );
        const completedScore = candidate.completion.score + this.liquidate(remainingRack).score;
        const netGain = Math.max(0, completedScore - liquidation - candidate.acquisitionCost * coinValue);
        return { completionProbability: candidate.completionProbability, netGain };
      }).sort((left, right) => right.netGain - left.netGain);
      optionValue = outcomes.reduce((best, outcome) => Math.max(best, outcome.completionProbability * outcome.netGain), 0);
    }
    let continuationValue = 0;
    for (const futureRack of this.futureRacks) {
      const combinedRack = myRack.map((count, index) => count + futureRack.myRack[index]);
      continuationValue += this.liquidate(combinedRack).score - futureRack.score;
    }
    const continuationGain = this.futureRacks.length > 0
      ? Math.max(0, continuationValue / this.futureRacks.length - liquidation) : 0;
    const value = liquidation + Math.max(
      optionValue * this.options.optionWeight,
      continuationGain * this.options.rolloutWeight,
    );
    const result = { value, liquidation };
    this.inventoryCache.set(cacheKey, result);
    return result;
  }

  private denialValue(context: DecisionContext, letterIndex: number): number {
    if (this.options.denialWeight <= 0) return 0;
    let denialValue = 0;
    const minimumOpponentScore = Math.min(...context.opponents.map((opponent) => opponent.score));
    for (const opponent of context.opponents) {
      if (opponent.balance <= 0) continue;
      const knownLetters = [...opponent.knownLetters];
      const beforeScore = this.liquidate(knownLetters).score;
      knownLetters[letterIndex]++;
      const improvement = this.liquidate(knownLetters).score - beforeScore;
      const relevance = context.phase === "elimination"
        ? (opponent.score === minimumOpponentScore ? 1 : 0.25)
        : context.opponents.length === 1 ? 1 : 0.5;
      denialValue = Math.max(denialValue, improvement * relevance);
    }
    return denialValue * this.options.denialWeight;
  }

  decideBid(context: DecisionContext): number {
    if (context.remainingAuctions <= 1 || context.myBalance < 1 || !/^[A-Z]$/.test(context.letter)) return 0;
    if (context.opponents.length === 1 && context.auctionType === "Vickrey" && context.remainingAuctions > 3) {
      return Math.min(this.headToHeadBidding.decideBid(context), context.opponents[0].balance + 1);
    }
    this.prepare(context);
    const letterIndex = context.letter.charCodeAt(0) - 65;
    const augmentedRack = [...context.myRack];
    augmentedRack[letterIndex]++;
    const beforeValue = this.inventoryValue(context, context.myRack);
    const afterValue = this.inventoryValue(context, augmentedRack);
    const marginalValue = Math.max(0, afterValue.value - beforeValue.value) +
      this.denialValue(context, letterIndex);
    const coinValue = this.coinValue(context);
    const reserveCoins = context.remainingAuctions <= 5 || afterValue.liquidation > beforeValue.liquidation
      ? 0 : Math.min(this.options.reserveCoins, context.myBalance * 0.2);
    const bidLimit = Math.max(0, Math.floor(Math.min(
      context.myBalance - reserveCoins,
      marginalValue * this.options.bidScale / coinValue,
    )));
    if (bidLimit === 0) return 0;
    const opponentBalance = Math.max(0, ...context.opponents.map((opponent) => opponent.balance));
    const maximumBid = Math.min(bidLimit, opponentBalance + 1);
    if (context.auctionType === "Vickrey") return maximumBid;
    const marketPrice = estimateMarketPrice(context, context.letter);
    let bestBid = 0;
    let bestUtility = 0;
    for (let amount = 1; amount <= maximumBid; amount++) {
      const winProbability = 1 / (1 + Math.exp(-(amount - marketPrice - 0.5) /
        Math.max(1, marketPrice * 0.4)));
      const utility = winProbability * (marginalValue * this.options.bidScale - amount * coinValue);
      if (utility > bestUtility) {
        bestUtility = utility;
        bestBid = amount;
      }
    }
    return bestBid;
  }

  chooseWord(context: DecisionContext): string | null {
    this.prepare(context);
    const plan = this.liquidate(context.myRack);
    if (plan.words.length === 0) return null;
    if (context.remainingAuctions <= 2) return plan.words[0];
    const beforeValue = this.inventoryValue(context, context.myRack).value;
    const planEntries = plan.words.map((word) => this.dictionary.find(word)).filter(
      (entry): entry is WordEntry => entry !== undefined,
    );
    const candidates = [...new Map([
      ...planEntries,
      ...this.dictionary.playable(context.myRack).slice().sort((left, right) => right.score - left.score).slice(0, 5),
    ].map((entry) => [entry.word, entry])).values()];
    let bestWord: string | null = null;
    let bestValue = beforeValue - 0.2;
    const liquidityPressure = clamp(this.options.reserveCoins * 2 / Math.max(1, context.myBalance) - 0.5, 0, 2);
    const reinvestValue = this.coinValue(context) * this.options.reinvestWeight;
    for (const candidate of candidates) {
      const remainingRack = subtractWord(context.myRack, candidate);
      const afterValue = candidate.score + this.inventoryValue(context, remainingRack).value;
      const liquidityBenefit = candidate.score * (liquidityPressure * 0.3 + reinvestValue);
      const sevenLetterBenefit = candidate.length >= 7 ? 0.5 : 0;
      const value = afterValue + liquidityBenefit + sevenLetterBenefit;
      if (value > bestValue) {
        bestValue = value;
        bestWord = candidate.word;
      }
    }
    return bestWord;
  }
}

export function createStrategy(dictionary: WordDictionary, options: Partial<StrategyOptions> = {}): BotStrategy {
  return new AdaptiveStrategy(dictionary, options);
}
