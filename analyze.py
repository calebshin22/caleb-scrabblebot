#!/usr/bin/env python3
"""Analyse data/matches.db (from scrape.py) plus the bot's own log
(data/matches.jsonl) into data/report.md and data/opponents.json.

  python3 analyze.py

Our bot is taken from $OUR_BOT_ID, else ourbot.json.
"""

import collections
import json
import statistics
import os
import sqlite3
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
DB_PATH = os.path.join(DATA, "matches.db")
LOG_PATH = os.path.join(DATA, "matches.jsonl")
REPORT_PATH = os.path.join(DATA, "report.md")
OPPONENTS_PATH = os.path.join(DATA, "opponents.json")
MARKET_PATH = os.path.join(DATA, "market.json")

LETTER_VALUE = dict(zip("ABCDEFGHIJKLMNOPQRSTUVWXYZ",
                        [1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10]))
VOWELS = set("AEIOU")
POWER = "QJXZ"
BINGO_LEN = 7  # 7+ letters pays the top 3x multiplier
MIN_MATCHES_FOR_PROFILE = 3


def our_bot_id():
    if os.environ.get("OUR_BOT_ID"):
        return int(os.environ["OUR_BOT_ID"])
    with open(os.path.join(ROOT, "ourbot.json")) as f:
        return int(json.load(f)["bot_id"])


def mean(xs, default=0.0):
    xs = list(xs)
    return sum(xs) / len(xs) if xs else default


def pct(x):
    return f"{100 * x:.1f}%"


# ---------- loading ----------

class Match:
    __slots__ = ("id", "auction_type", "rack_size", "ended_at", "parts", "auctions", "plays", "top_bids")

    def __init__(self, row):
        self.id, self.auction_type, self.rack_size, self.ended_at = row
        self.parts = {}      # bot_id -> (balance, score)
        self.auctions = []   # (auction_id, letter, winner, paid, closed_at), in order
        self.plays = []      # (id, bot_id, word, reward, played_at), in order
        self.top_bids = {}   # auction_id -> top bid

    def placement(self, bot):
        score = self.parts[bot][1]
        return 1 + sum(1 for b, (_, s) in self.parts.items() if b != bot and s > score)

    def won(self, bot):
        return self.placement(bot) == 1  # ties for first share the win, as on the server


def load(db):
    matches = {}
    for row in db.execute(
            "SELECT id, auction_type, starting_rack_size, ended_at FROM matches "
            "WHERE status = 'Ended' ORDER BY id"):
        matches[row[0]] = Match(row)
    for m_id, bot, bal, score in db.execute(
            "SELECT match_id, bot_id, balance, score FROM participants"):
        if m_id in matches:
            matches[m_id].parts[bot] = (bal, score)
    for a_id, m_id, letter, winner, paid, at in db.execute(
            "SELECT auction_id, match_id, letter, winner_bot_id, paid, closed_at FROM auction_results ORDER BY auction_id"):
        if m_id in matches:
            matches[m_id].auctions.append((a_id, letter, winner, paid, at))
    for p_id, m_id, bot, word, reward, at in db.execute(
            "SELECT id, match_id, bot_id, word, total_reward, played_at FROM word_plays ORDER BY id"):
        if m_id in matches:
            matches[m_id].plays.append((p_id, bot, word, reward, at))
    for a_id, m_id, top in db.execute("SELECT auction_id, match_id, top_bid FROM top_bids"):
        if m_id in matches:
            matches[m_id].top_bids[a_id] = top
    bots = {r[0]: {"name": r[1], "team_id": r[2], "simulated": bool(r[3]), "strategy": r[4]}
            for r in db.execute("SELECT id, name, team_id, is_simulated, strategy FROM bots")}
    return [m for m in matches.values() if m.parts], bots


def load_log():
    events = []
    if os.path.exists(LOG_PATH):
        for line in open(LOG_PATH):
            try:
                events.append(json.loads(line))
            except ValueError:
                pass
    return events


# ---------- per-bot match stats ----------

