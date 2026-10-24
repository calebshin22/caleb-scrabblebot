#!/usr/bin/env python3
"""Scrape ScrabbleBot match data into data/matches.db (SQLite).

The leaderboard site is a SpacetimeDB client for the `scrabblebot` database
on maincloud, so this reads the same public tables over SpacetimeDB's SQL
HTTP API instead of scraping HTML.

  python3 scrape.py --once     one pass over every table, then exit
  python3 scrape.py            a pass every --interval seconds, forever

Polite by construction: at most one request per 30 s, tracked across runs in
data/.last_request, and incremental queries (only rows newer than what we
already have), deduped by primary key. Standard library only.
"""

import argparse
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request

HOST = os.environ.get("STDB_HOST", "https://maincloud.spacetimedb.com")
DB_NAME = os.environ.get("STDB_DB", "scrabblebot")
ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
DB_PATH = os.path.join(DATA, "matches.db")
ENV_PATH = os.path.join(ROOT, ".env")
LAST_REQUEST_PATH = os.path.join(DATA, ".last_request")
MIN_REQUEST_GAP_S = 30.0

# Leaderboard rating, as the site computes it (see DISCOVERY.md).
RATING_SCALE = 400 / (25 / 6 * 2.302585092994046 * 1.4142135623730951)
PROVISIONAL_SPREAD = 175

