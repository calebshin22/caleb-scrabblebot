// Adapted from mm-nair/ScrabbleBot (teammate's bot "Cortadomacchiato"), src/planner.ts.
// Upstream pieces are MIT-licensed (Clockwork Labs); see that repo.

import { LETTER_VALUES, subtractWord, type WordDictionary, type WordEntry } from "./dictionary.js";
import type { Rack } from "./types.js";

export interface PlanOptions {
  maxStates?: number;
  maxCandidates?: number;
}

export interface RackPlan {
  score: number;
  words: string[];
  remainingRack: number[];
  exact: boolean;
}

interface SearchResult {
  score: number;
  entries: readonly WordEntry[];
  exact: boolean;
}

function fits(entry: WordEntry, myRack: Rack): boolean {
  return entry.letterIndices.every((letterIndex) => entry.counts[letterIndex] <= myRack[letterIndex]);
}

function greedyPlan(myRack: Rack, candidates: readonly WordEntry[]): SearchResult {
  const remainingRack = myRack.slice();
  const entries: WordEntry[] = [];
  let score = 0;
  for (const entry of candidates) {
    while (fits(entry, remainingRack)) {
      entries.push(entry);
      score += entry.score;
      for (const letterIndex of entry.letterIndices) remainingRack[letterIndex] -= entry.counts[letterIndex];
    }
  }
  return { score, entries, exact: false };
}

function upperBound(myRack: Rack): number {
  const length = myRack.reduce((sum, count) => sum + count, 0);
  if (length < 2) return 0;
  const baseScore = myRack.reduce((sum, count, index) => sum + count * LETTER_VALUES[index], 0);
  return Math.floor(baseScore * (length <= 3 ? 1 : Math.min(3, (length - 1) / 2)));
}

function selectCandidates(myRack: Rack, allCandidates: readonly WordEntry[], maxCandidates: number): WordEntry[] {
  if (allCandidates.length <= maxCandidates) return allCandidates.slice();
  const selected = new Set(allCandidates.slice(0, Math.max(1, Math.floor(maxCandidates / 4))));
  const lengths = new Map<number, WordEntry[]>();
  for (const entry of allCandidates) {
    const bucket = lengths.get(entry.length) ?? [];
    if (bucket.length < 3) bucket.push(entry);
    lengths.set(entry.length, bucket);
  }
  for (let position = 0; position < 3; position++) {
    for (const bucket of lengths.values()) {
      if (selected.size >= Math.floor(maxCandidates * 0.65)) break;
      if (bucket[position]) selected.add(bucket[position]);
    }
  }
  for (const entry of [...selected]) {
    if (selected.size >= maxCandidates) break;
    const remainingRack = subtractWord(myRack, entry);
    const complement = allCandidates.find((candidate) => !selected.has(candidate) && fits(candidate, remainingRack));
    if (complement) selected.add(complement);
  }
  for (const entry of allCandidates) {
    if (selected.size >= maxCandidates) break;
    selected.add(entry);
  }
  return [...selected].sort((left, right) => right.score - left.score || right.length - left.length || left.word.localeCompare(right.word));
}

export class RackPlanner {
  private readonly exactCache = new Map<string, SearchResult>();
  private readonly planCache = new Map<string, RackPlan>();

  constructor(readonly dictionary: WordDictionary) {}

  plan(myRack: Rack, options: PlanOptions = {}): RackPlan {
    const maxStates = Math.max(0, Math.floor(options.maxStates ?? 600));
    const maxCandidates = Math.max(1, Math.floor(options.maxCandidates ?? 128));
    const rackKey = myRack.join(",");
    const cacheKey = `${rackKey}:${maxStates}:${maxCandidates}`;
    const cachedPlan = this.planCache.get(cacheKey);
    if (cachedPlan) return { ...cachedPlan, words: cachedPlan.words.slice(), remainingRack: cachedPlan.remainingRack.slice() };
    const allCandidates = this.dictionary.playable(myRack);
    const candidates = selectCandidates(myRack, allCandidates, maxCandidates);
    const candidatesComplete = candidates.length === allCandidates.length;
    const memo = new Map<string, SearchResult>();
    let visitedStates = 0;

    const search = (remainingRack: Rack, availableCandidates: readonly WordEntry[]): SearchResult => {
      const key = remainingRack.join(",");
      const cached = this.exactCache.get(key) ?? memo.get(key);
      if (cached) return cached;
      const feasibleCandidates = availableCandidates.filter((entry) => fits(entry, remainingRack));
      if (feasibleCandidates.length === 0) return { score: 0, entries: [], exact: true };
      let best = greedyPlan(remainingRack, feasibleCandidates);
      if (best.score >= upperBound(remainingRack)) return { ...best, exact: true };
      if (++visitedStates > maxStates) return best;
      const frequencies = new Array<number>(26).fill(0);
      for (const entry of feasibleCandidates) {
        for (const letterIndex of entry.letterIndices) frequencies[letterIndex]++;
      }
      let pivot = -1;
      for (let letterIndex = 0; letterIndex < 26; letterIndex++) {
        if (frequencies[letterIndex] === 0) continue;
        if (pivot < 0 || frequencies[letterIndex] < frequencies[pivot] || frequencies[letterIndex] === frequencies[pivot] && LETTER_VALUES[letterIndex] > LETTER_VALUES[pivot]) pivot = letterIndex;
      }
      let exact = true;
      for (const entry of feasibleCandidates) {
        if (entry.counts[pivot] === 0) continue;
        const nextRack = subtractWord(remainingRack, entry);
        if (entry.score + upperBound(nextRack) <= best.score) continue;
        if (visitedStates >= maxStates) {
          exact = false;
          break;
        }
        const following = search(nextRack, feasibleCandidates);
        exact &&= following.exact;
        const score = entry.score + following.score;
        if (score > best.score) best = { score, entries: [entry, ...following.entries], exact: false };
        if (best.score >= upperBound(remainingRack)) {
          exact = true;
          break;
        }
      }
      if (best.score < upperBound(remainingRack)) {
        const nextRack = remainingRack.slice();
        nextRack[pivot]--;
        if (upperBound(nextRack) > best.score) {
          if (visitedStates >= maxStates) {
            exact = false;
          } else {
            const following = search(nextRack, feasibleCandidates);
            exact &&= following.exact;
            if (following.score > best.score) best = following;
          }
        }
      }
      const result = { ...best, exact };
      memo.set(key, result);
      if (exact && candidatesComplete) {
        if (this.exactCache.size >= 4096) this.exactCache.delete(this.exactCache.keys().next().value!);
        this.exactCache.set(key, result);
      }
      return result;
    };

    const result = search(myRack, candidates);
    let remainingRack = myRack.slice();
    for (const entry of result.entries) remainingRack = subtractWord(remainingRack, entry);
    const plan: RackPlan = {
      score: result.score,
      words: result.entries.map((entry) => entry.word),
      remainingRack,
      exact: result.exact && candidatesComplete || result.score >= upperBound(myRack),
    };
    if (this.planCache.size >= 2048) this.planCache.delete(this.planCache.keys().next().value!);
    this.planCache.set(cacheKey, plan);
    return { ...plan, words: plan.words.slice(), remainingRack: plan.remainingRack.slice() };
  }
}
