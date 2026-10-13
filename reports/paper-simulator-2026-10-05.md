# Paper run, 2026-10-05

Every number in this report is labelled paper, simulated market.
The stack ran in paper mode against hyperliquid-sim, so the market, the leaders and their fills are synthetic.

- Window: 2026-10-05 22:21 UTC to 2026-10-05 23:55 UTC
- Generated: 2026-10-05 23:55 UTC

## Activity

| Count | Value (paper, simulated market) |
|---|---|
| snapshot fills stored | 180 |
| stream fills stored | 704 |
| decisions | 100 |
| filled orders | 96 |
| copies opened | 24 |
| copies closed | 19 |

## Leaders at the end of the window

| Status | Wallets (paper, simulated market) |
|---|---|
| SHADOW | 6 |
| CANDIDATE | 52 |

## Decisions by verdict and reason

| Book | Verdict | Reason | Decisions (paper, simulated market) |
|---|---|---|---|
| SHADOW | COPY | copied | 94 |
| SHADOW | SKIP | position_not_copied | 6 |

## Latency of stream signals

Paper orders are acknowledged after the configured paper latency, so the last two steps show that setting rather than an exchange.

| Step | Samples | p50 ms (paper, simulated market) | p90 ms (paper, simulated market) | p99 ms (paper, simulated market) |
|---|---|---|---|---|
| leader fill to collector receive | 704 | 102 | 184 | 198 |
| collector receive to core store | 704 | 6 | 11 | 14 |
| collector receive to decision | 100 | 25 | 38.1 | 54.9 |
| decision to order submit | 96 | 5 | 8 | 923.1 |
| order submit to acknowledgement | 96 | 907 | 911.5 | 916.1 |
| leader fill to acknowledgement | 96 | 1,055 | 1,121 | 1,880.9 |

## Copy gap of closed copies

19 copies closed in the window, and 19 of them have a measurable leader episode.
The gap is the copy PnL minus the leader PnL scaled by k, split into entry drift, exit drift, the fee difference, funding and a residual, in USD.

| Book | Copies | copy PnL (paper, simulated market) | scaled leader PnL (paper, simulated market) | gap (paper, simulated market) | entry drift (paper, simulated market) | exit drift (paper, simulated market) | fee difference (paper, simulated market) | funding (paper, simulated market) | residual (paper, simulated market) |
|---|---|---|---|---|---|---|---|---|---|
| SHADOW | 19 | -0.79 | 1.27 | -2.06 | 1.52 | 0.25 | -3.58 | -0.02 | -0.23 |

## Scoring runs

| Run | Started | Finished | Leaderboard rows (paper, simulated market) | Stage one (paper, simulated market) | Stage two (paper, simulated market) | Stage three (paper, simulated market) | Passed every gate (paper, simulated market) |
|---|---|---|---|---|---|---|---|
| run-20261005T2221Z | 2026-10-05 22:21 UTC | 2026-10-05 22:45 UTC | 277 | 58 | 58 | 45 | 32 |