def bot_match_stats(m, bot):
    """What `bot` did in match `m`, from public data."""
    won_letters = [l for (_, l, w, _, _) in m.auctions if w == bot]
    paid = [p for (_, _, w, p, _) in m.auctions if w == bot]
    words = [(w, r) for (_, b, w, r, _) in m.plays if b == bot]
    letters_played = sum(len(w) for w, _ in words)
    played_counts = collections.Counter("".join(w for w, _ in words))
    won_counts = collections.Counter(won_letters)
    balance, score = m.parts[bot]
    return {
        "score": score,
        "balance": balance,
        "tiles_won": len(won_letters),
        "spent": sum(paid),
        "paid_over_face": mean(p / LETTER_VALUE.get(l, 1) for l, p in zip(won_letters, paid)),
        "words": words,
        "avg_word_len": mean(len(w) for w, _ in words),
        "bingos": sum(1 for w, _ in words if len(w) >= BINGO_LEN),
        # Starting rack + wins - letters played; exact even though racks are hidden.
        "tiles_left": max(0, (m.rack_size or 0) + len(won_letters) - letters_played),
        "won_counts": won_counts,
        "played_counts": played_counts,
        "first_word": words[0][0] if words else None,
    }


def leak(m, us):
    """Defensive leak: for each tile an opponent won, the points of their
    next word that used it, credited by the tile's share of the word's face
    value. The auction game's version of "points the opponent scores right
    after our move"."""
    per_auction = []
    letters = collections.Counter()
    plays_by_bot = collections.defaultdict(list)
    for _, bot, word, reward, at in m.plays:
        plays_by_bot[bot].append((at, word, reward))
    for _, letter, winner, _, closed in m.auctions:
        if winner is None or winner == us:
            continue
        pts = 0.0
        for at, word, reward in plays_by_bot.get(winner, []):
            # Their first word after this auction that uses the letter.
            if at >= closed and letter in word:
                base = sum(LETTER_VALUE.get(c, 0) for c in word) or 1
                pts = reward * LETTER_VALUE.get(letter, 0) / base
                break
        per_auction.append(pts)
        letters[letter] += pts
    return per_auction, letters


# ---------- report ----------

def loss_causes(our_losses):
    """Compare each loss with the match winner and name the biggest gap."""
    causes = collections.Counter()
    gaps = collections.defaultdict(list)
    for m, us in our_losses:
        winner = max(m.parts, key=lambda b: m.parts[b][1])
        a, b = bot_match_stats(m, us), bot_match_stats(m, winner)
        candidates = {
            "won too few tiles (outbid)": (b["tiles_won"] - a["tiles_won"]) / max(1, b["tiles_won"]),
            "overpaid per tile": (a["paid_over_face"] - b["paid_over_face"]) / max(0.5, b["paid_over_face"]),
            "short words (low length multiplier)": (b["avg_word_len"] - a["avg_word_len"]) / max(1, b["avg_word_len"]),
            "tiles left unplayed": (a["tiles_left"] - b["tiles_left"]) / max(3, a["tiles_left"] + b["tiles_left"]),
            "money left unspent": (a["balance"] - a["score"] - (b["balance"] - b["score"])) / 100,
        }
        cause, size = max(candidates.items(), key=lambda kv: kv[1])
        causes[cause if size > 0 else "close loss / variance"] += 1
        for k, v in candidates.items():
            gaps[k].append(v)
    return causes, {k: mean(v) for k, v in gaps.items()}


def counter_outcomes(events, matches_by_id, us):
    """Win rate per counter-strategy the bot logged at match start."""
    used = {}
    for e in events:
        if e.get("type") == "counter_strategy" and e.get("matchId"):
            used[int(e["matchId"])] = e.get("counter", "none")
    stats = collections.defaultdict(lambda: [0, 0, []])
    for m_id, counter in used.items():
        m = matches_by_id.get(m_id)
        if not m or us not in m.parts:
            continue
        s = stats[counter]
        s[0] += 1
        s[1] += int(m.won(us))
        s[2].append(m.parts[us][1])
    return stats


def market_stats(matches):
    """Per-letter price stats across the whole field, for profiles and for
    calibrating the arena's opponents."""
    paid, top = collections.defaultdict(list), collections.defaultdict(list)
    for m in matches:
        for a_id, letter, winner, p, _ in m.auctions:
            if winner is None:
                continue
            paid[letter].append(p)
            if a_id in m.top_bids:
                top[letter].append(m.top_bids[a_id])
    out = {}
    for L in LETTER_VALUE:
        tp, pd = top.get(L, []), paid.get(L, [])
        if not pd:
            continue
        out[L] = {
            "n": len(pd),
            "avg_paid": round(mean(pd), 2),
            "sd_paid": round(statistics.pstdev(pd), 2),
            "avg_top": round(mean(tp, mean(pd)), 2),
            "sd_top": round(statistics.pstdev(tp), 2) if len(tp) > 1 else 0.0,
        }
    return out


