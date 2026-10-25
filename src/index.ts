// ScrabbleBot bot starter.
//
// First run, with a token from the website:
//   On your team's page, click "Generate token", then run
//   `BOT_NAME=<name> BOT_TOKEN=<token> npm start`.
//
// Or with a nonce from the CLI:
//   1. `spacetime call scrabblebot mint_credential_nonce`
//      `spacetime sql 'SELECT code FROM my_nonces ORDER BY expires_at DESC'`
//   2. `BOT_NAME=<name> BOT_NONCE=<code> npm start`
//      The bot connects fresh and redeems the nonce.
//
// Either way the bot saves its token to .token-<BOT_NAME>, so later runs
// need only `BOT_NAME=<name> npm start`.
//
// Entering a tournament: `BOT_NAME=<name> TOURNAMENT_ID=<id> npm start`
// registers the bot for that tournament when it connects. Only the bot
// itself can register, so this has to come from the bot's process.
//
// Edit ./src/strategy.ts to customise how your bot bids and plays words.

import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { chooseWord, decideBid } from "./strategy.js";
import { Intel } from "./intel.js";
import { loadDictionary } from "./dictionary.js";
import { enableLogging, flush, logger, rackString } from "./logger.js";
import { applyCounter, ARMS, loadParams, PARAMS } from "./params.js";
import { pickArm, recordResult } from "./bandit.js";
import { loadOpponents, pickCounter } from "./counters.js";
import { initSimulator } from "./simulator.js";
import { buildContext, doppio, MatchHistory, rackArray } from "./doppio/engine.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

// Load the shared wordlist so the bot can pick playable words locally.
const DICTIONARY: string[] = loadDictionary();

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const bidsByAuction = new Set<string>();
const lastWordAttemptByMatch = new Map<string, number>();
const WORD_RETRY_MS = 500;
const intelByMatch = new Map<string, Intel>();
const startedMatches = new Set<string>();
const armByMatch = new Map<string, string>();
// Public event history per match, for the Doppio engine.
const historyByMatch = new Map<string, MatchHistory>();
// Matches this bot is or was in, so handlers can skip the rest of the
// database's history (hundreds of thousands of rows on connect) in O(1).
const myMatchIds = new Set<string>();
const endedThisSession = new Set<string>();

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function rackForMatch(
  conn: DbConnection,
  matchId: bigint,
): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  return rack;
}

function participantForMatch(
  conn: DbConnection,
  matchId: bigint,
): { balance: number; score: number } | null {
  if (myBotId === null || !myMatchIds.has(String(matchId))) return null;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId !== matchId) continue;
    if (p.botId !== myBotId) continue;
    return { balance: Number(p.balance), score: Number(p.score) };
  }
  return null;
}

function inMyRunningMatch(conn: DbConnection, matchId: bigint): boolean {
  return (
    myMatchIds.has(String(matchId)) &&
    conn.db.matchState.id.find(matchId)?.status.tag === "Running"
  );
}

// Our score minus the best opponent's, for the behind/ahead modes.
function scoreDiff(conn: DbConnection, matchId: bigint): number {
  let mine = 0;
  let best = -Infinity;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId !== matchId) continue;
    if (p.botId === myBotId) mine = Number(p.score);
    else best = Math.max(best, Number(p.score));
  }
  return best === -Infinity ? 0 : mine - best;
}

