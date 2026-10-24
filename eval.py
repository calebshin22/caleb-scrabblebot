#!/usr/bin/env python3
"""The judge: is the working tree's bot better than a baseline?

  python3 eval.py                         working tree vs HEAD, 200 games
  python3 eval.py --baseline HEAD~3       vs an older version
  python3 eval.py --candidate x.json      a different strategy file, same code
  python3 eval.py --games 400 --seed 7

Both sides play the same seeded games in scripts/arena.ts (the server's
rules, opponents calibrated to the scraped market), so results are paired
game by game. The baseline runs from a git worktree of its own commit, so
code changes are judged as well as strategy.json changes. Baseline runs
are cached in data/eval_cache/.

Verdict (also in data/eval_last.json), average score first (the
leaderboard's "Avg score" = total_score / matches), winrate second:
  IMPROVED  avg score up >= 1% and significant (paired t > 2)
  WORSE     avg score significantly down (paired t < -2)
  NEUTRAL   anything else; winrate alone never keeps a change
  NEUTRAL   anything else
"""

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
CACHE = os.path.join(DATA, "eval_cache")
WORKTREE = os.path.join(os.path.dirname(ROOT), ".eval-baseline")
MIN_GAMES = 20
WORSE_DROP = 0.05


def run(cmd, cwd=ROOT, check=True):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if check and r.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd)}\n{r.stderr[-2000:]}")
    return r.stdout.strip()


def arena(code_dir, strategy, args, out):
    run(["npx", "--prefix", ROOT, "tsx", os.path.join(code_dir, "scripts", "arena.ts"),
         "--strategy", strategy, "--games", str(args.games), "--seed", str(args.seed),
         "--samples", str(args.samples), "--field", args.field, "--out", out])
    with open(out) as f:
        return json.load(f)


def data_hash():
    h = hashlib.sha256()
    for name in ("market.json", "opponents.json"):
        p = os.path.join(DATA, name)
        if os.path.exists(p):
            with open(p, "rb") as f:
                h.update(f.read())
    return h.hexdigest()[:12]


def baseline_dir(ref):
    """A worktree at `ref`, sharing this repo's node_modules."""
    sha = run(["git", "rev-parse", ref])
    if os.path.isdir(WORKTREE):
        run(["git", "worktree", "remove", "--force", WORKTREE], check=False)
    run(["git", "worktree", "prune"])
    run(["git", "worktree", "add", "--detach", "--force", WORKTREE, sha])
    nm = os.path.join(WORKTREE, "node_modules")
    if not os.path.exists(nm):
        os.symlink(os.path.join(ROOT, "node_modules"), nm)
    if not os.path.exists(os.path.join(WORKTREE, "scripts", "arena.ts")):
        sys.exit(f"{ref} ({sha[:8]}) predates scripts/arena.ts; pick a newer baseline")
    return sha


def summarize(label, s):
    return (f"{label:10} winrate {100 * s['winrate']:5.1f}%  score {s['avgScore']:6.1f}  "
            f"margin {s['avgDiff']:+6.1f}  place {s['avgPlacement']:.2f}  "
            f"tiles {s['avgTilesWon']:4.1f}  unspent {s['avgUnspent']:5.1f}  left {s['avgTilesLeft']:.1f}")


def main():
    ap = argparse.ArgumentParser(description="Judge the working tree against a baseline.")
    ap.add_argument("--candidate", default="strategy.json", help="strategy file for the working tree")
    ap.add_argument("--baseline", default="HEAD", help="git ref to compare against")
    ap.add_argument("--games", type=int, default=200)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--samples", type=int, default=100, help="Monte Carlo samples per bid")
    ap.add_argument("--field", default="real", choices=["real", "sim"])
    ap.add_argument("--out", default="", help="result JSON (default data/eval_last.json)")
    args = ap.parse_args()
    if args.games < MIN_GAMES:
        sys.exit(f"--games must be at least {MIN_GAMES}")
    os.makedirs(CACHE, exist_ok=True)

    cand_out = os.path.join(CACHE, f"candidate-{os.getpid()}.json")
    cand = arena(ROOT, os.path.abspath(args.candidate), args, cand_out)
    os.remove(cand_out)

    sha = run(["git", "rev-parse", args.baseline])
    key = f"{sha[:12]}-{args.games}-{args.seed}-{args.samples}-{args.field}-{data_hash()}"
    cached = os.path.join(CACHE, f"baseline-{key}.json")
    if os.path.exists(cached):
        with open(cached) as f:
            base = json.load(f)
    else:
        baseline_dir(args.baseline)
        base = arena(WORKTREE, os.path.join(WORKTREE, "strategy.json"), args, cached)

    cs, bs = cand["summary"], base["summary"]
    # Paired per game: same seed, same field, same tiles.
    d_margin = [(c["myScore"] - c["bestOpponent"]) - (b["myScore"] - b["bestOpponent"])
                for c, b in zip(cand["games"], base["games"])]
    n = len(d_margin)
    mean = sum(d_margin) / n
    sd = math.sqrt(sum((x - mean) ** 2 for x in d_margin) / max(1, n - 1))
    t = mean / (sd / math.sqrt(n)) if sd > 0 else 0.0
    cand_only = sum(1 for c, b in zip(cand["games"], base["games"]) if c["won"] and not b["won"])
    base_only = sum(1 for c, b in zip(cand["games"], base["games"]) if b["won"] and not c["won"])
    dw = cs["winrate"] - bs["winrate"]
    # The leaderboard's headline is average score (total_score / matches);
    # rank by it first, winrate second.
    d_score = [c["myScore"] - b["myScore"] for c, b in zip(cand["games"], base["games"])]
    ds = sum(d_score) / n
    sds = math.sqrt(sum((x - ds) ** 2 for x in d_score) / max(1, n - 1))
    ts = ds / (sds / math.sqrt(n)) if sds > 0 else 0.0

    # Keep only a significant (t > 2) avg-score gain of at least 1%. Winrate
    # never rescues a change that doesn't raise avg score.
    if ts > 2 and ds >= 0.01 * bs["avgScore"]:
        verdict = "IMPROVED"
    elif ts < -2:
        verdict = "WORSE"
    else:
        verdict = "NEUTRAL"

    print(f"{n} paired games, seed {args.seed}, field {cs['field']}, baseline {args.baseline} ({sha[:8]})")
    print(summarize("candidate", cs))
    print(summarize("baseline", bs))
    print(f"winrate {100 * dw:+.1f} pts; games only the candidate won {cand_only}, only the baseline {base_only}")
    print(f"AVG SCORE {cs['avgScore']:.1f} vs {bs['avgScore']:.1f}: {ds:+.2f} per game (paired t = {ts:.2f})")
    print(f"margin vs best opponent {mean:+.2f} per game (paired t = {t:.2f})")
    print(f"field avg score {cs['fieldAvgScore']:.1f}, field winner {cs['fieldWinnerScore']:.1f}")
    print(f"VERDICT: {verdict}")

    result = {"verdict": verdict, "games": n, "seed": args.seed, "baseline": args.baseline,
              "baseline_sha": sha, "candidate": cs, "baseline_summary": bs,
              "winrate_delta": dw, "score_delta": ds, "score_t": ts, "margin_delta": mean, "paired_t": t,
              "candidate_only_wins": cand_only, "baseline_only_wins": base_only}
    with open(args.out or os.path.join(DATA, "eval_last.json"), "w") as f:
        json.dump(result, f, indent=2)


if __name__ == "__main__":
    main()
