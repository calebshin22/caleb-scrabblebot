// Adapted from mm-nair/ScrabbleBot (teammate's bot "Cortadomacchiato"), src/dictionary.ts.
// Upstream pieces are MIT-licensed (Clockwork Labs); see that repo.

import { readFileSync } from "node:fs";
import type { Rack } from "./types.js";

export const LETTER_VALUES = [1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10];
export const DEFAULT_COUNTS = [9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1];

export interface WordEntry {
  word: string;
  counts: readonly number[];
  letterIndices: readonly number[];
  score: number;
  length: number;
}

export interface WordCompletion extends WordEntry {
  missingCounts: number[];
  missingCount: number;
}

interface DictionaryNode {
  children: Map<number, DictionaryNode>;
  entry?: WordEntry;
  maximumScore: number;
  minimumLength: number;
}

function createNode(): DictionaryNode {
  return { children: new Map(), maximumScore: 0, minimumLength: Infinity };
}

function cacheResult<T>(cache: Map<string, T>, key: string, result: T, limit = 1024): void {
  if (cache.size >= limit) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
}

export function rackFromLetters(letters: string): number[] {
  const uppercaseLetters = letters.toUpperCase();
  if (!/^[A-Z]*$/.test(uppercaseLetters)) throw new Error("Rack letters must be A-Z");
  const counts = new Array<number>(26).fill(0);
  for (const letter of uppercaseLetters) counts[letter.charCodeAt(0) - 65]++;
  return counts;
}

export function rackToLetters(myRack: Rack): string {
  return myRack.map((count, index) => String.fromCharCode(65 + index).repeat(count)).join("");
}

export function scoreWord(word: string): number {
  const counts = rackFromLetters(word);
  const baseScore = counts.reduce((score, count, index) => score + count * LETTER_VALUES[index], 0);
  return Math.floor(baseScore * (word.length <= 3 ? 1 : Math.min(3, (word.length - 1) / 2)));
}

export function subtractWord(myRack: Rack, word: string | WordEntry): number[] {
  const counts = typeof word === "string" ? rackFromLetters(word) : word.counts;
  const remainingRack = myRack.map((count, index) => count - counts[index]);
  if (remainingRack.some((count) => count < 0)) throw new Error("Word cannot be spelled from rack");
  return remainingRack;
}

export class WordDictionary {
  readonly entries: readonly WordEntry[];
  private readonly root = createNode();
  private readonly words = new Set<string>();
  private readonly signatures = new Map<string, WordEntry>();
  private readonly playableCache = new Map<string, WordEntry[]>();
  private readonly completionCache = new Map<string, WordCompletion[]>();

  constructor(words: string[]) {
    for (const originalWord of words) {
      const word = originalWord.trim().toUpperCase();
      if (!/^[A-Z]{2,98}$/.test(word)) continue;
      this.words.add(word);
      const counts = rackFromLetters(word);
      const signature = rackToLetters(counts);
      const prior = this.signatures.get(signature);
      if (prior && prior.word <= word) continue;
      this.signatures.set(signature, {
        word,
        counts,
        letterIndices: counts.flatMap((count, index) => count > 0 ? [index] : []),
        score: scoreWord(word),
        length: word.length,
      });
    }
    this.entries = [...this.signatures.values()].sort((left, right) => right.score - left.score || right.length - left.length || left.word.localeCompare(right.word));
    for (const entry of this.entries) {
      let node = this.root;
      node.maximumScore = Math.max(node.maximumScore, entry.score);
      node.minimumLength = Math.min(node.minimumLength, entry.length);
      for (const letter of rackToLetters(entry.counts)) {
        const letterIndex = letter.charCodeAt(0) - 65;
        let child = node.children.get(letterIndex);
        if (!child) {
          child = createNode();
          node.children.set(letterIndex, child);
        }
        node = child;
        node.maximumScore = Math.max(node.maximumScore, entry.score);
        node.minimumLength = Math.min(node.minimumLength, entry.length);
      }
      node.entry = entry;
    }
    const nodes = [this.root];
    while (nodes.length > 0) {
      const node = nodes.pop()!;
      node.children = new Map([...node.children].sort((left, right) => right[1].maximumScore - left[1].maximumScore || left[0] - right[0]));
      nodes.push(...node.children.values());
    }
  }