// Intel for a match this bot is in, built on first use from what's already
// in the cache. Callers feed it new rows only if it already existed, since a
// fresh one has replayed them.
function intelFor(conn: DbConnection, matchId: bigint): Intel | null {
  if (myBotId === null) return null;
  const key = String(matchId);
  const existing = intelByMatch.get(key);
  if (existing) return existing;
  if (!inMyRunningMatch(conn, matchId)) return null;

  const results = Array.from(conn.db.auctionResult.iter()).filter(
    (r) => r.matchId === matchId,
  );
  const plays = Array.from(conn.db.wordPlay.iter()).filter(
    (w) => w.matchId === matchId,
  );
  // Starting rack = current rack + letters played - letters won.
  const starting = rackForMatch(conn, matchId);
  const adjust = (letter: string, n: number) =>
    starting.set(letter, Math.max(0, (starting.get(letter) ?? 0) + n));
  for (const w of plays) {
    if (w.botId === myBotId) for (const c of w.word) adjust(c, 1);
  }
  for (const r of results) {
    if (r.winnerBotId === myBotId) adjust(r.letter, -1);
  }

  const intel = new Intel(myBotId, starting, matchId);
  const history = new MatchHistory(rackArray(starting));
  for (const r of results) history.addAuction(r.closedAt.microsSinceUnixEpoch, r.auctionId, r.letter, r.winnerBotId, r.paid);
  for (const w of plays) history.addWord(w.playedAt.microsSinceUnixEpoch, w.botId, w.word, w.totalReward);
  historyByMatch.set(key, history);
  // Auctions and plays interleave; replaying results first can only misplace
  // a played letter as hidden-rack, which leaves the counts unchanged.
  for (const r of results) intel.onAuctionResult(r);
  for (const w of plays) intel.onWordPlay(w);
  intel.logEvents = true;
  intelByMatch.set(key, intel);
  return intel;
}

// First sight of a running match this bot is in: reload params so tuning
// applies, build intel, and log the start.
function onMatchStart(conn: DbConnection, matchId: bigint) {
  if (myBotId === null) return;
  const key = String(matchId);
  if (startedMatches.has(key)) return;
  const m = conn.db.matchState.id.find(matchId);
  if (m?.status.tag !== "Running") return;
  startedMatches.add(key);
  loadParams();
  const intel = intelFor(conn, matchId);
  if (!intel) return;

  // Pick a strategy variant, learning from past finishes (data/bandit.json).
  const arm = pickArm(Object.keys(ARMS));
  if (arm) {
    Object.assign(PARAMS, ARMS[arm]);
    armByMatch.set(key, arm);
    console.log(`[${BOT_NAME}] match ${matchId}: strategy variant '${arm}'`);
  }

  // Pick a counter-strategy for these opponents (profiles from analyze.py).
  if (PARAMS.counters_enabled) {
    const profiles = loadOpponents();
    const opponents = Array.from(conn.db.matchParticipant.iter())
      .filter((p) => p.matchId === matchId && p.botId !== myBotId)
      .map((p) => String(p.botId));
    const { counter, because } = pickCounter(opponents.map((id) => profiles[id]));
    const overrides = applyCounter(counter);
    console.log(
      `[${BOT_NAME}] match ${matchId}: counter '${counter}'${because.length ? ` for ${because.join(", ")}` : ""}`,
    );
    logger.logCounter(matchId, { counter, because, opponents, overrides });
  }
  logger.logMatchStart(matchId, {
    myBotId,
    auctionType: m.auctionType.tag,
    startingRack: rackString(intel.myStartingRack),
    bagTotal: m.bagTotal,
    resumed: m.currentRound > 1,
    arm: arm ?? null,
    params: { ...PARAMS },
  });
}

