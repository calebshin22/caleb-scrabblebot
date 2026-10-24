// Append-only match log at data/matches.jsonl, one JSON event per line.
// Events are buffered in memory and flushed asynchronously, so logging never
// blocks the auction path. Off until `enableLogging()`, so tests and the
// tuner don't write.

import * as fs from "node:fs";
import * as path from "node:path";

export const LOG_PATH = path.join(process.cwd(), "data", "matches.jsonl");
const FLUSH_INTERVAL_MS = 1000;

let enabled = false;
let buffer: string[] = [];
let writing: Promise<void> = Promise.resolve();

export function enableLogging() {
  if (enabled) return;
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  enabled = true;
  setInterval(() => void flush(), FLUSH_INTERVAL_MS).unref();
  // Last resort for anything still buffered; can't wait for async I/O here.
  process.on("exit", () => {
    if (buffer.length === 0) return;
    fs.appendFileSync(LOG_PATH, buffer.join("\n") + "\n");
    buffer = [];
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      void flush().finally(() => process.exit(sig === "SIGINT" ? 130 : 143));
    });
  }
}

export function flush(): Promise<void> {
  if (buffer.length === 0) return writing;
  const chunk = buffer.join("\n") + "\n";
  buffer = [];
  writing = writing
    .then(() => fs.promises.appendFile(LOG_PATH, chunk))
    .catch((err) => console.warn(`logger: write failed: ${err}`));
  return writing;
}

function emit(type: string, matchId: bigint | undefined, fields: object) {
  if (!enabled) return;
  buffer.push(
    JSON.stringify(
      {
        t: new Date().toISOString(),
        type,
        matchId: matchId === undefined ? null : String(matchId),
        ...fields,
      },
      (_k, v) => (typeof v === "bigint" ? String(v) : v),
    ),
  );
}

export function rackString(rack: Map<string, number>): string {
  return Array.from(rack)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([letter, n]) => letter.repeat(n))
    .join("");
}

export const logger = {
  logMatchStart(
    matchId: bigint,
    f: {
      myBotId: bigint;
      auctionType: string;
      startingRack: string;
      bagTotal: number;
      resumed: boolean; // joined mid-match, e.g. after a restart
      arm: string | null; // strategy variant picked by the bandit
      params: object;
    },
  ) {
    emit("match_start", matchId, f);
  },
  // topBid is private until the match ends; see logTopBid.
  logAuctionResult(
    matchId: bigint | undefined,
    f: {
      auctionId?: bigint;
      letter: string;
      winner: bigint | null;
      topBid: number | null;
      paid: number;
    },
  ) {
    emit("auction_result", matchId, f);
  },
  logTopBid(matchId: bigint, f: { auctionId: bigint; topBid: number }) {
    emit("auction_top_bid", matchId, f);
  },
  logWordPlay(
    matchId: bigint | undefined,
    f: { botId: bigint; word: string; letters: string[]; totalReward?: number },
  ) {
    emit("word_play", matchId, f);
  },
  logBid(
    matchId: bigint | undefined,
    f: {
      auctionId?: bigint;
      letter: string;
      myRack: string;
      myValue: number;
      myBid: number;
      balance: number;
      inferredBagLeft: number | null;
      bagRemaining: number | null;
      auctionType: string | null;
      breakdown: object;
    },
  ) {
    emit("my_bid", matchId, f);
  },
  // Also printed, since price-setting risks winning a letter we don't want.
  logPriceSet(
    matchId: bigint | undefined,
    f: { letter: string; target: string; value: number; bid: number },
  ) {
    if (!enabled) return;
    console.log(
      `PRICE_SET match ${matchId} '${f.letter}': bid ${f.bid} (value ${f.value.toFixed(1)}) against bot ${f.target}`,
    );
    emit("price_set", matchId, f);
  },
  // Logged when chooseWord picks a word, before the module accepts it.
  logPlay(matchId: bigint | undefined, f: { word: string; score: number }) {
    emit("my_play", matchId, f);
  },
  logMatchEnd(
    matchId: bigint,
    f: {
      myScore: number | null;
      myBalance: number | null;
      myRackLeft: string;
      placement: number | null;
      players: number;
    },
  ) {
    emit("match_end", matchId, f);
  },
  logCounter(
    matchId: bigint,
    f: { counter: string; because: string[]; opponents: string[]; overrides: object },
  ) {
    emit("counter_strategy", matchId, f);
  },
  logIntelSnapshot(matchId: bigint, f: object) {
    emit("match_end_snapshot", matchId, f);
  },
};
