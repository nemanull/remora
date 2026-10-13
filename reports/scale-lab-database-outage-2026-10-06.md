# Scale lab: database outage

Every number in this report is simulated.
It comes from the remora images running against hyperliquid-sim on one Docker host, not from Hyperliquid.

- Scenario: Postgres is stopped for 30 s under load, and the sessions must close with 4005, reconnect and backfill with nothing lost.
- Run: 2026-10-06 03:12 UTC to 2026-10-06 03:19 UTC
- Host: 20 cores, 31 GB, Linux 6.12.107+deb13-amd64
- Result: every invariant held

## Settings

| Setting | Value |
|---|---|
| collectors | 4 |
| wallets per collector | 8 |
| tracked wallets | 24 |
| Postgres outage, s | 30 |
| simulator speed | 30 |
| simulator REST lag, ms | 5000 |
| run before the outage, minutes | 2 |
| run after the recovery, minutes | 2 |

## Invariants

| Invariant | Result | Checked (simulated) |
|---|---|---|
| No fill of a tracked wallet since its tracked_since is missing from Postgres | held | 330 simulator fills of 24 wallets up to 2026-10-06T03:17:36.027Z compared, 0 missing, 0 unknown |
| Every open copy is within rounding of k times its leader position, and every copy whose leader is flat is closed | held | 2 checks of 2 distinct open copies at 2 moments while their leader was quiet: 2 at k times the leader, 0 below it with a recorded clip, rejection, deferral or partial fill, 0 violations, and 0 copies still in motion at the end |
| No signal produced two decisions in one book, and no decision produced two entry orders | held | 218 decisions in 19 chains of book, wallet and coin, 0 breaks, 0 out_of_order records, 0 decisions with two entry orders |
| The simulator recorded no limit refusal that the scenario did not provoke | held | 0 refusals recorded, 0 provoked on purpose, 0 unprovoked |

## Outage

Postgres was down from 2026-10-06T03:14:44.717Z to 2026-10-06T03:15:16.770Z (simulated).
The server closed 4 collector sessions with 4005 storage_unavailable (simulated).
Every backfill reported synced 39.2 s after Postgres was back (simulated).

## Activity

Counted from 2026-10-06T03:12:25.675Z, when the lab added the first wallet.
Every wallet was subscribed at the simulator 0.9 s (simulated) after that, and every backfill reported synced 19 s (simulated) after it.

| Count | Value (simulated) |
|---|---|
| stored fills | 1,204 |
| stream fills | 436 |
| backfilled fills | 9 |
| decisions | 218 |
| catch-up decisions | 6 |
| orders | 194 |
| filled orders | 194 |
| copies opened | 72 |
| copies closed | 70 |

## Decisions by verdict and reason

| Book | Verdict | Reason | Decisions (simulated) |
|---|---|---|---|
| SHADOW | COPY | copied | 194 |
| SHADOW | SKIP | below_min_notional | 18 |
| SHADOW | SKIP | position_not_copied | 4 |
| SHADOW | SKIP | already_at_target | 1 |
| SHADOW | SKIP | stale_signal | 1 |

## Latency of stream signals

Each step is measured from the timestamps stored in Postgres.
Paper orders are acknowledged after the configured paper latency, so the last two steps show that setting rather than an exchange.

| Step | Samples | p50 ms (simulated) | p90 ms (simulated) | p99 ms (simulated) | max ms (simulated) |
|---|---|---|---|---|---|
| leader fill to collector receive | 424 | 99 | 179.7 | 198.8 | 200 |
| collector receive to core store | 424 | 2 | 7 | 42 | 171 |
| collector receive to decision | 206 | 19 | 47.5 | 763.8 | 808 |
| leader fill to decision | 206 | 131.5 | 217.5 | 819.1 | 881 |
| decision to order submit | 186 | 11 | 25 | 41.2 | 271 |
| order submit to acknowledgement | 186 | 911 | 918.5 | 925.5 | 930 |
| leader fill to acknowledgement | 186 | 1,056.5 | 1,163.5 | 1,736.2 | 1,792 |

## Load

Sampled every 5 s between the end of the initial sync and the end of the run.
The server values are prom-client's event-loop lag p99 and the REST weight the server spent over each minute, the collector value is the p99 each heartbeat reports, and the connection value is the busiest source address at the simulator.

| Measure | Samples | median (simulated) | max (simulated) |
|---|---|---|---|
| server event-loop lag p99, ms | 62 | 10.7 | 12.5 |
| server REST weight spent per minute, budget 400 | 50 | 58 | 66 |
| collector event-loop delay p99, ms | 216 | 20.3 | 20.8 |
| new upstream connections in the last minute, per address | 62 | 0 | 1 |