function onMatchEnd(conn: DbConnection, matchId: bigint) {
  const scores = Array.from(conn.db.matchParticipant.iter()).filter(
    (p) => p.matchId === matchId,
  );
  const me = scores.find((p) => p.botId === myBotId);
  const rack = rackForMatch(conn, matchId);
  logger.logMatchEnd(matchId, {
    myScore: me ? Number(me.score) : null,
    myBalance: me ? Number(me.balance) : null,
    myRackLeft: rackString(rack),
    placement: me ? 1 + scores.filter((p) => p.score > me.score).length : null,
    players: scores.length,
  });
  const arm = armByMatch.get(String(matchId));
  if (arm && me) {
    recordResult(arm, 1 + scores.filter((p) => p.score > me.score).length, scores.length);
    armByMatch.delete(String(matchId));
  }
  const intel = intelByMatch.get(String(matchId));
  if (intel) logger.logIntelSnapshot(matchId, intel.snapshot());
  void flush();

  const m = conn.db.matchState.id.find(matchId);
  console.log(
    `[${BOT_NAME}] match ${matchId} final: balance ${me?.balance ?? "?"}, rack '${rackString(rack)}', inferred bag ${intel?.unseenTotal() ?? "?"} (actual ${m?.bagTotal ?? "?"})`,
  );
  intelByMatch.delete(String(matchId));
  historyByMatch.delete(String(matchId));
  startedMatches.delete(String(matchId));
  endedThisSession.add(String(matchId));
}

// A reducer call fails when the module refuses it, often for an expected
// reason: a word played just after its match ended, a bid that missed the
// auction's window. Log it and keep playing; an uncaught failure would stop
// the bot.
function logFailure(what: string) {
  return (err: unknown) =>
    console.warn(
      `[${BOT_NAME}] ${what} failed: ${err instanceof Error ? err.message : err}`,
    );
}

// Doppio's decision context for a match, or null when it isn't ready.
function doppioContext(conn: DbConnection, matchId: bigint, auctionId: bigint | null, letter: string) {
  if (myBotId === null) return null;
  const m = conn.db.matchState.id.find(matchId);
  const me = participantForMatch(conn, matchId);
  const history = historyByMatch.get(String(matchId));
  if (!m || !me || !history) return null;
  return buildContext({
    matchId,
    auctionId,
    letter,
    myBotId,
    myRack: rackForMatch(conn, matchId),
    myBalance: me.balance,
    myScore: me.score,
    bagTotal: m.bagTotal,
    startingRackSize: m.startingRackSize,
    auctionType: m.auctionType.tag,
    participants: Array.from(conn.db.matchParticipant.iter()).filter((p) => p.matchId === matchId),
    simulatedStrategy: (id) => {
      const b = conn.db.bot.id.find(id);
      return b?.isSimulated ? b.strategy.tag : undefined;
    },
    history,
  });
}

function tryBid(
  conn: DbConnection,
  auctionId: bigint,
  matchId: bigint,
  letter: string,
) {
  if (myBotId === null) return;
  const key = `${matchId}:${auctionId}`;
  if (bidsByAuction.has(key)) return;
  const participant = participantForMatch(conn, matchId);
  if (!participant) return;
  intelFor(conn, matchId); // also seeds the match history
  if (PARAMS.engine_doppio) {
    const ctx = doppioContext(conn, matchId, auctionId, letter);
    if (ctx) {
      const amount = doppio().decideBid(ctx);
      bidsByAuction.add(key);
      historyByMatch.get(String(matchId))?.myBids.set(String(auctionId), amount);
      if (amount <= 0) return;
      conn.reducers
        .submitBid({ auctionId, amount: BigInt(amount) })
        .catch(logFailure(`bid on auction ${auctionId}`));
      console.log(`[${BOT_NAME}] bid ${amount} on '${letter}' (match ${matchId}, auction ${auctionId}, doppio)`);
      return;
    }
  }
  const amount = decideBid({
    letter,
    myBalance: participant.balance,
    myRack: rackForMatch(conn, matchId),
    intel: intelFor(conn, matchId) ?? undefined,
    auctionType: conn.db.matchState.id.find(matchId)?.auctionType.tag,
    matchId,
    auctionId,
    bagRemaining: conn.db.matchState.id.find(matchId)?.bagTotal,
    scoreDiff: scoreDiff(conn, matchId),
  });
  if (amount <= 0) return;
  conn.reducers
    .submitBid({ auctionId, amount: BigInt(amount) })
    .catch(logFailure(`bid on auction ${auctionId}`));
  bidsByAuction.add(key);
  console.log(
    `[${BOT_NAME}] bid ${amount} on '${letter}' (match ${matchId}, auction ${auctionId})`,
  );
}

