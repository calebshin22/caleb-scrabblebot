---
description: One self-improvement cycle for the ScrabbleBot - pick the top loss cause, make one change, let eval.py judge, keep or revert.
---

You are running one evolve cycle for our ScrabbleBot (`cortado`). The game
is a letter auction, not board Scrabble; see DISCOVERY.md. Work without
asking questions, and make exactly ONE change.

1. Read `data/report.md`, `experiments.md`, and `strategy.json`. Note the
   #1 loss cause in the report and what's already been tried (don't repeat
   a failed hypothesis unless the data has changed).

2. Decide the kind of change:
   - If the last 3 rows in `experiments.md` that start with "tuning:" are
     all NEUTRAL or WORSE, tuning has plateaued: **invent new logic** in
     `src/strategy.ts` (or `src/intel.ts` / `src/simulator.ts`). Make it
     configurable through a new key in `src/params.ts` `DEFAULT_PARAMS`
     (and `TUNABLE` if numeric), defaulting to the new behaviour, and add it
     to `strategy.json`.
   - Otherwise make one tuning change: either edit a single value in
     `strategy.json` aimed at the #1 loss cause, or run
     `python3 optimize.py --param <name>`. optimize.py runs eval.py itself,
     logs to experiments.md and commits; if you use it, stop after step 5.

3. If you changed code, run `npm run typecheck && npm test`. Fix failures or
   revert the change.

4. Judge it, and only this way: `python3 eval.py` (200 paired games vs HEAD, two opponent models; placement first, since rating comes from finishing place).
   Read the VERDICT line.

5. Append one row to `experiments.md`:
   `| n | date | hypothesis | change | eval numbers | VERDICT | kept/reverted |`.
   Prefix the hypothesis with "tuning:" for strategy.json-only changes.
   - IMPROVED: `git add -A strategy.json src experiments.md` and commit:
     `Evolve: <change>` with the eval numbers in the body.
   - NEUTRAL or WORSE: revert with `git checkout -- strategy.json src`, then
     `git add experiments.md` and commit `Experiments: <change> reverted`.

Rules: legal in-game play only. No server exploits, no spamming reducers,
no invalid words, no rate-limit circumvention. Never read or edit `.env` or
`.token-*`. Never push. Don't edit eval.py or scripts/arena.ts to make a
change look better. If eval.py itself is broken, log that in experiments.md
and stop.
