# Pump.fun Replay Sprint — Paper Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/satscribe-dev/pumpfun-replay-paper-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/satscribe-dev/pumpfun-replay-paper-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Paper trading bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) on make.fun. It trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve activity. Nothing here trades real money.

## Strategy

Pump.fun coins spike within minutes of their first trade and then mostly decay — in the dev window only 35 of 1222 coins completed (migrated), every one at ~85 SOL of real reserve. So the bot:

- **Buys early and small**, the moment the 1%-of-reserve size cap lets it put 0.01 SOL or more in, on coins with positive net buy flow, at least 2 distinct buyers, and price up ≥ 3% since the first trade.
- **Pyramids** into strength (up to 0.20 SOL per coin) while the price keeps rising ≥ 5% above the last buy.
- **Exits whole** on a 25% stop loss vs cost, a 15% trailing stop from the best mark value, or after ~12 hours held.
- **Paces itself** toward the 20-coin guardrail: if coins traded lag the day's pace, it buys 0.01 SOL probes of the most liquid fresh curve and sells them as soon as the buy lands.

Fully deterministic: no clock, no environment, no randomness — every decision comes from the replay stream.

## Run

The grader runs `node main.ts` (Node 22). The bot speaks `agent-fun/replay/v2` on stdin/stdout via the vendored shim in `vendor/makefun-bot.ts` (a byte-identical copy of the kit SDK).

## License

MIT — see [LICENSE](LICENSE).