function tryPlayWord(conn: DbConnection) {
  if (myBotId === null) return;
  // Only matches still being played. The bot keeps its letters from
  // matches that have ended, but can't play them.
  const matches = new Set<bigint>();
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const m = conn.db.matchState.id.find(p.matchId);
    if (m?.status.tag === "Running") matches.add(p.matchId);
  }
  const now = Date.now();
  for (const matchId of matches) {
    const key = String(matchId);
    if (now - (lastWordAttemptByMatch.get(key) ?? 0) < WORD_RETRY_MS) continue;
    lastWordAttemptByMatch.set(key, now);
    let word: string | null;
    if (PARAMS.engine_doppio && historyByMatch.has(key)) {
      const m = conn.db.matchState.id.find(matchId);
      const a = m?.currentAuctionId !== undefined ? conn.db.auction.id.find(m.currentAuctionId) : undefined;
      const ctx = doppioContext(conn, matchId, a?.id ?? null, a?.letter ?? "");
      word = ctx ? doppio().chooseWord(ctx) : null;
      if (word) logger.logPlay(matchId, { word, score: 0 });
    } else word = chooseWord({
      myRack: rackForMatch(conn, matchId),
      dictionary: DICTIONARY,
      matchId,
      bagRemaining: conn.db.matchState.id.find(matchId)?.bagTotal,
      scoreDiff: scoreDiff(conn, matchId),
    });
    if (!word) continue;
    console.log(`[${BOT_NAME}] match ${matchId}: playing '${word}'`);
    conn.reducers
      .submitWord({ matchId, word })
      .catch(logFailure(`playing '${word}'`));
  }
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()}`);

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[${BOT_NAME}] subscription applied`);

      // Resolve our bot id, possibly after claiming a nonce.
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE) {
          console.log(`[${BOT_NAME}] claiming credential with nonce…`);
          conn.reducers
            .claimCredential({ code: BOT_NONCE })
            .catch(logFailure("claiming the credential"));
          // Wait briefly for the credential to land; check again.
          setTimeout(() => {
            myBotId = resolveMyBotId(conn);
            if (myBotId === null) {
              console.error(
                `[${BOT_NAME}] couldn't claim credential. Bad / expired nonce?`,
              );
              process.exit(1);
            }
            const bot = conn.db.bot.id.find(myBotId);
            console.log(
              `[${BOT_NAME}] claimed credential for bot '${bot?.name ?? "?"}' (id ${myBotId})`,
            );
            bootstrapActivity(conn);
          }, 1000);
          return;
        } else {
          console.error(
            `[${BOT_NAME}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`,
          );
          process.exit(1);
        }
      }

      const bot = conn.db.bot.id.find(myBotId);
      console.log(
        `[${BOT_NAME}] acting as bot '${bot?.name ?? "?"}' (id ${myBotId})`,
      );
      bootstrapActivity(conn);
    })
    .subscribeToAllTables();

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag !== "Open") return;
    tryBid(conn, a.id, a.matchId, a.letter);
    // Re-check words every auction, not just when our rack changes: the bag
    // shrinking alone can make the endgame rule play a held rack. Without
    // this the bot often ended matches holding 6-11 tiles.
    if (myMatchIds.has(String(a.matchId))) tryPlayWord(conn);
  });
  conn.db.matchParticipant.onInsert((_ctx, p) => {
    if (p.botId !== myBotId) return;
    myMatchIds.add(String(p.matchId));
    onMatchStart(conn, p.matchId);
  });
  conn.db.auctionTopBidArchive.onInsert((_ctx, a) => {
    const key = String(a.matchId);
    if (intelByMatch.has(key) || endedThisSession.has(key)) {
      logger.logTopBid(a.matchId, { auctionId: a.auctionId, topBid: Number(a.topBid) });
    }
  });
  conn.db.myRack.onInsert(() => tryPlayWord(conn));
  conn.db.myRack.onUpdate(() => tryPlayWord(conn));
  conn.db.botCredential.onInsert(() => {
    if (myBotId === null) myBotId = resolveMyBotId(conn);
    for (const intel of intelByMatch.values()) intel.myBotId = myBotId;
  });
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (myBotId === null || !inMyRunningMatch(conn, r.matchId)) return;
    const existed = intelByMatch.has(String(r.matchId));
    const intel = intelFor(conn, r.matchId);
    if (intel && existed) {
      intel.onAuctionResult(r);
      historyByMatch.get(String(r.matchId))?.addAuction(r.closedAt.microsSinceUnixEpoch, r.auctionId, r.letter, r.winnerBotId, r.paid);
    }
    const winner =
      r.winnerBotId !== undefined && r.winnerBotId !== null
        ? String(r.winnerBotId)
        : "no-bid";
    console.log(
      `[${BOT_NAME}] match ${r.matchId} auction ${r.auctionId} '${r.letter}' → bot ${winner} paid ${r.paid}`,
    );
  });

  conn.db.wordPlay.onInsert((_ctx, w) => {
    if (myBotId === null || !inMyRunningMatch(conn, w.matchId)) return;
    const existed = intelByMatch.has(String(w.matchId));
    const intel = intelFor(conn, w.matchId);
    if (intel && existed) {
      intel.onWordPlay(w);
      historyByMatch.get(String(w.matchId))?.addWord(w.playedAt.microsSinceUnixEpoch, w.botId, w.word, w.totalReward);
    }
  });

  // When a match this bot was in ends, hop back into the lobby.
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const wasIn = Array.from(conn.db.matchParticipant.iter()).some(
        (p) => p.matchId === neu.id && p.botId === myBotId,
      );
      if (wasIn) {
        onMatchEnd(conn, neu.id);
        console.log(`[${BOT_NAME}] match ${neu.id} ended; rejoining lobby`);
        joinLobby(conn);
      }
    }
  });
}

