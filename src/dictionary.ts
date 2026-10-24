import * as fs from "node:fs";
import * as path from "node:path";

// The shared wordlist, uppercase, longest first for greedy picks.
export function loadDictionary(): string[] {
  const dictionaryPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "..",
    "spacetimedb",
    "wordlist.txt",
  );
  if (!fs.existsSync(dictionaryPath)) return [];
  const words = fs
    .readFileSync(dictionaryPath, "utf8")
    .split("\n")
    .map((l) => l.trim().toUpperCase())
    .filter((l) => l.length >= 2);
  words.sort((a, b) => b.length - a.length);
  return words;
}
