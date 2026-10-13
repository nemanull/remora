# Scale lab: upstream storm

Every number in this report is simulated.
It comes from the remora images running against hyperliquid-sim on one Docker host, not from Hyperliquid.

- Scenario: The simulator drops every socket 5 times in a minute, and reconnects must stay under 30 a minute per address with nothing lost.
- Run: 2026-10-06 03:04 UTC to 2026-10-06 03:12 UTC
- Host: 20 cores, 31 GB, Linux 6.12.107+deb13-amd64
- Result: every invariant held

## Settings

| Setting | Value |
|---|---|
| collectors | 4 |
| wallets per collector | 8 |
| tracked wallets | 32 |
| socket drops | 5 |
| time between drops, s | 12 |
| simulator speed | 30 |
| simulator REST lag, ms | 5000 |
| run before the storm, minutes | 2 |
| run after the recovery, minutes | 2 |

## Invariants

| Invariant | Result | Checked (simulated) |
|---|---|---|
| No fill of a tracked wallet since its tracked_since is missing from Postgres | held | 450 simulator fills of 32 wallets up to 2026-10-06T03:09:46.420Z compared, 0 missing, 0 unknown |
| Every open copy is within rounding of k times its leader position, and every copy whose leader is flat is closed | held | 8 checks of 5 distinct open copies at 6 moments while their leader was quiet: 8 at k times the leader, 0 below it with a recorded clip, rejection, deferral or partial fill, 0 violations, and 4 copies still in motion at the end |
| No signal produced two decisions in one book, and no decision produced two entry orders | held | 311 decisions in 29 chains of book, wallet and coin, 0 breaks, 0 out_of_order records, 0 decisions with two entry orders |
| The simulator recorded no limit refusal that the scenario did not provoke | held | 0 refusals recorded, 0 provoked on purpose, 0 unprovoked |

## Storm

The simulator dropped 20 sockets over 5 drops (simulated).
The busiest source address opened 4 new connections within one minute, against a limit of 30 (simulated).
Every wallet was subscribed again 28.3 s and every backfill reported synced 28.3 s after the last drop (simulated).

## Activity

Counted from 2026-10-06T03:04:30.447Z, when the lab added the first wallet.
Every wallet was subscribed at the simulator 1.4 s (simulated) after that, and every backfill reported synced 19.5 s (simulated) after it.

| Count | Value (simulated) |
|---|---|
| stored fills | 1,635 |
| stream fills | 616 |
| backfilled fills | 0 |
| decisions | 311 |
| catch-up decisions | 22 |
| orders | 277 |
| filled orders | 277 |
| copies opened | 108 |
| copies closed | 99 |

## Decisions by verdict and reason

| Book | Verdict | Reason | Decisions (simulated) |
|---|---|---|---|
| SHADOW | COPY | copied | 276 |
| SHADOW | SKIP | below_min_notional | 26 |
| SHADOW | SKIP | position_not_copied | 7 |
| SHADOW | SKIP | already_at_target | 1 |
| SHADOW | SKIP | mid_unavailable | 1 |

## Latency of stream signals

Each step is measured from the timestamps stored in Postgres.
Paper orders are acknowledged after the configured paper latency, so the last two steps show that setting rather than an exchange.

| Step | Samples | p50 ms (simulated) | p90 ms (simulated) | p99 ms (simulated) | max ms (simulated) |
|---|---|---|---|---|---|
| leader fill to collector receive | 600 | 102 | 188 | 199 | 203 |
| collector receive to core store | 600 | 3 | 6 | 83 | 265 |
| collector receive to decision | 283 | 18 | 61 | 754.1 | 811 |
| leader fill to decision | 283 | 135 | 217 | 830.8 | 971 |
| decision to order submit | 255 | 11 | 32.6 | 143.7 | 937 |
| order submit to acknowledgement | 255 | 911 | 920 | 969.4 | 1,009 |
| leader fill to acknowledgement | 255 | 1,064 | 1,172.2 | 1,779.3 | 2,065 |

## Load

Sampled every 5 s between the end of the initial sync and the end of the run.
The server values are prom-client's event-loop lag p99 and the REST weight the server spent over each minute, the collector value is the p99 each heartbeat reports, and the connection value is the busiest source address at the simulator.

| Measure | Samples | median (simulated) | max (simulated) |
|---|---|---|---|
| server event-loop lag p99, ms | 63 | 10.9 | 19.2 |
| server REST weight spent per minute, budget 400 | 50 | 74.8 | 88.6 |
| collector event-loop delay p99, ms | 252 | 20.3 | 44.7 |
| new upstream connections in the last minute, per address | 63 | 1 | 4 |