def quantile(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else 0.0


def build_profiles(matches, bots, us, market):
    by_bot = collections.defaultdict(list)
    for m in matches:
        for b in m.parts:
            by_bot[b].append(m)
    profiles = {}
    for b, ms in by_bot.items():
        if b == us or len(ms) < MIN_MATCHES_FOR_PROFILE:
            continue
        info = bots.get(b, {})
        stats = [bot_match_stats(m, b) for m in ms]
        words = [w for s in stats for w in s["words"]]
        shared = [m for m in ms if us in m.parts]
        vowel_prem = mean(p / LETTER_VALUE[l] for m in ms for (_, l, w, p, _) in m.auctions if w == b and l in VOWELS)
        cons_prem = mean(p / LETTER_VALUE[l] for m in ms for (_, l, w, p, _) in m.auctions if w == b and l not in VOWELS)
        auctions_total = sum(len(m.auctions) for m in ms)
        win_share = sum(s["tiles_won"] for s in stats) / max(1, auctions_total)
        avg_len = mean(len(w) for w, _ in words)
        bingo_rate = mean(1.0 if len(w) >= BINGO_LEN else 0.0 for w, _ in words)
        style = "hoarder" if avg_len >= 6 else "greedy" if avg_len <= 4 else "balanced"
        # Their winning bids relative to the market's average top bid for
        # the same letter: 1.0 is typical, above 1 pays up.
        aggression = mean(
            m.top_bids[a_id] / market[l]["avg_top"]
            for m in ms for (a_id, l, w, _, _) in m.auctions
            if w == b and a_id in m.top_bids and market.get(l, {}).get("avg_top"))
        tl = mean(s["tiles_left"] for s in stats)
        openings = collections.Counter(s["first_word"] for s in stats if s["first_word"])
        profiles[str(b)] = {
            "name": info.get("name"),
            "simulated": info.get("simulated", False),
            "sim_strategy": info.get("strategy") if info.get("simulated") else None,
            "matches": len(ms),
            "winrate": round(mean(1.0 if m.won(b) else 0.0 for m in ms), 3),
            "matches_vs_us": len(shared),
            "winrate_vs_us": round(mean(1.0 if m.parts[b][1] > m.parts[us][1] else 0.0 for m in shared), 3) if shared else None,
            "avg_score": round(mean(s["score"] for s in stats), 1),
            "bingo_rate": round(bingo_rate, 3),
            "avg_reply_score": round(mean(r for _, r in words), 2),
            "avg_word_len": round(avg_len, 2),
            "auction_win_share": round(win_share, 3),
            "aggression": round(aggression, 2),
            "vowel_premium": round(vowel_prem / max(cons_prem, 1e-9), 2),
            "tiles_left": round(tl, 2),
            "style": style,
            "common_openings": [w for w, _ in openings.most_common(3)],
        }
    classify(profiles)
    return profiles


def classify(profiles):
    """Weaknesses and a counter-strategy, relative to the field (real bots
    with enough matches), since absolute thresholds drift with the meta."""
    field = [p for p in profiles.values() if not p["simulated"] and p["matches"] >= 10] or list(profiles.values())
    q = lambda k, f: quantile([p[k] for p in field], f)
    agg_hi, agg_lo = q("aggression", 0.75), q("aggression", 0.25)
    bingo_hi, len_lo = q("bingo_rate", 0.75), q("avg_word_len", 0.25)
    left_hi, share_lo = q("tiles_left", 0.75), q("auction_win_share", 0.25)
    for p in profiles.values():
        w = []
        if p["aggression"] >= agg_hi:
            w.append("pays above market (%.2fx typical top bid)" % p["aggression"])
        if p["vowel_premium"] > 1.3:
            w.append("overpays for vowels relative to consonants")
        if p["tiles_left"] >= left_hi:
            w.append("ends with %.1f tiles unplayed" % p["tiles_left"])
        if p["avg_word_len"] <= len_lo:
            w.append("short words (avg %.1f), misses the long-word multipliers" % p["avg_word_len"])
        if p["auction_win_share"] <= share_lo:
            w.append("wins few auctions (%.0f%%)" % (100 * p["auction_win_share"]))
        p["weaknesses"] = w
        if p["bingo_rate"] >= bingo_hi:
            p["counter"] = "deny_hoarder"
        elif p["aggression"] >= agg_hi:
            p["counter"] = "price_set_aggressive"
        elif p["aggression"] <= agg_lo:
            p["counter"] = "outbid_cheap"
        else:
            p["counter"] = "default"


def main():
    if not os.path.exists(DB_PATH):
        sys.exit("No data/matches.db yet. Run: python3 scrape.py --once")
    us = our_bot_id()
    db = sqlite3.connect(DB_PATH)
    matches, bots = load(db)
    events = load_log()
    ours = [m for m in matches if us in m.parts]
    by_id = {m.id: m for m in matches}
    name = bots.get(us, {}).get("name", "?")
    out = [f"# ScrabbleBot report: {name} (bot {us})",
           f"_Generated {time.strftime('%Y-%m-%d %H:%M')} from {len(matches)} finished matches "
           f"({len(ours)} with us)._", ""]

    snap = db.execute(
        "SELECT rank, display_rating, spread, provisional, matches_played, wins FROM leaderboard_snapshots "
        "WHERE bot_id = ? ORDER BY scraped_at DESC LIMIT 1", (us,)).fetchone()
    ranked = db.execute(
        "SELECT COUNT(*) FROM leaderboard_snapshots WHERE scraped_at = (SELECT MAX(scraped_at) FROM leaderboard_snapshots) "
        "AND rank IS NOT NULL").fetchone()[0]
    out.append("## Leaderboard")
    if snap:
        rank, rating, spread, prov, mp, wins = snap
        where = f"#{rank} of {ranked}" if rank else f"provisional (±{spread} > 175, unranked)"
        out.append(f"- Rank: **{where}**, rating {rating} ±{spread}")
        out.append(f"- Server stats: {wins} wins / {mp} rated matches")
    # The site's "Avg score" column: total_score / matches_played (points, not %).
    rows = db.execute("SELECT b.name, s.total_score * 1.0 / s.matches_played FROM bot_stats s JOIN bots b ON b.id = s.bot_id "
                      "WHERE s.matches_played >= 20 ORDER BY 2 DESC LIMIT 1").fetchone()
    mine = db.execute("SELECT total_score * 1.0 / matches_played FROM bot_stats WHERE bot_id = ? AND matches_played > 0", (us,)).fetchone()
    if rows:
        out.append(f"- **Avg score (leaderboard metric): {mine[0] if mine else 0:.1f}** vs leader {rows[0]} {rows[1]:.1f} "
                   f"(gap {rows[1] - (mine[0] if mine else 0):.1f})")
    else:
        out.append("- Not on the leaderboard yet.")
    out.append("")

    if not ours:
        out.append("No finished matches with our bot yet; run the bot (`./run.sh` or `./loop.sh`).")
    else:
        stats = [bot_match_stats(m, us) for m in ours]
        words = [w for s in stats for w in s["words"]]
        wins = sum(1 for m in ours if m.won(us))
        placements = [m.placement(us) for m in ours]
        out.append("## Results")
        out.append(f"- Matches: {len(ours)}, wins {wins}, **winrate {pct(wins / len(ours))}**, "
                   f"avg placement {mean(placements):.2f} of {mean(len(m.parts) for m in ours):.1f}")
        out.append(f"- Avg score {mean(s['score'] for s in stats):.1f} vs winner's "
                   f"{mean(max(sc for _, sc in m.parts.values()) for m in ours):.1f}")
        out.append(f"- Points per word {mean(r for _, r in words):.2f}; per auction "
                   f"{mean(s['score'] / max(1, len(m.auctions)) for s, m in zip(stats, ours)):.2f}")
        out.append(f"- Bingo % (7+ letters, 3x): {pct(mean(1.0 if len(w) >= BINGO_LEN else 0.0 for w, _ in words))} "
                   f"of {len(words)} words; avg word length {mean(len(w) for w, _ in words):.2f}")
        conv = []
        for L in POWER:
            won = sum(s["won_counts"][L] for s in stats)
            played = sum(min(s["won_counts"][L], s["played_counts"][L]) for s in stats)
            conv.append(f"{L} {played}/{won}" + (f" ({pct(played / won)})" if won else ""))
        out.append(f"- Q/J/X/Z conversion (won -> played): {', '.join(conv)}. Blanks: N/A (no blanks in this game)")
        out.append(f"- Rack leave: {mean(s['tiles_left'] for s in stats):.1f} tiles unplayed at match end; "
                   f"{mean(s['balance'] - s['score'] for s in stats):.1f} money unspent")
        out.append(f"- Tiles won per match {mean(s['tiles_won'] for s in stats):.1f}, "
                   f"avg paid {mean(s['paid_over_face'] for s in stats if s['tiles_won']):.2f}x face value")
        out.append("")

        losses = [(m, us) for m in ours if not m.won(us)]
        out.append("## Biggest loss causes")
        if losses:
            causes, gaps = loss_causes(losses)
            for cause, n in causes.most_common():
                out.append(f"- {cause}: {n} of {len(losses)} losses")
            out.append("")
            out.append("Average gap to the winner in losses (positive = we're worse):")
            for k, v in sorted(gaps.items(), key=lambda kv: -kv[1]):
                out.append(f"- {k}: {v:+.2f}")
        else:
            out.append("- No losses yet.")
        out.append("")

        out.append("## Defensive leak")
        per, letters = [], collections.Counter()
        for m in ours:
            p, l = leak(m, us)
            per += p
            letters.update(l)
        out.append(f"- Avg points an opponent scored with a tile they won: **{mean(per):.2f}** "
                   f"over {len(per)} tiles ({sum(per):.0f} total)")
        out.append("- Most-leaked letters: " + ", ".join(f"{l} {v:.0f}" for l, v in letters.most_common(6)))
        out.append("")

        bids = [e for e in events if e.get("type") == "my_bid"]
        if bids:
            out.append("## Our bidding (from data/matches.jsonl)")
            out.append(f"- {len(bids)} bids logged; simulator used for "
                       f"{pct(mean(1.0 if e.get('breakdown', {}).get('source') == 'sim' else 0.0 for e in bids))}")
            adj = collections.Counter(a for e in bids for a in e.get("breakdown", {}).get("adjustments", []))
            if adj:
                out.append("- Adjustments: " + ", ".join(f"{k} {v}" for k, v in adj.most_common()))
            out.append("")

        stats_c = counter_outcomes(events, by_id, us)
        if stats_c:
            out.append("## Counter-strategies")
            for counter, (n, w, scores) in sorted(stats_c.items()):
                out.append(f"- {counter}: {n} matches, winrate {pct(w / n)}, avg score {mean(scores):.1f}")
            out.append("")

    market = market_stats(matches)
    with open(MARKET_PATH, "w") as f:
        json.dump({"generated_at": int(time.time()), "matches": len(matches),
                   "players_per_match": round(mean(len(m.parts) for m in matches), 2),
                   "letters": market}, f, indent=2)
    profiles = build_profiles(matches, bots, us, market)
    with open(OPPONENTS_PATH, "w") as f:
        json.dump({"generated_at": int(time.time()), "our_bot_id": us, "bots": profiles}, f, indent=2)
    vs = sorted((p for p in profiles.values() if p["matches_vs_us"]), key=lambda p: -p["matches_vs_us"])
    out.append("## Opponents we've faced")
    if vs:
        out.append("| bot | matches vs us | beats us | style | aggression | counter |")
        out.append("|---|---|---|---|---|---|")
        for p in vs[:15]:
            label = p["name"] + (f" (sim {p['sim_strategy']})" if p["simulated"] else "")
            out.append(f"| {label} | {p['matches_vs_us']} | {pct(p['winrate_vs_us'] or 0)} | {p['style']} | "
                       f"{p['aggression']} | {p['counter']} |")
    else:
        out.append("- None with 3+ matches yet.")
    out.append("")
    out.append(f"Profiles for {len(profiles)} bots in `data/opponents.json`.")

    with open(REPORT_PATH, "w") as f:
        f.write("\n".join(out) + "\n")
    print("\n".join(out))


if __name__ == "__main__":
    main()