function joinLobby(conn: DbConnection) {
  if (myBotId === null) return;
  const inRunning = Array.from(conn.db.matchParticipant.iter()).some((p) => {
    if (p.botId !== myBotId) return false;
    const m = conn.db.matchState.id.find(p.matchId);
    return m?.status.tag === "Running";
  });
  if (inRunning) return;
  const openLobby = Array.from(conn.db.lobby.iter()).find(
    (l) => l.status.tag === "Open",
  );
  const alreadyIn =
    openLobby !== undefined &&
    Array.from(conn.db.lobbyMember.iter()).some(
      (lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId,
    );
  if (alreadyIn) return;
  console.log(`[${BOT_NAME}] joining lobby`);
  conn.reducers.joinLobby({}).catch(logFailure("joining the lobby"));
}

function bootstrapActivity(conn: DbConnection) {
  if (TOURNAMENT_ID) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() =>
        console.log(`[${BOT_NAME}] registered for tournament ${TOURNAMENT_ID}`),
      )
      .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
  }
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId === myBotId) myMatchIds.add(String(p.matchId));
  }
  joinLobby(conn);
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId === myBotId) onMatchStart(conn, p.matchId);
  }
  for (const a of conn.db.auction.iter()) {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  }
  tryPlayWord(conn);
}

function main() {
  loadParams();
  enableLogging();
  const t0 = performance.now();
  initSimulator(DICTIONARY);
  doppio(); // index the wordlist now, not on the first bid
  console.log(
    `[${BOT_NAME}] simulator ready in ${Math.round(performance.now() - t0)} ms`,
  );
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) =>
      console.error("connect error:", err.message),
    )
    .onDisconnect(() => console.log("disconnected"))
    .build();
}

main();
