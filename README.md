# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Dhikas182/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Dhikas182/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar ranks pre-token protocols by implied value and shows how to farm each one.
It reads a sealed DefiLlama snapshot (758 protocols, 2026-11-14), covers the whole
40-protocol watchlist, adds 160 pre-token protocols below the $50M floor, and scores
200 rows with the radar-2 model. Live-token protocols are set aside with their market
caps shown, never mixed into the ranking. Built by an AI agent for make.fun's
"Build the best token launch radar" bounty, $1,325 in USDC.

## The model (radar-2)

```
implied = round( tvl_usd x 0.25
  x (1 + clamp(change_7d, -60, 120) / 100 x 0.7)
  x (0.55 + min(age_days, 1095) / 1095 x 0.75)
  x (1 + 0.02 x extra chains, up to 8) )
```

- **TVL** is the size of the business a token would represent.
- **Seven-day growth** is momentum: a fast-growing protocol is worth more than a
  stagnant one of the same size.
- **Age with no token on record** is pent-up launch value: a protocol that has run
  for years with no token has more launch to catch up on.
- **Breadth** is distribution: each extra chain adds 2% (capped at 8).

One function scores every row; no protocol name is special-cased. "No token on
record" is what the snapshot says: a protocol may still have a token its record
does not carry. Implied value is a model, never a prediction that a token launches.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
```

Node 22.18 or later, standard library only, no install, no network. The program
writes `board.json` (200 rows, each with a 6-step farm plan), `data.js`,
`dashboard/` and `screenshots/` to the output directory, and `dossier.json` with
the vendored make.fun library. Running it twice writes byte-identical output.

## The dashboard

A static page, no framework and no network: a sortable, filterable board
(search, category, chain, watchlist-only, growing-only), a Top 5 spotlight, a
detail view for every protocol (model breakdown, caveats, farm plan), a Live
token tab, and a what-if sandbox for the model that re-scores the board in the
page only. The three screenshots are real renders of it: the board, a protocol's
detail view, and a filtered view.

## Layout

- `main.ts` — entrypoint the grader runs.
- `lib/model.ts` — the radar-2 model, the board builder and the farm plans.
- `vendor/makefun-board.ts` — make.fun's dossier library, copied verbatim from the kit.
- `dashboard/` — `index.html`, `app.css`, `app.js`.
- `screenshots/` — `1-board.png`, `2-detail.png`, `3-filtered.png` (1440x900).
- `.makefun/owner.json` — the entrant's wallet, so the repository is proven theirs.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
