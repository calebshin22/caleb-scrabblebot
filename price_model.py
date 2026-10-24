#!/usr/bin/env python3
"""Linear regression for the winning bid of an auction, trained on recent
scraped auctions (data/matches.db): top_bid ~ face value, vowel, how common
the letter is in the bag, and match stage (linear + squared). Writes the
coefficients to data/price_model.json for the bot's regression_anchor.
Standard library only (normal equations). Usage: python3 price_model.py"""
import json, os, sqlite3, time

ROOT = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(ROOT, "data", "matches.db")
OUT = os.path.join(ROOT, "data", "price_model.json")
VALUE = dict(zip("ABCDEFGHIJKLMNOPQRSTUVWXYZ", [1,3,3,2,1,4,2,4,1,8,5,1,3,1,1,3,10,1,1,1,1,4,4,8,4,10]))
BAG = dict(zip("ABCDEFGHIJKLMNOPQRSTUVWXYZ", [9,2,2,4,12,2,3,2,9,1,1,4,2,6,8,2,1,6,4,6,4,2,2,1,2,1]))
NAMES = ["intercept", "face", "vowel", "bag_share", "stage", "stage2"]
RECENT = 1500  # most recent matches


def features(letter, stage):
    return [1.0, VALUE[letter], 1.0 if letter in "AEIOU" else 0.0, BAG[letter] / 98, stage, stage * stage]


def solve(A, b):
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[p] = M[p], M[c]
        for r in range(n):
            if r != c and M[c][c]:
                f = M[r][c] / M[c][c]
                M[r] = [x - f * y for x, y in zip(M[r], M[c])]
    return [M[i][n] / M[i][i] for i in range(n)]


def main():
    db = sqlite3.connect(DB)
    rows = db.execute(f"""
        SELECT a.letter, t.top_bid,
               (ROW_NUMBER() OVER (PARTITION BY a.match_id ORDER BY a.auction_id) - 1) * 1.0
                 / COUNT(*) OVER (PARTITION BY a.match_id)
        FROM auction_results a JOIN top_bids t USING (auction_id)
        WHERE a.winner_bot_id IS NOT NULL
          AND a.match_id > (SELECT MAX(id) - {RECENT} FROM matches)""").fetchall()
    k = len(NAMES)
    XtX = [[0.0] * k for _ in range(k)]
    Xty = [0.0] * k
    data = []
    for letter, top, stage in rows:
        if letter not in VALUE:
            continue
        x = features(letter, stage)
        data.append((x, top))
        for i in range(k):
            Xty[i] += x[i] * top
            for j in range(k):
                XtX[i][j] += x[i] * x[j]
    coef = solve(XtX, Xty)
    mean = sum(y for _, y in data) / len(data)
    ss_res = sum((y - sum(c * v for c, v in zip(coef, x))) ** 2 for x, y in data)
    ss_tot = sum((y - mean) ** 2 for _, y in data)
    r2 = 1 - ss_res / ss_tot
    json.dump({"trained_at": int(time.time()), "n": len(data), "r2": round(r2, 4),
               "features": NAMES, "coef": coef}, open(OUT, "w"), indent=2)
    print(f"price model: n={len(data)}, R^2={r2:.3f}, " + ", ".join(f"{n}={c:+.2f}" for n, c in zip(NAMES, coef)))
    for L, s in (("E", 0.1), ("E", 0.9), ("Z", 0.1), ("Z", 0.9)):
        print(f"  predicted top bid {L} at stage {s}: {sum(c * v for c, v in zip(coef, features(L, s))):.1f}")


if __name__ == "__main__":
    main()
