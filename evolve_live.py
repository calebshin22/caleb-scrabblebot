#!/usr/bin/env python3
"""One step of live, data-driven strategy evolution.

The bot's bandit (src/bandit.ts) plays the variants in strategy.json's
"bandit_arms" and records each one's finishing places in data/bandit.json.
This script reads those live results and:

  1. promotes a variant into the base strategy when it beats "base" by more
     than 2 standard errors (both with >= MIN_N matches), then starts a new
     generation of variants;
  2. retires variants that trail the best by more than 2 standard errors;
  3. spawns one new variant (a one-step mutation of the base) when there's
     room, after an arena pre-screen (eval.py, both opponent models) so
     clearly bad ideas never cost live matches.

Every action is logged to experiments.md and committed.

  python3 evolve_live.py             one step
  python3 evolve_live.py --dry-run   show what it would do
"""

import argparse
import json
import math
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
STRATEGY = os.path.join(ROOT, "strategy.json")
BANDIT = os.path.join(DATA, "bandit.json")
HISTORY = os.path.join(DATA, "bandit_history.jsonl")
STATE = os.path.join(DATA, "evolve_live_state.json")
EXPERIMENTS = os.path.join(ROOT, "experiments.md")
MIN_N = 12          # live matches before an arm can be promoted or retired
MAX_ARMS = 5
Z = 2.0
DEFAULT_VAR = 0.12  # reward variance to assume for arms logged without it
PRESCREEN_GAMES = 100

sys.path.insert(0, ROOT)
from optimize import SPACE, step_value  # noqa: E402


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def stats(s):
    n = s.get("n", 0)
    if n == 0:
        return 0, 0.0, float("inf")
    mean = s["reward"] / n
    var = s["sq"] / n - mean * mean if "sq" in s else DEFAULT_VAR
    return n, mean, math.sqrt(max(var, 1e-4) / n)


def log(row):
    n = sum(1 for line in open(EXPERIMENTS) if line.startswith("| ") and line[2:3].isdigit()) + 1
    with open(EXPERIMENTS, "a") as f:
        f.write(f"| {n} | {time.strftime('%Y-%m-%d')} | {row} |\n")


def commit(msg, dry):
    if dry:
        return
    subprocess.run(["git", "add", "strategy.json", "experiments.md"], cwd=ROOT, check=True)
    subprocess.run(["git", "commit", "-q", "-m",
                    msg + "\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"], cwd=ROOT, check=False)


def save_strategy(strategy, dry):
    if not dry:
        with open(STRATEGY, "w") as f:
            json.dump(strategy, f, indent=2)
            f.write("\n")


def describe(arms_stats, arms):
    out = []
    for a in arms:
        n, mean, se = stats(arms_stats.get(a, {}))
        out.append(f"{a}: {n} matches, reward {mean:.2f} ± {se:.2f}" if n else f"{a}: untried")
    return "; ".join(out)


