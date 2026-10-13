# Scale lab: user limit

Every number in this report is simulated.
It comes from the remora images running against hyperliquid-sim on one Docker host, not from Hyperliquid.

- Scenario: Two collectors of 6 wallets share one source address, so that address asks for 12 users against the limit of 10, and the core must lower the refused capacity and move the rest.
- Run: 2026-10-06 03:27 UTC to 2026-10-06 03:33 UTC
- Host: 20 cores, 31 GB, Linux 6.12.107+deb13-amd64
- Result: every invariant held

## Settings

| Setting | Value |
|---|---|
| collectors | 1 and 2 with 6 wallets each on one address, 3 with 8 on its own, started later |
| tracked wallets | 12 |
| simulator user limit per address | 10 |
| simulator speed | 30 |
| simulator REST lag, ms | 5000 |
| run after the move, minutes | 6 |

## Invariants

| Invariant | Result | Checked (simulated) |
|---|---|---|
| No fill of a tracked wallet since its tracked_since is missing from Postgres | held | 191 simulator fills of 12 wallets up to 2026-10-06T03:33:08.921Z compared, 0 missing, 0 unknown |
| Every open copy is within rounding of k times its leader position, and every copy whose leader is flat is closed | held | 1 checks of 1 distinct open copies at 1 moments while their leader was quiet: 1 at k times the leader, 0 below it with a recorded clip, rejection, deferral or partial fill, 0 violations, and 0 copies still in motion at the end |
| No signal produced two decisions in one book, and no decision produced two entry orders | held | 108 decisions in 8 chains of book, wallet and coin, 0 breaks, 0 out_of_order records, 0 decisions with two entry orders |
| The simulator recorded no limit refusal that the scenario did not provoke | held | 4 refusals recorded, 4 provoked on purpose (users), 0 unprovoked |

## Refusal and move

The simulator refused 4 user subscriptions on the shared address (simulated).
2 wallets waited for a collector after the refusals, and 2 of them were on collector 3 once it came up (simulated).

| Collector | wallets after the refusals (simulated) | wallets after the move (simulated) |
|---|---|---|
| 1 | 5 | 5 |
| 2 | 5 | 5 |
| 3 | 0 | 2 |

## Users per source address after the move

| Address | users (simulated) |
|---|---|
| 172.22.0.7 | 10 |
| 172.22.0.8 | 2 |

## Activity

Counted from 2026-10-06T03:27:16.544Z, when the lab added the first wallet.
Every wallet was subscribed at the simulator 2.3 s (simulated) after that, and every backfill reported synced 12.4 s (simulated) after it.

| Count | Value (simulated) |
|---|---|
| stored fills | 564 |
| stream fills | 204 |
| backfilled fills | 0 |
| decisions | 108 |
| catch-up decisions | 0 |
| orders | 95 |
| filled orders | 95 |
| copies opened | 35 |
| copies closed | 34 |

## Decisions by verdict and reason

| Book | Verdict | Reason | Decisions (simulated) |
|---|---|---|---|
| SHADOW | COPY | copied | 95 |
| SHADOW | SKIP | below_min_notional | 12 |
| SHADOW | SKIP | position_not_copied | 1 |

## Latency of stream signals

Each step is measured from the timestamps stored in Postgres.
Paper orders are acknowledged after the configured paper latency, so the last two steps show that setting rather than an exchange.

| Step | Samples | p50 ms (simulated) | p90 ms (simulated) | p99 ms (simulated) | max ms (simulated) |
|---|---|---|---|---|---|
| leader fill to collector receive | 200 | 111.5 | 184 | 200 | 201 |
| collector receive to core store | 200 | 3 | 6 | 30 | 40 |
| collector receive to decision | 106 | 22.5 | 38 | 766.1 | 794 |
| leader fill to decision | 106 | 139.5 | 216.5 | 817.6 | 886 |
| decision to order submit | 94 | 10 | 21 | 28.1 | 29 |
| order submit to acknowledgement | 94 | 912 | 916 | 921 | 921 |
| leader fill to acknowledgement | 94 | 1,064 | 1,143 | 1,750.4 | 1,809 |

## Load

Sampled every 5 s between the end of the initial sync and the end of the run.
The server values are prom-client's event-loop lag p99 and the REST weight the server spent over each minute, the collector value is the p99 each heartbeat reports, and the connection value is the busiest source address at the simulator.

| Measure | Samples | median (simulated) | max (simulated) |
|---|---|---|---|
| server event-loop lag p99, ms | 71 | 10.7 | 11.9 |
| server REST weight spent per minute, budget 400 | 59 | 28 | 42.5 |
| collector event-loop delay p99, ms | 213 | 20.3 | 21.2 |
| new upstream connections in the last minute, per address | 71 | 0 | 2 |
