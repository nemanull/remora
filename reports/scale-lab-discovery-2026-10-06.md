# Scale lab: discovery

Every number in this report is simulated.
It comes from the remora images running against hyperliquid-sim on one Docker host, not from Hyperliquid.

- Scenario: A full discovery run over the synthetic leaderboard, compared with the planted edge of the simulator and with rankings by raw PnL.
- Run: 2026-10-06 02:03 UTC to 2026-10-06 02:29 UTC
- Host: 20 cores, 31 GB, Linux 6.12.107+deb13-amd64
- Result: every invariant held

## Settings

| Setting | Value |
|---|---|
| tracked target | 16 |
| selection streak runs | 1 |
| synthetic wallets | 300 |
| collectors | 2 |
| simulator speed | 30 |
| simulator REST lag, ms | 5000 |
| wallet-finder REST budget per minute | 600 |
| run after the selection, minutes | 5 |

## Invariants

| Invariant | Result | Checked (simulated) |
|---|---|---|
| No fill of a tracked wallet since its tracked_since is missing from Postgres | held | 147 simulator fills of 16 wallets up to 2026-10-06T02:29:07.968Z compared, 0 missing, 0 unknown |
| Every open copy is within rounding of k times its leader position, and every copy whose leader is flat is closed | held | 19 checks of 5 distinct open copies at 5 moments while their leader was quiet: 19 at k times the leader, 0 below it with a recorded clip, rejection, deferral or partial fill, 0 violations, and 0 copies still in motion at the end |
| No signal produced two decisions in one book, and no decision produced two entry orders | held | 28 decisions in 13 chains of book, wallet and coin, 0 breaks, 0 out_of_order records, 0 decisions with two entry orders |
| The simulator recorded no limit refusal that the scenario did not provoke | held | 0 refusals recorded, 0 provoked on purpose, 0 unprovoked |

## Funnel

Run run-20261006T0203Z took 20 minutes (simulated).

| Stage | Wallets (simulated) |
|---|---|
| leaderboard rows | 277 |
| stage one survivors | 58 |
| stage two scored | 58 |
| stage three scored | 44 |
| stage 2 scores that failed the gates | 14 |
| stage 3 scores that failed the gates | 12 |
| stage 3 scores that passed the gates | 32 |
| selected into the shadow set | 16 |

## Planted edge

The raw PnL rankings take the same number of wallets as the selection from the non-vault rows of the leaderboard file.

| Set | wallets with a planted edge (simulated) |
|---|---|
| selected by the composite score | 15 of 16 (94%) |
| top by all-time PnL | 11 of 16 (69%) |
| top by 30-day PnL | 7 of 16 (44%) |
| every non-vault leaderboard row | 44 of 262 (17%) |

## Activity

Counted from 2026-10-06T02:24:19.820Z, when selection had settled on its wallets.
Every wallet was subscribed at the simulator 0 s (simulated) after that, and every backfill reported synced 8.1 s (simulated) after it.

| Count | Value (simulated) |
|---|---|
| stored fills | 127 |
| stream fills | 127 |
| backfilled fills | 0 |
| decisions | 22 |
| catch-up decisions | 0 |
| orders | 13 |
| filled orders | 13 |
| copies opened | 3 |
| copies closed | 0 |

## Decisions by verdict and reason

| Book | Verdict | Reason | Decisions (simulated) |
|---|---|---|---|
| SHADOW | COPY | copied | 13 |
| SHADOW | SKIP | position_not_copied | 9 |

## Latency of stream signals

Each step is measured from the timestamps stored in Postgres.
Paper orders are acknowledged after the configured paper latency, so the last two steps show that setting rather than an exchange.

| Step | Samples | p50 ms (simulated) | p90 ms (simulated) | p99 ms (simulated) | max ms (simulated) |
|---|---|---|---|---|---|
| leader fill to collector receive | 126 | 74 | 186 | 197.3 | 198 |
| collector receive to core store | 126 | 10 | 27 | 27 | 29 |
| collector receive to decision | 21 | 26 | 41 | 64.2 | 65 |
| leader fill to decision | 21 | 130 | 207 | 219.6 | 221 |
| decision to order submit | 13 | 5 | 7.8 | 15 | 16 |
| order submit to acknowledgement | 13 | 908 | 913.8 | 957.1 | 963 |
| leader fill to acknowledgement | 13 | 1,046 | 1,106.2 | 1,123.2 | 1,124 |

## Load

Sampled every 5 s between the end of the initial sync and the end of the run.
The server values are prom-client's event-loop lag p99 and the REST weight the server spent over each minute, the collector value is the p99 each heartbeat reports, and the connection value is the busiest source address at the simulator.

| Measure | Samples | median (simulated) | max (simulated) |
|---|---|---|---|
| server event-loop lag p99, ms | 59 | 10.5 | 11 |
| server REST weight spent per minute, budget 400 | 47 | 6 | 10 |
| collector event-loop delay p99, ms | 118 | 20.3 | 20.4 |
| new upstream connections in the last minute, per address | 59 | 0 | 0 |