  find(word: string): WordEntry | undefined {
    const uppercaseWord = word.toUpperCase();
    if (!this.words.has(uppercaseWord)) return undefined;
    const entry = this.signatures.get(rackToLetters(rackFromLetters(uppercaseWord)))!;
    return entry.word === uppercaseWord ? entry : { ...entry, word: uppercaseWord };
  }

  has(word: string): boolean {
    return this.words.has(word.toUpperCase());
  }

  playable(myRack: Rack): WordEntry[] {
    const key = myRack.join(",");
    const cached = this.playableCache.get(key);
    if (cached) return cached.slice();
    const availableCounts = myRack.slice();
    const entries: WordEntry[] = [];
    const visit = (node: DictionaryNode): void => {
      if (node.entry) entries.push(node.entry);
      for (const [letterIndex, child] of node.children) {
        if (availableCounts[letterIndex] <= 0) continue;
        availableCounts[letterIndex]--;
        visit(child);
        availableCounts[letterIndex]++;
      }
    };
    visit(this.root);
    entries.sort((left, right) => right.score - left.score || right.length - left.length || left.word.localeCompare(right.word));
    cacheResult(this.playableCache, key, entries);
    return entries.slice();
  }

  completions(myRack: Rack, maxMissing = 2, maxWordLength = 10, limit = 96): WordCompletion[] {
    const missingLimit = Math.max(0, Math.min(4, Math.floor(maxMissing)));
    const wordLengthLimit = Math.min(Math.floor(maxWordLength), myRack.reduce((sum, count) => sum + count, 0) + missingLimit);
    const resultLimit = Math.max(0, Math.floor(limit));
    if (resultLimit === 0 || wordLengthLimit < 2) return [];
    const key = `${myRack.join(",")}:${missingLimit}:${wordLengthLimit}:${resultLimit}`;
    const cached = this.completionCache.get(key);
    if (cached) return cached.slice();
    const availableCounts = myRack.slice();
    const entries: { entry: WordEntry; missingCount: number }[] = [];
    let visitedNodes = 0;
    const visit = (node: DictionaryNode, missingCount: number, length: number): void => {
      if (++visitedNodes > 30_000 || node.minimumLength > wordLengthLimit) return;
      if (node.entry) {
        entries.push({ entry: node.entry, missingCount });
      }
      if (length >= wordLengthLimit) return;
      for (const [letterIndex, child] of node.children) {
        const addedMissing = availableCounts[letterIndex] > 0 ? 0 : 1;
        if (missingCount + addedMissing > missingLimit) continue;
        availableCounts[letterIndex]--;
        visit(child, missingCount + addedMissing, length + 1);
        availableCounts[letterIndex]++;
        if (visitedNodes > 30_000) break;
      }
    };
    visit(this.root, 0, 0);
    entries.sort((left, right) => right.entry.score / (right.missingCount + 1) - left.entry.score / (left.missingCount + 1) || right.entry.score - left.entry.score || left.entry.word.localeCompare(right.entry.word));
    const selected: typeof entries = [];
    const selectedWords = new Set<string>();
    const representedLetters = new Set<number>();
    for (const entry of entries) {
      if (entry.missingCount !== 1) continue;
      const letterIndex = entry.entry.letterIndices.find((letterIndex) => entry.entry.counts[letterIndex] > myRack[letterIndex])!;
      if (representedLetters.has(letterIndex)) continue;
      selected.push(entry);
      selectedWords.add(entry.entry.word);
      representedLetters.add(letterIndex);
      if (selected.length >= resultLimit) break;
    }
    for (const entry of entries) {
      if (selected.length >= resultLimit) break;
      if (selectedWords.has(entry.entry.word)) continue;
      selected.push(entry);
    }
    selected.sort((left, right) => right.entry.score / (right.missingCount + 1) - left.entry.score / (left.missingCount + 1) || right.entry.score - left.entry.score || left.entry.word.localeCompare(right.entry.word));
    const completions = selected.map(({ entry, missingCount }) => ({
      ...entry,
      missingCount,
      missingCounts: entry.counts.map((count, index) => Math.max(0, count - myRack[index])),
    }));
    cacheResult(this.completionCache, key, completions);
    return completions.slice();
  }
}

let sharedDictionary: WordDictionary | undefined;

export function loadDictionary(): WordDictionary {
  // The module's own wordlist, shared with the rest of the bot.
  sharedDictionary ??= new WordDictionary(readFileSync(new URL("../../../spacetimedb/wordlist.txt", import.meta.url), "utf8").split(/\r?\n/));
  return sharedDictionary;
}
