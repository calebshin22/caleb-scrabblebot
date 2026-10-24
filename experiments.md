# Experiments

Every hypothesis, the change, what `python3 eval.py` said, and whether it
was kept. Newest last. Arena numbers are relative: the simulated field
scores ~15% below the real one (see DISCOVERY.md).

| # | date | hypothesis | change | eval (candidate vs baseline) | verdict | kept? |
|---|---|---|---|---|---|---|
| 1 | 2026-10-24 | Real bots play 2.8 words/match averaging 5.7 letters and holding for the 3x multiplier; we play any word at once (1x-1.5x) | `play_min_length` 2 -> 7 | winrate 33.0% vs 1.0%, score 69.3 vs 30.2, margin +42.0/game (t=20.6), 200 games | IMPROVED | kept |
| 2 | 2026-10-24 | Bidding less saves money for better letters | `bid_aggression` 1 -> 0.3 | winrate 19.0% vs 33.0%, score 60.4 vs 69.3, margin -12.2/game (t=-5.4), 200 games | WORSE | reverted |
| 3 | 2026-10-24 | Counters fit to opponent profiles help | `counters_enabled` true -> false | winrate 12.5% vs 33.0%, score 54.0 vs 69.3 (disabling hurts) | WORSE | counters kept on |
| 4 | 2026-10-24 | tuning: Behind, bid harder and hold for long words | `open_board_when_behind` false -> true | winrate 36.0% vs 33.0%, score 70.4 vs 69.3, 200 games | IMPROVED | kept |
| 5 | 2026-10-24 | tuning: Ahead, play at once and defend | `close_board_when_ahead` false -> true | winrate 25.5% vs 33.0%, score 64.7 vs 69.3 | WORSE | reverted |
| 6 | 2026-10-24 | tuning: Random top-2 words make us harder to model | `random_top_k` 1 -> 2 | winrate 31.0% vs 33.0%, score 65.4 vs 69.3 (arena opponents don't model us, so only the cost shows) | NEUTRAL | reverted |
| 7 | 2026-10-24 | tuning: Bid to deny letters that complete an opponent's best word | `defense_weight` 0 -> 0.3 | winrate 34.5% vs 33.0%, score 70.8 vs 69.3 | IMPROVED | next loop (one change at a time) |
| 8 | 2026-10-24 | tuning: Defense_weight under the new score-first rule | `defense_weight` 0 -> 0.3 | avg score 71.5 vs 70.4, +1.1/game (t=1.3), 200 games | NEUTRAL | reverted |
| 9 | 2026-10-24 | tuning: #1 (LetterShark) wins ~4 more tiles/match; we end with ~54 unspent money, which is worthless | `bid_aggression` 1 -> 1.5 | avg score 81.5 vs 70.4, +11.1/game (t=7.8), 200 games | IMPROVED | kept |
| 10 | 2026-10-24 | tuning: Bid even harder; ~38 money still unspent | `bid_aggression` 1.5 -> 2.0 | avg score 82.2 vs 81.5, +0.7/game (t=0.4); unspent 24.8 vs 37.7 but no more tiles (Vickrey: higher bids mostly pay more for the same tiles) | NEUTRAL | reverted |
| 11 | 2026-10-24 | tuning: Same, further | `bid_aggression` 1.5 -> 2.5 | avg score 82.0 vs 81.5, +0.5/game (t=0.3) | NEUTRAL | reverted |
| 12 | 2026-10-24 | Tricks (jitter, random skips, price-setting) waste money; price-setting bought unplayable O's live | `deception_enabled` true -> false | live test: compare with `python3 live_eval.py` after ~20 matches (current version: avg place 5.27 over 11) | PENDING (live) | live trial |
| 13 | 2026-10-24 | Top-5 bots win 23% of auctions bidding the market's typical top bid on letters they need | `top_anchor` 1.0 (and u4 / 0.9-u8 variants) | arena 80 games: place 2.09/1.71 vs base 1.85/2.99, worse than market_0.8 on both fields | NEUTRAL | not used |
| 14 | 2026-10-24 | Anchor bids to the market price for useful letters | promote `market_floor` 0 -> 0.8 into base | live reward 0.40 vs base 0.33 (9/9 matches) and arena place 1.81/1.76 vs 1.85/2.99 (80 games, both fields) | PROMOTED | kept; old base stays live as `no_market` |
| 15 | 2026-10-24 | Counters never had a live control (deny_hoarder 61 matches, avg place 4.79; price_set_aggressive 16, 5.06) | live variant `len_6` (last generation reward 0.23 vs 0.33-0.40) -> `no_counters` (`counters_enabled` false) | live trial; evolve_live.py decides | LIVE TRIAL | spawned |
| 16 | 2026-10-24 | A linear regression of the winning bid (face, vowel, bag share, stage, stage^2; R^2 0.43 on 20k auctions) prices letters better than the flat market average | live variant `regression` (`regression_anchor` 0.9 on top of base) | live trial; evolve_live.py decides | LIVE TRIAL | spawned |
| 17 | 2026-10-24 | The live learner explored too much: the leader (base, reward 0.44) got 0 of ~35 matches in one cycle while new arms played; rank #77 -> #82 | bandit exploration UCB1 (c 1.41, untried first) -> c 0.35 with a 2-match prior at reward 0.3 | rating cost of exploration | FIX | kept |
