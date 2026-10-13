# Scale lab: scale

Every number in this report is simulated.
It comes from the remora images running against hyperliquid-sim on one Docker host, not from Hyperliquid.

- Scenario: 12 collectors hold 96 wallets that trade 10 times faster than in the baseline, to load ingestion, decisions and the server event loop.
- Run: 2026-10-06 03:37 UTC to 2026-10-06 03:49 UTC
- Host: 20 cores, 31 GB, Linux 6.12.107+deb13-amd64
- Result: every invariant held

## Settings

| Setting | Value |
|---|---|
| collectors | 12 |
| wallets per collector | 8 |
| tracked wallets | 96 |
| simulator speed | 100 |
| simulator REST lag, ms | 5000 |
| run after the initial sync, minutes | 10 |
| server REST budget per minute | 400 |
| of which paper book reads | 120 |
| paper order latency, ms | 900 |

## Invariants

| Invariant | Result | Checked (simulated) |
|---|---|---|
| No fill of a tracked wallet since its tracked_since is missing from Postgres | held | 10471 simulator fills of 96 wallets up to 2026-10-06T03:47:37.109Z compared, 0 missing, 0 unknown |
| Every open copy is within rounding of k times its leader position, and every copy whose leader is flat is closed | held | 112 checks of 74 distinct open copies at 19 moments while their leader was quiet: 74 at k times the leader, 38 below it with a recorded clip, rejection, deferral or partial fill, 0 violations, and 46 copies still in motion at the end |
| No signal produced two decisions in one book, and no decision produced two entry orders | held | 5245 decisions in 170 chains of book, wallet and coin, 0 breaks, 0 out_of_order records, 0 decisions with two entry orders |
| The simulator recorded no limit refusal that the scenario did not provoke | held | 0 refusals recorded, 0 provoked on purpose, 0 unprovoked |

## Activity

Counted from 2026-10-06T03:37:32.564Z, when the lab added the first wallet.
Every wallet was subscribed at the simulator 2.4 s (simulated) after that, and every backfill reported synced 24.5 s (simulated) after it.

| Count | Value (simulated) |
|---|---|
| stored fills | 16,019 |
| stream fills | 13,139 |
| backfilled fills | 0 |
| decisions | 5,245 |
| catch-up decisions | 7 |
| orders | 923 |
| filled orders | 870 |
| copies opened | 394 |
| copies closed | 325 |

## Decisions by verdict and reason

| Book | Verdict | Reason | Decisions (simulated) |
|---|---|---|---|
| SHADOW | COPY | copied | 916 |
| SHADOW | COPY | stale_signal | 3 |
| SHADOW | SKIP | position_not_copied | 2,691 |
| SHADOW | SKIP | stale_signal | 1,522 |
| SHADOW | SKIP | already_at_target | 61 |
| SHADOW | SKIP | below_min_notional | 52 |

## Latency of stream signals

Each step is measured from the timestamps stored in Postgres.
Paper orders are acknowledged after the configured paper latency, so the last two steps show that setting rather than an exchange.

| Step | Samples | p50 ms (simulated) | p90 ms (simulated) | p99 ms (simulated) | max ms (simulated) |
|---|---|---|---|---|---|
| leader fill to collector receive | 12,846 | 103 | 181 | 199 | 202 |
| collector receive to core store | 12,846 | 6 | 17 | 55 | 332 |
| collector receive to decision | 5,170 | 46,279 | 89,142.3 | 133,533.8 | 150,823 |
| leader fill to decision | 5,170 | 46,392 | 89,292.1 | 133,598.1 | 150,985 |
| decision to order submit | 860 | 10 | 21 | 34.4 | 43,243 |
| order submit to acknowledgement | 807 | 45,597 | 51,385 | 54,950.3 | 56,461 |
| leader fill to acknowledgement | 807 | 56,221 | 104,202.8 | 153,241.4 | 170,980 |

## Load

Sampled every 5 s between the end of the initial sync and the end of the run.
The server values are prom-client's event-loop lag p99 and the REST weight the server spent over each minute, the collector value is the p99 each heartbeat reports, and the connection value is the busiest source address at the simulator.

| Measure | Samples | median (simulated) | max (simulated) |
|---|---|---|---|
| server event-loop lag p99, ms | 119 | 11.7 | 13.8 |
| server REST weight spent per minute, budget 400 | 107 | 120 | 129.2 |
| collector event-loop delay p99, ms | 1,428 | 20.4 | 20.8 |
| new upstream connections in the last minute, per address | 119 | 0 | 1 |
