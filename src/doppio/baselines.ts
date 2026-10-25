// Adapted from mm-nair/ScrabbleBot (teammate's bot "Doppio"), src/baselines.ts.
// Upstream pieces are MIT-licensed (Clockwork Labs); see that repo.

import { LETTER_VALUES, type WordDictionary, type WordEntry } from "./dictionary.js";
import { RackPlanner } from "./planner.js";
import type { BotStrategy, DecisionContext } from "./types.js";

export type BaselineName = "starter" | "greedy" | "patient" | "aggressive" | "cheap" | "market";

export const BASELINE_NAMES: readonly BaselineName[] = ["starter", "greedy", "patient", "aggressive", "cheap", "market"];

export const MARKET_TOP_BIDS = [15.4, 19.6, 21.0, 18.2, 16.1, 22.1, 15.7, 24.6, 14.8, 32.6, 27.1, 14.6, 20.4, 14.4, 14.8, 21.4, 29.9, 15.9, 18.0, 14.1, 15.3, 19.5, 21.4, 36.6, 23.2, 40.0];

function hashedUnit(parts: readonly (string | number)[]): number {
  let state = 2166136261;
  for (const character of parts.join(":")) state = Math.imul(state ^ character.charCodeAt(0), 16777619) >>> 0;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 4294967296;
}

function bestScore(entries: readonly WordEntry[]): WordEntry | undefined {
  return entries.reduce<WordEntry | undefined>((best, entry) => !best || entry.score > best.score || (entry.score === best.score && entry.word < best.word) ? entry : best, undefined);
}

export function createBaseline(dictionary: WordDictionary, name: BaselineName): BotStrategy {
  const playableCache = new Map<string, WordEntry[]>();
  const planner = name === "market" ? new RackPlanner(dictionary) : undefined;
  const playable = (context: DecisionContext): WordEntry[] => {
    const key = context.myRack.join(",");
    const cached = playableCache.get(key);
    if (cached) return cached;
    const entries = dictionary.playable(context.myRack);
    if (playableCache.size >= 256) playableCache.clear();
    playableCache.set(key, entries);
    return entries;
  };
  return {
    name,
    decideBid(context) {
      const letterIndex = context.letter.charCodeAt(0) - 65;
      const value = LETTER_VALUES[letterIndex];
      const count = context.myRack[letterIndex];
      const starterBid = count === 0 ? value + 2 : Math.max(1, value);
      if (name === "starter") return Math.min(starterBid, context.myBalance);
      if (context.remainingAuctions <= 1) return 0;
      if (name === "market") {
        const rackSize = context.myRack.reduce((sum, letterCount) => sum + letterCount, 0);
        const noise = 0.8 + hashedUnit([context.matchId, context.auctionId, context.myBotId]) * 0.45;
        const balanceFactor = Math.min(1.2, Math.max(0.5, context.myBalance / 50));
        const duplicatePenalty = count >= 2 ? 0.5 : count === 1 ? 0.85 : 1;
        const crowdedPenalty = rackSize >= 12 ? 0.4 : 1;
        const augmentedMarketRack = [...context.myRack];
        augmentedMarketRack[letterIndex] += 1;
        const fitBonus = (bestScore(dictionary.playable(augmentedMarketRack))?.score ?? 0) > (bestScore(playable(context))?.score ?? 0) ? 1.3 : 1;
        const marketBid = Math.round(MARKET_TOP_BIDS[letterIndex] * 0.95 * noise * balanceFactor * duplicatePenalty * crowdedPenalty * fitBonus);
        return Math.max(0, Math.min(context.myBalance, marketBid));
      }
      if (name === "cheap") return Math.min(context.myBalance, count > 1 ? 1 : "AEIOURSTLN".includes(context.letter) ? 3 : 2);
      const augmentedRack = [...context.myRack];
      augmentedRack[letterIndex] += 1;
      const scoreBefore = bestScore(playable(context))?.score ?? 0;
      const scoreAfter = bestScore(dictionary.playable(augmentedRack))?.score ?? 0;
      const immediateGain = Math.max(0, scoreAfter - scoreBefore);
      const rackSize = context.myRack.reduce((sum, letterCount) => sum + letterCount, 0);
      let bid = starterBid;
      if (name === "greedy") bid = Math.max(starterBid, Math.floor(immediateGain * 0.8));
      if (name === "patient") bid = Math.max(starterBid + ("AEIOURSTLN".includes(context.letter) ? 3 : 0), Math.floor(immediateGain * 0.95));
      if (name === "aggressive") bid = Math.max(4, value + 6 + ("AEIOU".includes(context.letter) ? 3 : 0) - Math.max(0, count - 1) * 2, Math.floor(immediateGain * 1.2));
      if (context.remainingAuctions <= context.opponents.length + 2 && immediateGain === 0) bid = 0;
      if (name === "patient" && rackSize > 15 && immediateGain === 0) bid = Math.floor(bid / 2);
      return Math.max(0, Math.min(context.myBalance, bid));
    },
    chooseWord(context) {
      const entries = playable(context);
      if (name === "starter") {
        return entries.reduce<WordEntry | undefined>((best, entry) => !best || entry.length > best.length || (entry.length === best.length && entry.word < best.word) ? entry : best, undefined)?.word ?? null;
      }
      const best = bestScore(entries);
      if (!best) return null;
      if (name === "market") {
        const rackSize = context.myRack.reduce((sum, count) => sum + count, 0);
        const liquidate = context.remainingAuctions <= 3 || context.myBalance < 20 || rackSize >= 10;
        if (liquidate) return planner!.plan(context.myRack, { maxStates: 200, maxCandidates: 48 }).words[0] ?? null;
        if (best.length < 7 && best.score < 30) return null;
      }
      if (name === "patient" || name === "aggressive") {
        const rackSize = context.myRack.reduce((sum, count) => sum + count, 0);
        const requiredLength = name === "patient" ? 7 : 6;
        const liquidate = context.remainingAuctions <= Math.max(3, context.opponents.length * 2) || context.myBalance < 10 || rackSize >= 15;
        if (best.length < requiredLength && !liquidate) return null;
      }
      return best.word;
    },
  };
}
