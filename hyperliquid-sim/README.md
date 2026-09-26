# hyperliquid-sim

A stand-in for the part of the Hyperliquid API that remora uses, so the whole system can run offline, at scale and under failure.
Every service reaches it through configuration alone: point `HYPERLIQUID_WS_URL`, `HYPERLIQUID_API_URL` and `STATS_DATA_URL` at it.

## What it serves

| Surface | Contents |
|---|---|
| `GET /ws` | `userFills` with a snapshot of at most 30 fills and `isSnapshot: true`, then one frame per order without `isSnapshot`, `clearinghouseState` every 5 s and after each fill frame, `allMids` every second, acknowledgements with defaults filled in, error frames, ping and pong, and the close of a socket that sent nothing for 60 s |
| `POST /info` | `userFillsByTime` in pages of 2,000 from an inclusive `startTime` within the 10,000 most recent fills, `portfolio`, `clearinghouseState`, `l2Book`, `allMids`, `meta`, `metaAndAssetCtxs`, `candleSnapshot`, `fundingHistory`, `userNonFundingLedgerUpdates`, `orderStatus`, `userAbstraction` and `userRole`, each at Hyperliquid's weight |
| `GET /stats/Mainnet/leaderboard`, `GET /stats/Mainnet/vaults` | the stats-data files with the real schema, built from the synthetic wallets |
| `GET /sim/wallets` | every wallet with its profile, its planted edge and whether it is a vault |
| `GET /sim/fills?wallet=&since=&until=` | every fill of a wallet in a range, without the 10,000-fill horizon |
| `GET /sim/positions?wallet=&at=` | the true positions of one or every wallet |
| `GET /sim/connections` | per source address: open sockets, sockets opened in total and in the last minute, users, subscriptions, sent messages and REST weight |
| `GET /sim/refusals?since=` | every limit refusal with its address and reason, and the count per limit |
| `POST /sim/faults` | `drop_sockets`, `stall_pushes`, `rest_status`, `rest_delay` and `clear`, each optionally for one address |
| `GET /health` | liveness |

## The synthetic market and traders

Thirteen main-dex coins follow a seeded random walk, with a 20-level book around each mid and a constant funding rate.
One of them is isolated-only.
The wallets are swing traders who scale in and trim, scalpers, reckless traders who get liquidated, and vaults listed in the vault file.
A minority carry a planted edge: they pick the side the market is about to move to more often than chance.
Each wallet has a daily account curve of about 200 days behind `portfolio` and the leaderboard, and fills generated per trading slot, so history is computed on demand and nothing is stored.
`SIM_SEED` makes every run reproducible, and `SIM_SPEED` makes the wallets trade that many times more often from the moment the simulator starts.
`SIM_REST_LAG_MS` holds the newest fills back from `userFillsByTime`, as the real REST view lags the live stream.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SIM_SEED` | `1` | seed of every random choice |
| `SIM_WALLETS` | `300` | synthetic wallets |
| `SIM_SPEED` | `1` | trading speed after start, 1 to 100 |
| `SIM_REST_LAG_MS` | `0` | how far `userFillsByTime` lags the stream |
| `SIM_MAX_CONNECTIONS`, `SIM_NEW_CONNECTIONS_PER_MINUTE` | `10`, `30` | per source address |
| `SIM_MAX_USERS`, `SIM_MAX_SUBSCRIPTIONS`, `SIM_MESSAGES_PER_MINUTE` | `10`, `1000`, `2000` | per source address |
| `SIM_WEIGHT_PER_MINUTE` | `1200` | REST weight per source address |
| `HOST`, `PORT` | `127.0.0.1`, `3030` | HTTP and `/ws` |

## Where it guesses

Limits are counted per TCP source address, so every container on a Docker network is its own address.
Hyperliquid's answers to several breaches were never observed, and the simulator answers them as follows.

- Past the connection limit or the new-connection rate it answers the upgrade with HTTP 429.
- Past the user limit it sends `Cannot track more than <n> total users.`, the wording seen on the wire for 15 users, and keeps the socket open.
- Past the subscription limit it sends `Cannot track more than <n> total subscriptions.`, and past the message rate `Too many messages sent. Slow down.`, both as error frames on an open socket.
- Past the REST weight it answers 429 with an empty body.
- `aggregateByTime: true` is accepted but fills are served unaggregated.
- `orderStatus` always answers `unknownOid`, because the simulator has no `/exchange`.
- `userAbstraction` answers `default`, and only the main dex exists.

## Running it

```sh
pnpm --filter hyperliquid-sim build
SIM_SPEED=30 pnpm --filter hyperliquid-sim start:prod
```
