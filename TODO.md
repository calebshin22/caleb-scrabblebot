# Hackathon TODO

ScrabbleBot is a letter-auction game, not board Scrabble: no board, blanks,
challenges or replies. Board-specific asks are mapped to auction-game
equivalents or marked N/A (see DISCOVERY.md, "Mapping the spec").

## Phase 1: Discover
- [x] Repo: how the bot connects, plays, wordlist, how matches run
- [x] Site: real data source (SpacetimeDB `scrabblebot` on maincloud, SQL API)
- [x] Leaderboard ranking formula (from the site bundle)
- [x] Auto-detect our bot: `cortado` (id 109)
- [ ] DISCOVERY.md, commit

## Phase 2: Data pipeline
- [ ] scrape.py -> data/matches.db (1 req / 30 s, incremental, deduped)
- [ ] analyze.py -> data/report.md (winrate, pts/word, bingo %, QJXZ
      conversion, leftover tiles, loss causes, defensive leak)
- [ ] data/opponents.json profiles, commit

## Phase 3: Strategy engine
- [ ] params.json -> strategy.json, all numbers configurable
- [ ] word value = points + leave + bingo; bid value includes "opponent best
      reply" (what the letter adds to the likeliest winner's best word)
- [ ] scripts/arena.ts: local match simulator with the server's exact rules
      and sim-bot strategies; eval.py judges candidate vs baseline, 20+ games
- [ ] commit

## Phase 4: Counter-strategies (legal play only)
- [ ] random top-K word choice
- [ ] score-dependent mode: ahead = defensive, behind = hoard for long words
- [ ] per-opponent counters from opponents.json, logged, fed back to analyze
- [ ] commit

## Phase 5: Self-improvement loop
- [ ] .claude/commands/evolve.md, experiments.md
- [ ] optimize.py (coordinate search on arena)
- [ ] loop.sh, run end-to-end, commit
