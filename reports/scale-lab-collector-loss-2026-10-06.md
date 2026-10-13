# Scale lab: collector loss

Every number in this report is simulated.
It comes from the remora images running against hyperliquid-sim on one Docker host, not from Hyperliquid.

- Scenario: 2 of 6 collectors are killed mid-run, and their wallets must move to the others after the 30 s grace period with nothing lost.
- Run: 2026-10-06 03:19 UTC to 2026-10-06 03:27 UTC
- Host: 20 cores, 31 GB, Linux 6.12.107+deb13-amd64
- Result: every invariant held

## Settings

| Setting | Value |
|---|---|
| collectors | 6 |
| wallets per collector | 8 |
| tracked wallets | 24 |
| killed collectors | 2 and 5 |
| assignment grace, ms | 30000 |
| simulator speed | 30 |
| simulator REST lag, ms | 10000 |
| run before the loss, minutes | 2 |
| run after the recovery, minutes | 3 |

## Invariants

| Invariant | Result | Checked (simulated) |
|---|---|---|
| No fill of a tracked wallet since its tracked_since is missing from Postgres | held | 350 simulator fills of 24 wallets up to 2026-10-06T03:25:24.396Z compared, 0 missing, 0 unknown |
| Every open copy is within rounding of k times its leader position, and every copy whose leader is flat is closed | held | 6 checks of 3 distinct open copies at 6 moments while their leader was quiet: 6 at k times the leader, 0 below it with a recorded clip, rejection, deferral or partial fill, 0 violations, and 0 copies still in motion at the end |
| No signal produced two decisions in one book, and no decision produced two entry orders | held | 239 decisions in 19 chains of book, wallet and coin, 0 breaks, 0 out_of_order records, 0 decisions with two entry orders |
| The simulator recorded no limit refusal that the scenario did not provoke | held | 0 refusals recorded, 0 provoked on purpose, 0 unprovoked |

## Recovery

The killed collectors held 8 wallets (simulated).
Every wallet was subscribed at the simulator again 30.6 s (simulated) after the kill.
Every backfill reported synced 39.7 s (simulated) after the kill.

## Activity

Counted from 2026-10-06T03:19:54.693Z, when the lab added the first wallet.
Every wallet was subscribed at the simulator 0.9 s (simulated) after that, and every backfill reported synced 10 s (simulated) after it.

| Count | Value (simulated) |
|---|---|
| stored fills | 1,202 |
| stream fills | 482 |
| backfilled fills | 0 |
| decisions | 239 |
| catch-up decisions | 0 |
| orders | 214 |
| filled orders | 214 |
| copies opened | 79 |
| copies closed | 76 |

## Decisions by verdict and reason

| Book | Verdict | Reason | Decisions (simulated) |
|---|---|---|---|
| SHADOW | COPY | copied | 214 |
| SHADOW | SKIP | below_min_notional | 22 |
| SHADOW | SKIP | position_not_copied | 2 |
| SHADOW | SKIP | already_at_target | 1 |

## Latency of stream signals

Each step is measured from the timestamps stored in Postgres.
Paper orders are acknowledged after the configured paper latency, so the last two steps show that setting rather than an exchange.

| Step | Samples | p50 ms (simulated) | p90 ms (simulated) | p99 ms (simulated) | max ms (simulated) |
|---|---|---|---|---|---|
| leader fill to collector receive | 477 | 100 | 173 | 200 | 200 |
| collector receive to core store | 477 | 4 | 8 | 35 | 46 |
| collector receive to decision | 236 | 23 | 41.5 | 804.7 | 861 |
| leader fill to decision | 236 | 121.5 | 206 | 848.4 | 907 |
| decision to order submit | 213 | 12 | 23 | 33.9 | 38 |
| order submit to acknowledgement | 213 | 912 | 919 | 923.9 | 925 |
| leader fill to acknowledgement | 213 | 1,046 | 1,141 | 1,806.1 | 1,831 |

## Load

Sampled every 5 s between the end of the initial sync and the end of the run.
The server values are prom-client's event-loop lag p99 and the REST weight the server spent over each minute, the collector value is the p99 each heartbeat reports, and the connection value is the busiest source address at the simulator.

| Measure | Samples | median (simulated) | max (simulated) |
|---|---|---|---|
| server event-loop lag p99, ms | 67 | 10.9 | 13.1 |
| server REST weight spent per minute, budget 400 | 55 | 58 | 70 |
| collector event-loop delay p99, ms | 316 | 20.3 | 20.8 |
| new upstream connections in the last minute, per address | 67 | 0 | 1 |