SCHEMA = """
CREATE TABLE IF NOT EXISTS teams (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY, name TEXT, team_id INTEGER, is_simulated INTEGER,
  strategy TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS bot_stats (
  bot_id INTEGER PRIMARY KEY, rating INTEGER, matches_played INTEGER,
  wins INTEGER, total_score INTEGER, last_played INTEGER, mu REAL, sigma REAL);
CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  scraped_at INTEGER, bot_id INTEGER, rank INTEGER, display_rating INTEGER,
  spread INTEGER, provisional INTEGER, matches_played INTEGER, wins INTEGER,
  PRIMARY KEY (scraped_at, bot_id));
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY, status TEXT, auction_type TEXT, bag_total INTEGER,
  starting_rack_size INTEGER, created_at INTEGER, started_at INTEGER,
  ended_at INTEGER);
CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY, match_id INTEGER, bot_id INTEGER, balance INTEGER,
  score INTEGER);
CREATE INDEX IF NOT EXISTS participants_by_match ON participants(match_id);
CREATE INDEX IF NOT EXISTS participants_by_bot ON participants(bot_id);
CREATE TABLE IF NOT EXISTS auction_results (
  auction_id INTEGER PRIMARY KEY, match_id INTEGER, letter TEXT,
  winner_bot_id INTEGER, paid INTEGER, closed_at INTEGER);
CREATE INDEX IF NOT EXISTS auctions_by_match ON auction_results(match_id);
CREATE TABLE IF NOT EXISTS top_bids (
  auction_id INTEGER PRIMARY KEY, match_id INTEGER, top_bid INTEGER);
CREATE TABLE IF NOT EXISTS word_plays (
  id INTEGER PRIMARY KEY, match_id INTEGER, bot_id INTEGER, word TEXT,
  base_score INTEGER, bonus INTEGER, total_reward INTEGER, played_at INTEGER);
CREATE INDEX IF NOT EXISTS plays_by_match ON word_plays(match_id);
CREATE TABLE IF NOT EXISTS rating_history (
  id INTEGER PRIMARY KEY, bot_id INTEGER, match_id INTEGER, at INTEGER,
  mu REAL, sigma REAL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


def log(msg):
    print(f"[scrape {time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------- auth ----------

def read_env():
    env = {}
    if os.path.exists(ENV_PATH):
        for line in open(ENV_PATH):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


def read_token():
    """Anonymous read-only identity, minted once and kept in .env."""
    token = os.environ.get("STDB_READ_TOKEN") or read_env().get("STDB_READ_TOKEN")
    if token:
        return token
    throttle()
    req = urllib.request.Request(f"{HOST}/v1/identity", method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        token = json.load(resp)["token"]
    with open(ENV_PATH, "a") as f:
        f.write("# Anonymous read-only identity for scrape.py (not the bot token)\n")
        f.write(f"STDB_READ_TOKEN={token}\n")
    os.chmod(ENV_PATH, 0o600)
    log("minted a read-only identity into .env")
    return token


# ---------- rate-limited SQL ----------

def throttle():
    os.makedirs(DATA, exist_ok=True)
    try:
        last = float(open(LAST_REQUEST_PATH).read().strip())
    except (OSError, ValueError):
        last = 0.0
    wait = last + MIN_REQUEST_GAP_S - time.time()
    if wait > 0:
        time.sleep(wait)
    with open(LAST_REQUEST_PATH, "w") as f:
        f.write(str(time.time()))


def sql(token, query):
    """Run one SQL statement; return a list of dicts keyed by column name."""
    for attempt in range(3):
        throttle()
        req = urllib.request.Request(
            f"{HOST}/v1/database/{DB_NAME}/sql",
            data=query.encode(),
            method="POST",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "text/plain"},
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                result = json.load(resp)
            break
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:300]
            if e.code < 500:
                raise RuntimeError(f"SQL {e.code} for {query!r}: {body}")
            log(f"server error {e.code}, retrying ({attempt + 1}/3)")
        except (urllib.error.URLError, TimeoutError) as e:
            log(f"network error {e}, retrying ({attempt + 1}/3)")
    else:
        raise RuntimeError(f"giving up on {query!r}")
    table = result[0]
    names = [el["name"]["some"] for el in table["schema"]["elements"]]
    return [dict(zip(names, row)) for row in table["rows"]]


# SpacetimeDB JSON encodings.
def opt(v):
    """Option<T>: [0, value] is Some, [1, []] is None."""
    if isinstance(v, list) and len(v) == 2 and v[0] in (0, 1):
        return unwrap(v[1]) if v[0] == 0 else None
    return v


def unwrap(v):
    """Timestamps are [micros]; unit-variant enums are [tag, []]."""
    if isinstance(v, list) and len(v) == 1 and isinstance(v[0], int):
        return v[0]
    return v


def enum_tag(v, names):
    return names[v[0]] if isinstance(v, list) and v and isinstance(v[0], int) else str(v)


MATCH_STATUS = ["Lobby", "Running", "Ended"]
AUCTION_TYPE = ["FirstPrice", "Vickrey"]
BOT_STRATEGY = ["Human", "Cheapskate", "ValueBidder", "Aggressive"]


# ---------- passes ----------

def connect():
    os.makedirs(DATA, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.executescript(SCHEMA)
    return db


def max_id(db, table, col):
    return db.execute(f"SELECT COALESCE(MAX({col}), 0) FROM {table}").fetchone()[0]


def scrape_once(db, token):
    now = int(time.time())
    counts = {}

    rows = sql(token, "SELECT * FROM team")
    db.executemany("INSERT OR REPLACE INTO teams VALUES (?, ?)",
                   [(r["id"], r["name"]) for r in rows])
    counts["teams"] = len(rows)

    rows = sql(token, "SELECT * FROM bot")
    db.executemany(
        "INSERT OR REPLACE INTO bots VALUES (?, ?, ?, ?, ?, ?)",
        [(r["id"], r["name"], r["team_id"], int(bool(r["is_simulated"])),
          enum_tag(r["strategy"], BOT_STRATEGY), unwrap(r["created_at"])) for r in rows])
    counts["bots"] = len(rows)

    rows = sql(token, "SELECT * FROM bot_stats")
    db.executemany(
        "INSERT OR REPLACE INTO bot_stats VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [(r["bot_id"], r["rating"], r["matches_played"], r["wins"], r["total_score"],
          opt(r["last_played"]), r["openskill_mu"], r["openskill_sigma"]) for r in rows])
    counts["bot_stats"] = len(rows)
    snapshot_leaderboard(db, rows, now)

    # Matches and participants change while running, so re-read from the
    # oldest match we haven't seen end.
    since = db.execute(
        "SELECT COALESCE(MIN(id), (SELECT COALESCE(MAX(id), 0) + 1 FROM matches)) "
        "FROM matches WHERE status != 'Ended'").fetchone()[0]
    rows = sql(token, f"SELECT * FROM match_state WHERE id >= {since}")
    db.executemany(
        "INSERT OR REPLACE INTO matches VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [(r["id"], enum_tag(r["status"], MATCH_STATUS), enum_tag(r["auction_type"], AUCTION_TYPE),
          r["bag_total"], r["starting_rack_size"], unwrap(r["created_at"]),
          opt(r["started_at"]), opt(r["ended_at"])) for r in rows])
    counts["matches"] = len(rows)

    rows = sql(token, f"SELECT * FROM match_participant WHERE match_id >= {since}")
    db.executemany(
        "INSERT OR REPLACE INTO participants VALUES (?, ?, ?, ?, ?)",
        [(r["id"], r["match_id"], r["bot_id"], r["balance"], r["score"]) for r in rows])
    counts["participants"] = len(rows)

    for table, col, query, insert, fn in [
        ("auction_results", "auction_id", "SELECT * FROM auction_result WHERE auction_id > {}",
         "INSERT OR IGNORE INTO auction_results VALUES (?, ?, ?, ?, ?, ?)",
         lambda r: (r["auction_id"], r["match_id"], r["letter"], opt(r["winner_bot_id"]),
                    r["paid"], unwrap(r["closed_at"]))),
        ("word_plays", "id", "SELECT * FROM word_play WHERE id > {}",
         "INSERT OR IGNORE INTO word_plays VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
         lambda r: (r["id"], r["match_id"], r["bot_id"], r["word"], r["base_score"],
                    r["bonus"], r["total_reward"], unwrap(r["played_at"]))),
        ("top_bids", "auction_id", "SELECT * FROM auction_top_bid_archive WHERE auction_id > {}",
         "INSERT OR IGNORE INTO top_bids VALUES (?, ?, ?)",
         lambda r: (r["auction_id"], r["match_id"], r["top_bid"])),
        ("rating_history", "id", "SELECT * FROM rating_history WHERE id > {}",
         "INSERT OR IGNORE INTO rating_history VALUES (?, ?, ?, ?, ?, ?)",
         lambda r: (r["id"], r["bot_id"], r["match_id"], unwrap(r["at"]),
                    r["openskill_mu"], r["openskill_sigma"])),
    ]:
        rows = sql(token, query.format(max_id(db, table, col)))
        db.executemany(insert, [fn(r) for r in rows])
        counts[table] = len(rows)
        db.commit()

    db.execute("INSERT OR REPLACE INTO meta VALUES ('last_scrape', ?)", (str(now),))
    db.commit()
    log("fetched " + ", ".join(f"{k} {v}" for k, v in counts.items()))


def snapshot_leaderboard(db, stats, now):
    """Rank like the site: by display rating, provisional bots unranked."""
    known = {r[0] for r in db.execute("SELECT id FROM bots")}
    entries = []
    for r in stats:
        if r["bot_id"] not in known:
            continue
        rating = round(1500 + RATING_SCALE * (r["openskill_mu"] - 25))
        spread = round(RATING_SCALE * r["openskill_sigma"])
        entries.append((r, rating, spread, spread > PROVISIONAL_SPREAD))
    ranked = sorted((e for e in entries if not e[3]), key=lambda e: -e[1])
    rank_of, prev, rank = {}, None, 0
    for i, e in enumerate(ranked):
        if e[1] != prev:
            rank, prev = i + 1, e[1]
        rank_of[e[0]["bot_id"]] = rank
    db.executemany(
        "INSERT OR REPLACE INTO leaderboard_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [(now, r["bot_id"], rank_of.get(r["bot_id"]), rating, spread, int(prov),
          r["matches_played"], r["wins"]) for r, rating, spread, prov in entries])


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--once", action="store_true", help="one pass, then exit")
    ap.add_argument("--interval", type=int, default=1800,
                    help="seconds between passes without --once (default 1800)")
    args = ap.parse_args()
    db = connect()
    token = read_token()
    while True:
        try:
            scrape_once(db, token)
        except Exception as e:  # keep the loop alive; report and retry next pass
            log(f"pass failed: {e}")
            if args.once:
                sys.exit(1)
        if args.once:
            return
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
