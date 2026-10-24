# Experiments

Every hypothesis, the change, what `python3 eval.py` said, and whether it
was kept. Newest last. Arena numbers are relative: the simulated field
scores ~15% below the real one (see DISCOVERY.md).

| # | date | hypothesis | change | eval (candidate vs baseline) | verdict | kept? |
|---|---|---|---|---|---|---|
| 1 | 2026-10-24 | Real bots play 2.8 words/match averaging 5.7 letters and holding for the 3x multiplier; we play any word at once (1x-1.5x) | `play_min_length` 2 -> 7 | winrate 33.0% vs 1.0%, score 69.3 vs 30.2, margin +42.0/game (t=20.6), 200 games | IMPROVED | kept |
