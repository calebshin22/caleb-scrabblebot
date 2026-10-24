#!/usr/bin/env python3
"""Coordinate-search tuning of strategy.json, judged by eval.py.

  python3 optimize.py                  tune the next parameter in rotation
  python3 optimize.py --param bid_aggression
  python3 optimize.py --dry-run        evaluate, but don't write or commit

One step: try the parameter one step up and one step down, each as a full
paired eval.py run against HEAD. If either is IMPROVED, the better one is
written to strategy.json and committed; every try is logged to
experiments.md. Rotation state lives in data/optimize_state.json.

Plain coordinate search beats guessing here because eval.py is cheap
(~2 min for 200 games) and the parameters interact weakly. Optuna isn't
installed and isn't needed at this scale.
"""

import argparse
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
STATE = os.path.join(DATA, "optimize_state.json")
STRATEGY = os.path.join(ROOT, "strategy.json")
EXPERIMENTS = os.path.join(ROOT, "experiments.md")

# name: (kind, step, min, max). "mul" steps multiply, "add" steps add.
SPACE = {
    "bid_aggression": ("mul", 1.25, 0.1, 8),
    "play_min_length": ("add", 1, 2, 8),
    "new_letter_premium": ("add", 2, 0, 30),
    "endgame_spend_fraction": ("add", 0.15, 0, 1),
    "endgame_bag_size": ("add", 5, 0, 40),
    "defense_weight": ("add", 0.2, 0, 3),
    "denial_fraction": ("mul", 1.15, 0, 2),
    "sim_min_rack_size": ("add", 2, 0, 20),
    "bingo_bonus": ("add", 5, 0, 50),
    "hold_rack_size": ("add", 2, 0, 15),
    "behind_aggression": ("mul", 1.2, 0.5, 3),
    "price_set_cap_fraction": ("add", -0.15, 0, 1),
}


def step_value(v, kind, step, lo, hi, direction):
    if kind == "mul":
        nv = v * step if direction > 0 else v / step
        if v == 0:
            nv = 0.1 if direction > 0 else 0
    else:
        nv = v + direction * step
    nv = min(hi, max(lo, nv))
    return int(nv) if isinstance(v, int) and kind == "add" and float(step).is_integer() else round(nv, 4)


def log_experiment(hypothesis, change, result, verdict, kept):
    n = sum(1 for line in open(EXPERIMENTS) if line.startswith("| ") and line[2:3].isdigit()) + 1
    c, b = result["candidate"], result["baseline_summary"]
    ev = (f"winrate {100 * c['winrate']:.1f}% vs {100 * b['winrate']:.1f}%, score {c['avgScore']:.1f} vs "
          f"{b['avgScore']:.1f}, margin {result['margin_delta']:+.1f}/game (t={result['paired_t']:.1f}), "
          f"{result['games']} games")
    with open(EXPERIMENTS, "a") as f:
        f.write(f"| {n} | {time.strftime('%Y-%m-%d')} | {hypothesis} | {change} | {ev} | {verdict} | "
                f"{'kept' if kept else 'reverted'} |\n")


def main():
    ap = argparse.ArgumentParser(description="One coordinate-search step on strategy.json.")
    ap.add_argument("--param", choices=sorted(SPACE))
    ap.add_argument("--games", type=int, default=200)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    state = {"next": 0}
    if os.path.exists(STATE):
        state = json.load(open(STATE))
    names = list(SPACE)
    name = args.param or names[state["next"] % len(names)]
    kind, step, lo, hi = SPACE[name]
    base = json.load(open(STRATEGY))
    current = base[name]

    tries = []
    for direction in (1, -1):
        value = step_value(current, kind, step, lo, hi, direction)
        if value == current:
            continue
        cand = dict(base, **{name: value})
        path = os.path.join(DATA, f"optimize-{name}-{direction}.json")
        with open(path, "w") as f:
            json.dump(cand, f, indent=2)
        out = os.path.join(DATA, f"optimize-{name}-{direction}.result.json")
        print(f"[optimize] {name}: {current} -> {value}", flush=True)
        r = subprocess.run([sys.executable, os.path.join(ROOT, "eval.py"), "--candidate", path,
                            "--games", str(args.games), "--out", out], cwd=ROOT, text=True)
        if r.returncode != 0:
            continue
        result = json.load(open(out))
        tries.append((value, result))
        os.remove(path)
        os.remove(out)

    state["next"] = (names.index(name) + 1) % len(names)
    os.makedirs(DATA, exist_ok=True)
    json.dump(state, open(STATE, "w"))

    improved = [t for t in tries if t[1]["verdict"] == "IMPROVED"]
    best = max(improved, key=lambda t: (t[1]["winrate_delta"], t[1]["margin_delta"]), default=None)
    for value, result in tries:
        kept = best is not None and value == best[0]
        print(f"[optimize] {name}={value}: {result['verdict']} (winrate {100 * result['winrate_delta']:+.1f} pts, "
              f"margin {result['margin_delta']:+.2f})")
        if not args.dry_run:
            log_experiment(f"tuning: {name}", f"`{name}` {current} -> {value}", result, result["verdict"], kept)
    if args.dry_run:
        return
    if best:
        base[name] = best[0]
        with open(STRATEGY, "w") as f:
            json.dump(base, f, indent=2)
            f.write("\n")
        r = best[1]
        subprocess.run(["git", "add", "strategy.json", "experiments.md"], cwd=ROOT, check=True)
        subprocess.run(["git", "commit", "-q", "-m",
                        f"Tune {name}: {current} -> {best[0]}\n\neval.py, {r['games']} paired games: winrate "
                        f"{100 * r['candidate']['winrate']:.1f}% vs {100 * r['baseline_summary']['winrate']:.1f}%, "
                        f"margin {r['margin_delta']:+.2f}/game (t={r['paired_t']:.1f}).\n\n"
                        "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"], cwd=ROOT, check=True)
        print(f"[optimize] kept {name}={best[0]} and committed")
    else:
        subprocess.run(["git", "add", "experiments.md"], cwd=ROOT, check=True)
        subprocess.run(["git", "commit", "-q", "-m", f"Experiments: {name} unchanged (no improving step)\n\n"
                        "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"], cwd=ROOT, check=False)
        print(f"[optimize] no improving step for {name}; strategy.json unchanged")


if __name__ == "__main__":
    main()
