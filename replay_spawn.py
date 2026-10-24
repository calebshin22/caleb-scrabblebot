#!/usr/bin/env python3
"""Refresh the `replay_best` live variant from a replay search.

Exports the opponents' real final scores for our logged matches, runs
scripts/tune.ts (replays our recent real matches against the real opponent
bids, fitness = finishing place), and sets the `replay_best` arm in
strategy.json to the changes it found relative to the base. Logs to
experiments.md and commits. The live bandit then decides whether it plays.

  python3 replay_spawn.py
"""

import json
import os
import re
import sqlite3
import subprocess
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
PARAMS = ("denial_fraction,market_floor,bid_aggression,endgame_spend_fraction,"
          "denial_rack_size,play_min_length,new_letter_premium")


def export_opp_scores():
    ids = set()
    for line in open(os.path.join(DATA, "matches.jsonl")):
        if '"match_start"' in line:
            ids.add(int(json.loads(line)["matchId"]))
    us = json.load(open(os.path.join(ROOT, "ourbot.json")))["bot_id"]
    db = sqlite3.connect(os.path.join(DATA, "matches.db"))
    out = {}
    for m in ids:
        rows = db.execute("SELECT bot_id, score FROM participants WHERE match_id = ?", (m,)).fetchall()
        if rows:
            out[str(m)] = [s for b, s in rows if b != us]
    json.dump(out, open(os.path.join(DATA, "opp_scores.json"), "w"))
    return len(out)


def main():
    n = export_opp_scores()
    print(f"[replay] {n} logged matches with opponent scores")
    r = subprocess.run(["nice", "-n", "19", "npx", "tsx", "scripts/tune.ts", "--dry-run", "--rounds", "3",
                        "--samples", "40", "--last", "60", "--min-matches", "20", "--params", PARAMS],
                       cwd=ROOT, capture_output=True, text=True)
    out = r.stdout
    print("\n".join(l for l in out.splitlines() if l.startswith(("current", "round", "Best", "No improvement"))))
    changes = dict(re.findall(r"^  ([a-z_]+): \S+ -> (\S+)$", out, re.M))
    best = re.search(r"Best: avg place ([\d.]+).*\(was ([-\d.]+)\)", out)
    base = re.search(r"current params: avg place ([\d.]+)", out)
    if not changes or not best:
        print("[replay] no improvement over the base; replay_best unchanged")
        return
    strategy = json.load(open(os.path.join(ROOT, "strategy.json")))
    arm = {k: (int(v) if v.isdigit() else float(v)) for k, v in changes.items()}
    strategy.setdefault("bandit_arms", {})["replay_best"] = arm
    with open(os.path.join(ROOT, "strategy.json"), "w") as f:
        json.dump(strategy, f, indent=2)
        f.write("\n")
    rows = sum(1 for l in open(os.path.join(ROOT, "experiments.md")) if l.startswith("| ") and l[2:3].isdigit())
    with open(os.path.join(ROOT, "experiments.md"), "a") as f:
        f.write(f"| {rows + 1} | {time.strftime('%Y-%m-%d')} | replay search on the last 60 real matches | "
                f"`replay_best` = {arm} | replay avg place {base.group(1) if base else '?'} -> {best.group(1)} | "
                f"IMPROVED (replay) | live variant refreshed |\n")
    subprocess.run(["git", "add", "strategy.json", "experiments.md"], cwd=ROOT, check=True)
    subprocess.run(["git", "commit", "-q", "-m", f"Refresh replay_best from replay search: {arm}\n\n"
                    f"Replay avg place {base.group(1) if base else '?'} -> {best.group(1)}.\n\n"
                    "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"], cwd=ROOT, check=False)
    print(f"[replay] replay_best = {arm}")


if __name__ == "__main__":
    main()
