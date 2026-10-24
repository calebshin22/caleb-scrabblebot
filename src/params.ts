// Every strategy number. Loaded from ./strategy.json at startup and again at
// each match start, so tuning applies without code changes. Keys missing
// from the file keep the defaults below.

import * as fs from "node:fs";
import * as path from "node:path";

export const PARAMS_PATH = path.join(process.cwd(), "strategy.json");

export const DEFAULT_PARAMS = {
  // Bidding
  bid_aggression: 1,              // multiplier on the final letter value
  new_letter_premium: 2,          // heuristic: added for letters not yet held
  duplicate_penalty: 1,           // heuristic: multiplier for letters already held
  vowel_scarcity_threshold: 0.03, // a vowel is scarce below this pInBag
  vowel_scarcity_mult: 1.4,
  u_with_q_mult: 2.5,             // U when holding a Q
  q_without_u_mult: 0.2,          // Q when no U is held or left
  denial_rack_size: 5,            // Vickrey: deny when an opponent holds this many
  denial_fraction: 0.9,           // ...by bidding this fraction of the typical price
  defense_weight: 0,              // add this x the letter's value to the opponent
                                  // likeliest to win it (their "best reply")
  first_price_shade: 1.1,         // first-price: bid up to typical price * this
  first_price_floor: 0.6,         // ...but no less than value * this
  endgame_bag_size: 10,           // tiles left in the bag that count as endgame
  endgame_spend_fraction: 0,      // endgame: spend this share of balance per tile left

  // Score-dependent play ("open/close the board" in auction terms)
  open_board_when_behind: false,  // behind: bid harder, hold for long words
  behind_aggression: 1.15,        // ...bid multiplier
  behind_min_word_length: 5,      // ...shortest word worth playing
  close_board_when_ahead: false,  // ahead: play at once, defend harder
  ahead_defense_mult: 1.5,        // ...defense_weight multiplier

  // Deception (not tuned: simulated opponents don't model us, so tuning
  // would only see its cost)
  deception_enabled: true,
  price_set_rack_size: 5,         // Vickrey: push up the price for the richest
                                  // opponent when they hold this many tiles...
  price_set_max_value: 5,         // ...and the letter is worth less than this to us
  price_set_fraction: 0.95,       // bid this fraction of the typical price
  price_set_cap_fraction: 0.5,    // ...but at most this share of our balance
  bid_jitter: 0.12,               // multiply bids by a random 1 +/- this
  skip_chance: 0.08,              // chance to skip a letter worth less than skip_max_value
  skip_max_value: 8,

  // Word play: value = point_weight * points + leave_weight * leave + bingo
  point_weight: 1,
  leave_weight: 0,                // weight on the quality of the tiles left over
  bingo_bonus: 0,                 // extra value for 7+ letter words
  random_top_k: 1,                // pick at random among the k best words
  play_min_length: 2,
  play_min_score: 0,
  hold_rack_size: 0,              // hold until the rack has this many tiles
  tempo_hold_enabled: false,      // see the commented-out stub in chooseWord

  // Per-opponent counters from data/opponents.json (overrides in "counters")
  counters_enabled: true,

  // Monte Carlo letter valuation (compute knobs, not tuned)
  sim_min_rack_size: 4,           // use the simulator from this rack size up
  sim_samples: 500,
  sim_draw_size: 6,
  sim_budget_ms: 250,             // auctions last 1000 ms; stop sampling after this
};

export type Params = typeof DEFAULT_PARAMS;
export type ParamKey = keyof Params;
export type NumericParamKey = {
  [K in ParamKey]: Params[K] extends number ? K : never;
}[ParamKey];
export type Counters = Record<string, Partial<Params>>;

// Mutated in place so every importer sees reloads.
export const PARAMS: Params = { ...DEFAULT_PARAMS };
export const COUNTERS: Counters = {};

// What tuners may change, and within what range.
export const TUNABLE: Partial<
  Record<NumericParamKey, { kind: "float" | "int"; min: number; max: number }>
