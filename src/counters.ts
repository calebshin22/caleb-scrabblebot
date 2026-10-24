// Pick a counter-strategy for a match from the opponents' profiles in
// data/opponents.json (written by analyze.py). The overrides for each
// counter live under "counters" in strategy.json.

import * as fs from "node:fs";
import * as path from "node:path";

export const OPPONENTS_PATH = path.join(process.cwd(), "data", "opponents.json");

export interface OpponentProfile {
  name?: string;
  simulated?: boolean;
  sim_strategy?: string | null;
  matches?: number;
  aggression?: number;
  bingo_rate?: number;
  avg_word_len?: number;
  style?: string;
  counter?: string;
}

export function loadOpponents(file = OPPONENTS_PATH): Record<string, OpponentProfile> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).bots ?? {};
  } catch {
    return {};
  }
}

// Most specific threat first: one hoarder in the lobby matters more than
// one cheapskate.
const PRIORITY = ["deny_hoarder", "price_set_aggressive", "outbid_cheap"];

export function pickCounter(profiles: (OpponentProfile | undefined)[]): {
  counter: string;
  because: string[];
} {
  for (const counter of PRIORITY) {
    const because = profiles
      .filter((p): p is OpponentProfile => p?.counter === counter)
      .map((p) => p.name ?? "?");
    if (because.length > 0) return { counter, because };
  }
  return { counter: "default", because: [] };
}
