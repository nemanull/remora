# Scale lab: core restart

Every number in this report is simulated.
It comes from the remora images running against hyperliquid-sim on one Docker host, not from Hyperliquid.

- Scenario: The server is restarted gracefully and then killed under load, and watermarks and catch-ups must recover every fill without a duplicate decision.
- Run: 2026-10-06 02:54 UTC to 2026-10-06 03:04 UTC
- Host: 20 cores, 31 GB, Linux 6.12.107+deb13-amd64
- Result: every invariant held

## Settings

| Setting | Value |
|---|---|
| collectors | 4 |
| wallets per collector | 8 |
| tracked wallets | 32 |
| simulator speed | 30 |
| simulator REST lag, ms | 10000 |
| run before, between and after the restarts, minutes | 2 |

## Invariants

| Invariant | Result | Checked (simulated) |
|---|---|---|
| No fill of a tracked wallet since its tracked_since is missing from Postgres | held | 610 simulator fills of 32 wallets up to 2026-10-06T03:01:49.963Z compared, 0 missing, 0 unknown |
| Every open copy is within rounding of k times its leader position, and every copy whose leader is flat is closed | held | 13 checks of 6 distinct open copies at 6 moments while their leader was quiet: 13 at k times the leader, 0 below it with a recorded clip, rejection, deferral or partial fill, 0 violations, and 4 copies still in motion at the end |
| No signal produced two decisions in one book, and no decision produced two entry orders | held | 391 decisions in 34 chains of book, wallet and coin, 0 breaks, 0 out_of_order records, 0 decisions with two entry orders |
| The simulator recorded no limit refusal that the scenario did not provoke | held | 0 refusals recorded, 0 provoked on purpose, 0 unprovoked |

## Restarts

Down is the time from the stop until the server answered /health again.
Synced is the time from the stop until every backfill reported synced in a heartbeat of the new session.

| Restart | down, s (simulated) | synced, s (simulated) |
|---|---|---|
| graceful restart with SIGTERM | 2.7 | 23.8 |
| crash with SIGKILL and a fresh start | 2.8 | 24.9 |

## Activity

Counted from 2026-10-06T02:55:02.213Z, when the lab added the first wallet.
Every wallet was subscribed at the simulator 0.9 s (simulated) after that, and every backfill reported synced 19 s (simulated) after it.

| Count | Value (simulated) |
|---|---|
| stored fills | 1,810 |
| stream fills | 832 |
| backfilled fills | 18 |
| decisions | 391 |
| catch-up decisions | 10 |
| orders | 348 |
| filled orders | 344 |
| copies opened | 133 |
| copies closed | 124 |

## Decisions by verdict and reason

| Book | Verdict | Reason | Decisions (simulated) |
|---|---|---|---|
| SHADOW | COPY | copied | 346 |
| SHADOW | SKIP | below_min_notional | 36 |
| SHADOW | SKIP | position_not_copied | 8 |
| SHADOW | SKIP | already_at_target | 1 |

## Latency of stream signals

Each step is measured from the timestamps stored in Postgres.
Paper orders are acknowledged after the configured paper latency, so the last two steps show that setting rather than an exchange.

| Step | Samples | p50 ms (simulated) | p90 ms (simulated) | p99 ms (simulated) | max ms (simulated) |
|---|---|---|---|---|---|
| leader fill to collector receive | 813 | 102 | 177 | 197 | 200 |
| collector receive to core store | 813 | 3 | 7 | 21 | 153 |
| collector receive to decision | 377 | 16 | 29 | 546.4 | 745 |
| leader fill to decision | 377 | 122 | 199 | 689.3 | 889 |
| decision to order submit | 338 | 5 | 9 | 32.8 | 107 |
| order submit to acknowledgement | 337 | 905 | 910 | 1,321.1 | 3,087 |
| leader fill to acknowledgement | 337 | 1,037 | 1,114.8 | 1,776 | 3,147 |

## Load

Sampled every 5 s between the end of the initial sync and the end of the run.
The server values are prom-client's event-loop lag p99 and the REST weight the server spent over each minute, the collector value is the p99 each heartbeat reports, and the connection value is the busiest source address at the simulator.

| Measure | Samples | median (simulated) | max (simulated) |
|---|---|---|---|
| server event-loop lag p99, ms | 80 | 10.8 | 17 |
| server REST weight spent per minute, budget 400 | 40 | 80 | 186 |
| collector event-loop delay p99, ms | 304 | 20.3 | 20.8 |
| new upstream connections in the last minute, per address | 81 | 0 | 1 |
