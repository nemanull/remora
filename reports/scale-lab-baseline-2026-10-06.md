# Scale lab: baseline

Every number in this report is simulated.
It comes from the remora images running against hyperliquid-sim on one Docker host, not from Hyperliquid.

- Scenario: 3 collectors hold 24 wallets for 10 minutes in calm conditions.
- Run: 2026-10-06 02:42 UTC to 2026-10-06 02:54 UTC
- Host: 20 cores, 31 GB, Linux 6.12.107+deb13-amd64
- Result: every invariant held

## Settings

| Setting | Value |
|---|---|
| collectors | 3 |
| wallets per collector | 8 |
| tracked wallets | 24 |
| simulator speed | 10 |
| simulator REST lag, ms | 5000 |
| run after the initial sync, minutes | 10 |

## Invariants

| Invariant | Result | Checked (simulated) |
|---|---|---|
| No fill of a tracked wallet since its tracked_since is missing from Postgres | held | 216 simulator fills of 24 wallets up to 2026-10-06T02:52:30.072Z compared, 0 missing, 0 unknown |
| Every open copy is within rounding of k times its leader position, and every copy whose leader is flat is closed | held | 11 checks of 10 distinct open copies at 9 moments while their leader was quiet: 11 at k times the leader, 0 below it with a recorded clip, rejection, deferral or partial fill, 0 violations, and 1 copies still in motion at the end |
| No signal produced two decisions in one book, and no decision produced two entry orders | held | 138 decisions in 20 chains of book, wallet and coin, 0 breaks, 0 out_of_order records, 0 decisions with two entry orders |
| The simulator recorded no limit refusal that the scenario did not provoke | held | 0 refusals recorded, 0 provoked on purpose, 0 unprovoked |

## Activity

Counted from 2026-10-06T02:42:30.114Z, when the lab added the first wallet.
Every wallet was subscribed at the simulator 0.8 s (simulated) after that, and every backfill reported synced 19.9 s (simulated) after it.

| Count | Value (simulated) |
|---|---|
| stored fills | 1,009 |
| stream fills | 289 |
| backfilled fills | 0 |
| decisions | 138 |
| catch-up decisions | 0 |
| orders | 120 |
| filled orders | 120 |
| copies opened | 45 |
| copies closed | 42 |

## Decisions by verdict and reason

| Book | Verdict | Reason | Decisions (simulated) |
|---|---|---|---|
| SHADOW | COPY | copied | 120 |
| SHADOW | SKIP | below_min_notional | 13 |
| SHADOW | SKIP | position_not_copied | 4 |
| SHADOW | SKIP | already_at_target | 1 |

## Latency of stream signals

Each step is measured from the timestamps stored in Postgres.
Paper orders are acknowledged after the configured paper latency, so the last two steps show that setting rather than an exchange.

| Step | Samples | p50 ms (simulated) | p90 ms (simulated) | p99 ms (simulated) | max ms (simulated) |
|---|---|---|---|---|---|
| leader fill to collector receive | 287 | 116 | 185.2 | 198 | 200 |
| collector receive to core store | 287 | 3 | 9 | 71.6 | 515 |
| collector receive to decision | 137 | 16 | 32.4 | 496.4 | 611 |
| leader fill to decision | 137 | 134 | 211.4 | 584.6 | 704 |
| decision to order submit | 119 | 5 | 12.2 | 33.8 | 41 |
| order submit to acknowledgement | 119 | 906 | 912.2 | 921.8 | 934 |
| leader fill to acknowledgement | 119 | 1,043 | 1,128.2 | 1,544.4 | 1,611 |

## Load

Sampled every 5 s between the end of the initial sync and the end of the run.
The server values are prom-client's event-loop lag p99 and the REST weight the server spent over each minute, the collector value is the p99 each heartbeat reports, and the connection value is the busiest source address at the simulator.

| Measure | Samples | median (simulated) | max (simulated) |
|---|---|---|---|
| server event-loop lag p99, ms | 119 | 10.6 | 12.4 |
| server REST weight spent per minute, budget 400 | 107 | 22 | 34 |
| collector event-loop delay p99, ms | 357 | 20.3 | 20.6 |
| new upstream connections in the last minute, per address | 119 | 0 | 1 |
