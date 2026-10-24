// Tunable strategy numbers. Loaded from ./params.json at startup and again at
// each match start, so `npm run tune` can change them between matches.

import * as fs from "node:fs";
import * as path from "node:path";

export const PARAMS_PATH = path.join(process.cwd(), "params.json");

export const DEFAULT_PARAMS = {
  // Bidding
  bidAggression: 1,          // multiplier on the final letter value
  newLetterPremium: 2,       // heuristic: added for letters not yet held
  duplicatePenalty: 1,       // heuristic: multiplier for letters already held
  vowelScarcityThreshold: 0.03, // a vowel is scarce below this pInBag
  vowelScarcityMult: 1.4,
  uWithQMult: 2.5,           // U when holding a Q
  qWithoutUMult: 0.2,        // Q when no U is held or left
  denialRackSize: 5,         // Vickrey: deny when an opponent holds this many
  denialFraction: 0.9,       // ...by bidding this fraction of the typical price
  firstPriceShade: 1.1,      // first-price: bid up to typical price * this
  firstPriceFloor: 0.6,      // ...but no less than value * this
  endgameBagSize: 10,        // tiles left in the bag that count as endgame
  endgameSpendFraction: 0,   // endgame: spend this share of balance per tile left

  // Deception (not tuned: replayed opponents don't react to it, so the
  // tuner would only see its cost)
  deceptionEnabled: true,
  priceSetRackSize: 5,       // Vickrey: push up the price for the richest
                             // opponent when they hold this many tiles...
  priceSetMaxValue: 5,       // ...and the letter is worth less than this to us
  priceSetFraction: 0.95,    // bid this fraction of the typical price
  priceSetCapFraction: 0.5,  // ...but at most this share of our balance
  bidJitter: 0.12,           // multiply bids by a random 1 +/- this
  skipChance: 0.08,          // chance to skip a letter worth less than skipMaxValue
  skipMaxValue: 8,

  // Word play
  bingoBonus: 0,             // extra value for 7+ letter words
  playMinLength: 2,
  playMinScore: 0,
  holdRackSize: 0,           // hold until the rack has this many tiles
  leaveQualityWeight: 0,     // weight on the quality of the tiles left over
  tempoHoldEnabled: false,   // see the commented-out stub in chooseWord

  // Monte Carlo letter valuation (compute knobs, not tuned)
  simMinRackSize: 4,         // use the simulator from this rack size up
  simSamples: 500,
  simDrawSize: 6,
  simBudgetMs: 250,          // auctions last 1000 ms; stop sampling after this
};

export type Params = typeof DEFAULT_PARAMS;
export type ParamKey = keyof Params;
export type NumericParamKey = {
  [K in ParamKey]: Params[K] extends number ? K : never;
}[ParamKey];

// Mutated in place so every importer sees reloads.
export const PARAMS: Params = { ...DEFAULT_PARAMS };

// What `scripts/tune.ts` may change, and within what range.
export const TUNABLE: Partial<
  Record<NumericParamKey, { kind: "float" | "int"; min: number; max: number }>
> = {
  bidAggression: { kind: "float", min: 0.1, max: 5 },
  newLetterPremium: { kind: "float", min: 0, max: 20 },
  duplicatePenalty: { kind: "float", min: 0, max: 2 },
  vowelScarcityThreshold: { kind: "float", min: 0, max: 0.2 },
  vowelScarcityMult: { kind: "float", min: 1, max: 5 },
  uWithQMult: { kind: "float", min: 1, max: 10 },
  qWithoutUMult: { kind: "float", min: 0, max: 1 },
  denialRackSize: { kind: "int", min: 1, max: 20 },
  denialFraction: { kind: "float", min: 0, max: 2 },
  firstPriceShade: { kind: "float", min: 0.1, max: 3 },
  firstPriceFloor: { kind: "float", min: 0, max: 1 },
  endgameBagSize: { kind: "int", min: 0, max: 40 },
  endgameSpendFraction: { kind: "float", min: 0, max: 1 },
  bingoBonus: { kind: "float", min: 0, max: 50 },
  playMinLength: { kind: "int", min: 2, max: 8 },
  playMinScore: { kind: "float", min: 0, max: 50 },
  holdRackSize: { kind: "int", min: 0, max: 15 },
  leaveQualityWeight: { kind: "float", min: 0, max: 10 },
  simMinRackSize: { kind: "int", min: 0, max: 20 },
};

// Reload PARAMS from disk. Missing or bad entries keep their defaults.
export function loadParams(file = PARAMS_PATH): Params {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`params: couldn't read ${file}, using defaults: ${err}`);
    }
  }
  const out = PARAMS as Record<ParamKey, number | boolean>;
  for (const key of Object.keys(DEFAULT_PARAMS) as ParamKey[]) {
    const v = raw[key];
    const dflt = DEFAULT_PARAMS[key];
    const ok =
      typeof dflt === "boolean"
        ? typeof v === "boolean"
        : typeof v === "number" && Number.isFinite(v);
    out[key] = ok ? (v as number | boolean) : dflt;
  }
  return PARAMS;
}

export function saveParams(params: Params, file = PARAMS_PATH) {
  fs.writeFileSync(file, JSON.stringify(params, null, 2) + "\n");
}
