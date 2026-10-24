#!/usr/bin/env python3
"""Honest judge: real match results per strategy version, from the bot's
own log (data/matches.jsonl). A version is the hash of the params the bot
logged at match start. Rating comes from finishing place, so avg place is
the headline. Usage: python3 live_eval.py"""
import collections, hashlib, json, math, os

LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "matches.jsonl")
starts, ends = {}, {}
for line in open(LOG):
    e = json.loads(line)
    if e.get("type") == "match_start" and not e.get("resumed"):
        starts.setdefault(e["matchId"], e)
    elif e.get("type") == "match_end" and e.get("placement"):
        ends[e["matchId"]] = e
groups = collections.defaultdict(list)
for m, e in ends.items():
    p = starts.get(m, {}).get("params")
    if p:
        groups[hashlib.sha1(json.dumps(p, sort_keys=True).encode()).hexdigest()[:8]].append((e, p))
print(f"{'version':9} {'n':>3} {'avg place':>9} {'±':>5} {'win%':>5} {'top3%':>6} {'score':>6}  key settings")
for v, rows in sorted(groups.items(), key=lambda kv: min(r[0]["t"] for r in kv[1])):
    pl = [r[0]["placement"] for r in rows]; n = len(pl); mean = sum(pl) / n
    se = math.sqrt(sum((x - mean) ** 2 for x in pl) / max(1, n - 1) / n) if n > 1 else float("nan")
    p = rows[0][1]
    print(f"{v:9} {n:3} {mean:9.2f} {se:5.2f} {100*sum(x==1 for x in pl)/n:5.0f} {100*sum(x<=3 for x in pl)/n:6.0f} "
          f"{sum(r[0]['myScore'] for r in rows)/n:6.1f}  min_len={p.get('play_min_length')} aggr={p.get('bid_aggression')} "
          f"tricks={p.get('deception_enabled')}")
print("Random play in a 6-bot lobby: avg place 3.50, win 17%. Trust a difference only beyond ~2x the ± column.")
