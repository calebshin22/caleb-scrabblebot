# Handoff

State as of 2026-10-24 ~17:20. Read DISCOVERY.md (game rules, data source,
leaderboard formula) and experiments.md (everything tried) first.

## Goal

Reach the leaderboard top 5. Rank is by OpenSkill rating, which the server
updates from **finishing place only** (`../spacetimedb/src/game.ts`).
Top 5 is ~2136+ rating, averaging ~2.2nd place / ~93 points per match.

## Engine (changed 2026-10-24 ~17:40)

The base now runs the teammate's Cortadomacchiato engine (`src/cortadomacchiato/`, from
mm-nair/ScrabbleBot; Cortadomacchiato was top-5 live at ~2116), switched on by
`engine_cortadomacchiato` and tuned through `cortadomacchiato_*` keys in strategy.json.
Cortado's own strategy stays live as the `cortado_v1` / `cortado_replay`
variants, so live placement can reverse the switch. The replay judge
(`scripts/tune.ts`) and the arena still run cortado's engine only.

## Where cortado (bot id 109) is

- Rank #75 of 101, rating 1468 ±85 (was #84 / 1111 at first rank, 14:57).
- Since the fixes: about 3.9th place, ~68 points per match over the last 10.
- #1 weakness now: spends ~122 money per match vs the top 5's ~175 and wins
  fewer tiles. The live variants below test spending more.

## What's running (keeps going without any Claude session)

- `run.sh`: the live bot (`BOT_NAME=caleb`), restarts if it exits.
  Log: `data/run.log`.
- `autopilot.sh`: every 30 min: scrape -> analyze -> price model ->
  evolve_live (promote/retire/spawn variants on live placement) -> push to
  GitHub. Every 4th cycle also runs `replay_spawn.py`. Log: `data/autopilot.log`.
- Check: `pgrep -fl 'autopilot.sh|run.sh'`
- Stop: `pkill -f autopilot.sh; pkill -f run.sh; pkill -f src/index.ts`
- Start: `BOT_NAME=caleb nohup ./autopilot.sh >> data/autopilot.log 2>&1 &`
  (it starts `run.sh` itself). Keep the Mac awake: `caffeinate -i &`.
- Bash reads scripts as it runs: after editing `autopilot.sh`, kill it
  (`pkill -9 -f autopilot.sh; rmdir data/.autopilot.lock`) and restart.
  After editing `src/`, restart the bot **between matches** with
  `pkill -USR2 -f src/index.ts`: it finishes its current match, exits, and
  run.sh restarts it on the new code. A plain kill mid-match costs that
  whole match (the bot spends its first minutes catching up on history).
  `strategy.json` changes apply at the next match start, no restart.

## How strategy changes get judged (most to least trusted)

1. **Live:** `src/bandit.ts` picks a variant from `strategy.json`
   `bandit_arms` each match (UCB, small exploration) and records finishing
   place in `data/bandit.json`. `python3 live_eval.py` shows place per variant.
   `evolve_live.py` promotes at +2 SE over base with 12+ matches each.
2. **Replay:** `npx tsx scripts/tune.ts --dry-run --last 60 --params a,b`
   replays our real matches against real opponent bids; fitness = place vs
   their real final scores (`data/opp_scores.json`, refreshed by
   `replay_spawn.py`). Pessimistic in absolute terms, useful relatively.
3. **Arena:** `python3 eval.py` (scripts/arena.ts). Simulated opponents run
   weaker than the real field; it missed the leftover-tile bug and called
   bid_aggression 1.5 a big win that didn't show live. Pre-screen only.

Don't run many arena/replay processes at once while the bot plays: 12 in
parallel pushed late bids (1-second auctions) from 0% to ~4%.

## Live variants right now (reward = place scaled 0..1, higher better)

| variant | overrides | matches | reward |
|---|---|---|---|
| base | bid 1.5, market_floor 0.8, denial 0.9, hold 7+, tricks off | 24 | 0.38 |
| market_1.0 | market_floor 1.0 | 22 | 0.39 |
| no_market | market_floor 0 (old base; can be re-promoted) | 10 | 0.30 |
| spend_late | endgame_spend_fraction 0.6 over last 25 tiles | 3 | 0.33 |
| denial_1.09 | denial_fraction 1.089 | 3 | 0.33 |
| replay_best | bid 1.65, denial 1.198, market_floor 0.72 (replay 5.13 -> 3.98) | 3 | 0.27 |

## Last replay search (done)

From the replay_best settings (replay avg place 3.79), a broad search over
top_anchor, regression_anchor, useful_value, sim_draw_size,
sim_min_rack_size, denial_rack_size, endgame_spend_fraction and
new_letter_premium found no improving step: replay_best is a local optimum
for the replay. Further gains likely need new logic, not tuning.

## Next ideas, in order

1. Let the live trials (spend_late, denial_1.09, replay_best) reach 12+
   matches; promote what wins.
2. Learn bids from the top bots directly: data/matches.db has every top
   bid; the top 5 win 23% of auctions at about the market's typical top bid
   on the letters they need.
3. Once settled, start a new bot version on the Team page to drop the weak
   early matches from the rating (needs a human; website only).

## Repo

GitHub: https://github.com/calebshin22/caleb-scrabblebot (private). The
autopilot pushes `self-improve` and `main` each cycle. Secrets stay
local and are never committed: `.token-caleb` (bot token), `.env`
(scraper's read-only identity), `data/`.
