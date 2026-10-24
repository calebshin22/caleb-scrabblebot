# Discovery

## The game (from ../spacetimedb/src/game.ts)

ScrabbleBot is a **letter-auction game**, not board Scrabble.

- Lobbies of up to 6 bots; after 90 s a lobby starts, padded with simulated
  bots if needed. Each bot starts with **100 money** and **5 hidden tiles**
  dealt from a standard 98-tile bag (no blanks).
- Tiles are auctioned one at a time; each auction lasts **1000 ms**. Bids are
  sealed. **Vickrey** (winner pays the second-highest bid, or 1 if alone) or
  first-price. Every match in the scraped data (4,162) was Vickrey.
- At any time a bot may play a word from its rack (validated against the
  wordlist). Payout = sum of letter values x length multiplier:
  1x (<=3), 1.5x (4), 2x (5), 2.5x (6), 3x (7+). The payout is added to both
  **score** and balance.
- The bag empties after ~93 auctions; the match ends then. **Score decides
  placement and rating; leftover money is worth nothing.**
- Simulated bots (Cheapskate / ValueBidder / Aggressive / Human=idle) bid
  `face - 1`, `face`, `face + 2 (+4 vowels)` with +/-2 jitter and play their
  longest 3+ letter word right after each win.

## The bot (this repo)

- `src/index.ts` connects to `scrabblebot` on `https://maincloud.spacetimedb.com`
  with the token in `.token-<BOT_NAME>` (never committed), subscribes to all
  tables, bids on each open auction (`decideBid`) and plays words on rack
  changes (`chooseWord`).
- Wordlist: `../spacetimedb/wordlist.txt` (172,820 words), shared with the server.
- Our bot: **`cortado`, id 109** (`ourbot.json`), detected from the bot's own
  startup log ("acting as bot 'cortado' (id 109)").
- Run: `BOT_NAME=caleb npm start` (or `./run.sh` to auto-restart).

## The leaderboard site

- `https://scrabblebot.spacetimedb.com/leaderboard` is a single-page app
  (`/assets/index-*.js`) using the SpacetimeDB TypeScript SDK:
  `withUri("https://maincloud.spacetimedb.com")`, `withDatabaseName("scrabblebot")`,
  websocket subscriptions to the public tables. No separate REST API.
- **Data source used:** SpacetimeDB's SQL HTTP API,
  `POST /v1/database/scrabblebot/sql` with a bearer token. `scrape.py` mints
  an anonymous identity once (`POST /v1/identity`, stored in `.env`, never
  committed); the bot's own token is not used. One statement per request.
- Public tables: `bot`, `team`, `bot_stats`, `rating_history`, `match_state`,
  `match_participant`, `auction_result`, `auction_top_bid_archive` (top bids,
  published when a match ends), `word_play`, `bot_version`, tournaments.
  Live bids and racks are private.
- **Ranking formula** (from the bundle): rating = `round(1500 + X*(mu - 25))`,
  spread = `round(X*sigma)`, `X = 400 / (25/6 * ln10 * sqrt2)` ~ 29.47.
  Bots with spread > 175 are "provisional" and unranked; the rest are sorted
  by rating.

## What the data says (first scrape)

- 4,162 matches, 283k auctions, 69k words, 93 teams, 99 bots (6 simulated).
  97% of matches have no simulated bots: **the field is real bots.**
- Prices are far above face value: 1-point letters average ~10 paid (top bid
  ~14); Z ~34 paid (top ~43). Everyone spends their whole balance, since
  money is worthless at the end.
- Cortado: 3 matches, 0 wins, avg score 3.7 vs the winner's 109, 0.3 tiles
  won per match, 99.7 money unspent. **#1 weakness: bids at roughly face
  value, so it almost never wins a tile.**

## Mapping the spec to this game

| Spec item | Here |
|---|---|
| points / turn | points per word and per auction |
| bingo % | share of words with 7+ letters (3x multiplier) |
| blank conversion | N/A (no blanks) |
| Q/J/X/Z conversion | of those tiles we won, share we played |
| rack leave quality | tiles unplayed and money unspent at match end; `leave_weight` in word choice |
| defensive leak | points opponents scored with tiles they won (credited by the tile's share of the word) |
| opponent best reply risk | how much the auctioned letter adds to the likeliest winner's best word (`defense_weight`) |
| open / close board | behind: hoard for long words and bid harder; ahead: play now and deny |
| TWS / bingo lanes, bait traps, hooks, parallel plays | N/A (no board) |
| challenge_threshold | N/A (the server validates words; no challenges) |
| random top-K | random choice among the top-K words, plus bid jitter |
| eval vs opponents | `scripts/arena.ts`: local matches under the server's rules against opponents calibrated to the scraped market |

## The leaderboard's "average score" (exact formula)

From the site bundle's leaderboard row renderer:

    Win %     = (wins / matchesPlayed * 100).toFixed(0) + "%"
    Avg score = (Number(totalScore) / matchesPlayed).toFixed(1)    // points, no %

`totalScore` is the sum of the bot's final match scores (word rewards) in
`bot_stats`. There is no score percentage on the site: "94.2%" is an avg
score of 94.2 points per match. Top avg scores right now (bots with 50+ matches):
LetterShark 110.1, postturing 94.0, Nijello 93.9, Chinese Dante 93.1.
Rank order itself is by OpenSkill rating (see above), which is driven by
finishing score relative to the table, so raising score raises both.
analyze.py reports this metric; eval.py keeps a change only if it raises
avg score by >= 1% with paired t > 2 (winrate never rescues a change).

## What the top bots do (scraped)

| bot | avg score | words/match | avg len | pts/word | 7+ letters | tiles won | paid/tile |
|---|---|---|---|---|---|---|---|
| LetterShark | 110.1 | 3.4 | 6.09 | 32.5 | 67% | 16.5 | 12.5 |
| postturing | 94.0 | 3.0 | 6.11 | 30.2 | 55% | 14.8 | 11.8 |
| Nijello | 93.9 | 3.0 | 5.90 | 31.6 | 50% | 12.9 | 13.7 |
| Chinese Dante | 93.1 | 2.9 | 5.97 | 32.3 | 61% | 12.4 | 14.1 |

#1's trick: **more tiles at a lower price per tile**, turned into 7+ letter
words (3x). It wins ~4 more tiles per match than #2-#4 while paying less.

Board-Scrabble asks that don't exist here: GADDAG/cross-words/hooks/
parallel plays (no board), exchanges and blanks (none), 50-point bingo
bonus (the bonus is the 3x multiplier at 7+ letters). Opponent selection
isn't possible: the rolling lobby seats whoever queues, so we don't try.
The valid wordlist is the module's own `../spacetimedb/wordlist.txt`
(172,820 words), which the bot and arena already use.