def main():
    ap = argparse.ArgumentParser(description="One live evolution step.")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    dry = args.dry_run

    strategy = load_json(STRATEGY, {})
    arms = dict(strategy.get("bandit_arms", {"base": {}}))
    arms.setdefault("base", {})
    live = load_json(BANDIT, {})
    print("[evolve] " + describe(live, arms))

    # 1. Promote.
    nb, mb, sb = stats(live.get("base", {}))
    ranked = sorted((a for a in arms if a != "base" and stats(live.get(a, {}))[0] >= MIN_N),
                    key=lambda a: -stats(live[a])[1])
    if ranked and nb >= MIN_N:
        best = ranked[0]
        n, m, s = stats(live[best])
        if m - mb > Z * math.sqrt(s * s + sb * sb):
            overrides = arms[best]
            print(f"[evolve] promote {best} ({m:.2f} vs base {mb:.2f}): {overrides}")
            for k, v in overrides.items():
                strategy[k] = v
            # New generation: drop arms the new base makes redundant, reset stats.
            new_arms = {"base": {}}
            for a, o in arms.items():
                if a not in ("base", best) and any(strategy.get(k) != v for k, v in o.items()):
                    new_arms[a] = o
            strategy["bandit_arms"] = new_arms
            save_strategy(strategy, dry)
            if not dry:
                with open(HISTORY, "a") as f:
                    f.write(json.dumps({"t": int(time.time()), "promoted": best, "stats": live}) + "\n")
                with open(BANDIT, "w") as f:
                    json.dump({}, f)
                log(f"live: promote variant `{best}` | {overrides} | live reward {m:.2f} vs base {mb:.2f} "
                    f"over {n}/{nb} matches | PROMOTED | kept")
            commit(f"Promote live variant {best} into the base strategy\n\n"
                   f"Live reward {m:.2f} vs base {mb:.2f} over {n}/{nb} matches.", dry)
            return

    # 2. Retire.
    known = [a for a in arms if stats(live.get(a, {}))[0] >= MIN_N]
    if known:
        top = max(known, key=lambda a: stats(live[a])[1])
        _, mt, st = stats(live[top])
        for a in list(arms):
            if a in ("base", top):
                continue
            n, m, s = stats(live.get(a, {}))
            if n >= MIN_N and mt - m > Z * math.sqrt(s * s + st * st):
                print(f"[evolve] retire {a} ({m:.2f} vs best {top} {mt:.2f})")
                del arms[a]
                if not dry:
                    log(f"live: retire variant `{a}` | {strategy['bandit_arms'][a]} | live reward {m:.2f} "
                        f"vs {top} {mt:.2f} over {n} matches | WORSE | retired")
        if len(arms) != len(strategy["bandit_arms"]):
            strategy["bandit_arms"] = arms
            save_strategy(strategy, dry)
            commit("Retire live variants that trail the best", dry)

    # 3. Spawn one pre-screened mutation of the base.
    if len(arms) >= MAX_ARMS:
        print(f"[evolve] {len(arms)} variants in play; no room to spawn")
        return
    state = load_json(STATE, {"next": 0})
    names = [k for k in SPACE if k in strategy]
    for _ in range(len(names)):
        name = names[state["next"] % len(names)]
        state["next"] = (state["next"] + 1) % len(names)
        kind, step, lo, hi = SPACE[name]
        for direction in (1, -1):
            value = step_value(strategy[name], kind, step, lo, hi, direction)
            arm = f"{name}_{value}"
            if value == strategy[name] or arm in arms or any(o == {name: value} for o in arms.values()):
                continue
            if dry:
                print(f"[evolve] would pre-screen {arm}")
                return
            cand = os.path.join(DATA, f"evolve-{arm}.json")
            with open(cand, "w") as f:
                json.dump(dict(strategy, **{name: value}), f, indent=2)
            out = os.path.join(DATA, f"evolve-{arm}.result.json")
            print(f"[evolve] pre-screening {arm} in the arena", flush=True)
            r = subprocess.run(["nice", "-n", "19", sys.executable, "eval.py", "--candidate", cand,
                                "--games", str(PRESCREEN_GAMES), "--out", out], cwd=ROOT)
            os.remove(cand)
            if r.returncode != 0:
                continue
            res = load_json(out, {})
            os.remove(out)
            verdict = res.get("verdict", "WORSE")
            place = res.get("placement_gain", 0)
            if verdict == "WORSE":
                log(f"tuning: arena pre-screen `{arm}` | `{name}` {strategy[name]} -> {value} | "
                    f"placement {place:+.2f}/game ({PRESCREEN_GAMES} games, both fields) | WORSE | not spawned")
                commit(f"Experiments: {arm} failed the arena pre-screen", dry)
                continue
            arms[arm] = {name: value}
            strategy["bandit_arms"] = arms
            save_strategy(strategy, dry)
            log(f"tuning: spawn live variant `{arm}` | `{name}` {strategy[name]} -> {value} | arena pre-screen "
                f"{verdict}, placement {place:+.2f}/game | LIVE TRIAL | spawned")
            commit(f"Spawn live variant {arm} (arena pre-screen {verdict})", dry)
            json.dump(state, open(STATE, "w"))
            return
    json.dump(state, open(STATE, "w"))
    print("[evolve] nothing to spawn")


if __name__ == "__main__":
    main()