> = {
  bid_aggression: { kind: "float", min: 0.1, max: 8 },
  new_letter_premium: { kind: "float", min: 0, max: 30 },
  duplicate_penalty: { kind: "float", min: 0, max: 2 },
  vowel_scarcity_threshold: { kind: "float", min: 0, max: 0.2 },
  vowel_scarcity_mult: { kind: "float", min: 1, max: 5 },
  u_with_q_mult: { kind: "float", min: 1, max: 10 },
  q_without_u_mult: { kind: "float", min: 0, max: 1 },
  denial_rack_size: { kind: "int", min: 1, max: 20 },
  denial_fraction: { kind: "float", min: 0, max: 2 },
  defense_weight: { kind: "float", min: 0, max: 3 },
  first_price_shade: { kind: "float", min: 0.1, max: 3 },
  first_price_floor: { kind: "float", min: 0, max: 1 },
  endgame_bag_size: { kind: "int", min: 0, max: 40 },
  endgame_spend_fraction: { kind: "float", min: 0, max: 1 },
  behind_aggression: { kind: "float", min: 0.5, max: 3 },
  behind_min_word_length: { kind: "int", min: 2, max: 8 },
  ahead_defense_mult: { kind: "float", min: 0, max: 5 },
  point_weight: { kind: "float", min: 0.1, max: 5 },
  leave_weight: { kind: "float", min: 0, max: 10 },
  bingo_bonus: { kind: "float", min: 0, max: 50 },
  random_top_k: { kind: "int", min: 1, max: 5 },
  play_min_length: { kind: "int", min: 2, max: 8 },
  play_min_score: { kind: "float", min: 0, max: 50 },
  hold_rack_size: { kind: "int", min: 0, max: 15 },
  sim_min_rack_size: { kind: "int", min: 0, max: 20 },
};

function coerce(raw: Record<string, unknown>, base: Params): Params {
  const out = { ...base } as Record<ParamKey, number | boolean>;
  for (const key of Object.keys(DEFAULT_PARAMS) as ParamKey[]) {
    const v = raw[key];
    const ok =
      typeof DEFAULT_PARAMS[key] === "boolean"
        ? typeof v === "boolean"
        : typeof v === "number" && Number.isFinite(v);
    if (ok) out[key] = v as number | boolean;
  }
  return out as Params;
}

// Parse a strategy file without touching PARAMS (the arena seats several).
export function readStrategy(file = PARAMS_PATH): { params: Params; counters: Counters } {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`params: couldn't read ${file}, using defaults: ${err}`);
    }
  }
  const counters: Counters = {};
  const rc = raw.counters;
  if (rc && typeof rc === "object") {
    for (const [name, overrides] of Object.entries(rc as Record<string, unknown>)) {
      if (!overrides || typeof overrides !== "object") continue;
      const full = coerce(overrides as Record<string, unknown>, DEFAULT_PARAMS);
      counters[name] = Object.fromEntries(
        Object.keys(overrides).filter((k) => k in DEFAULT_PARAMS).map((k) => [k, full[k as ParamKey]]),
      ) as Partial<Params>;
    }
  }
  return { params: coerce(raw, DEFAULT_PARAMS), counters };
}

// Reload PARAMS and COUNTERS from disk.
export function loadParams(file = PARAMS_PATH): Params {
  const { params, counters } = readStrategy(file);
  Object.assign(PARAMS, params);
  for (const k of Object.keys(COUNTERS)) delete COUNTERS[k];
  Object.assign(COUNTERS, counters);
  return PARAMS;
}

// Apply a named counter's overrides on top of the loaded params.
export function applyCounter(name: string): Partial<Params> {
  const overrides = COUNTERS[name] ?? {};
  Object.assign(PARAMS, overrides);
  return overrides;
}

export function saveParams(params: Params, file = PARAMS_PATH, counters: Counters = COUNTERS) {
  fs.writeFileSync(file, JSON.stringify({ ...params, counters }, null, 2) + "\n");
}
