// Pump.fun Replay Sprint — paper bot (10 SOL, agent-fun/replay/v2).
//
// Idea, in one paragraph: pump.fun coins spike within minutes of their first
// trade and then mostly decay — only a few run to migration (in the dev
// window 35 of 1222 coins completed, every one of them at ~85 SOL of real
// reserve). So this bot buys EARLY and SMALL, the moment the 1%-of-reserve
// size cap lets it put 0.01 SOL or more in, rides the winners with a
// trailing stop, and cuts losers fast so the 5 position slots keep turning
// over. A round trip costs ~3% in curve fees plus tx fees, so entries need
// real buy flow behind them, not just a price print.
//
// Entry (per mint, decided once per batch — the batch that carries its
// trades; orders fill 2 slots later):
//   - size cap >= MIN_BUY (0.01 SOL) and real SOL reserve <= 80 SOL (the
//     migration cluster sits at ~85 SOL in dev data, so stay clear of it);
//   - at least 3 trades seen, net buy SOL over the last 10 trades > 0,
//     at least 2 distinct buyers, price up >= 3% since the first trade;
//   - buy min(cap, INITIAL_STAKE). Pyramid: while spent < TOTAL_STAKE and
//     the price is >= 5% above the last buy's decision price and inflow is
//     still positive, add min(cap, ADD_STAKE).
//
// Exit (sell the whole position on the first trigger):
//   - stop loss: mark value <= 75% of cost;
//   - trailing stop: mark value <= 85% of the best mark value since entry;
//   - time: held longer than MAX_HOLD slots;
//   - probe positions (see below) are sold as soon as their buy lands.
//
// Guardrail pacing: the run must round-trip >= 0.01 SOL on >= 20 coins.
// When coins traded lag the pace (25 coins over ~403k slots), the bot buys
// a 0.01 SOL probe of the most liquid fresh curve in the batch, ignoring
// the flow filters, and sells it the moment the buy fills.
//
// Determinism: no clock, no environment, no Math.random — every decision
// comes from the hello/batch stream, iterated in insertion order.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ params
const SOL = LAMPORTS_PER_SOL;
const MIN_BUY = SOL / 100n; // 0.01 SOL — the guardrail's minimum round trip.
const INITIAL_STAKE = SOL / 20n; // 0.05 SOL first buy.
const ADD_STAKE = SOL / 20n; // 0.05 SOL per pyramid add.
const TOTAL_STAKE = SOL / 5n; // 0.20 SOL most into one coin.
const BUY_SLIPPAGE_BPS = 1_000; // 10% — buys may chase a fast price.
const SELL_SLIPPAGE_BPS = 10_000; // exits must get out.
const STOP_LOSS = 0.75; // sell when value <= 75% of cost.
const TRAIL = 0.85; // sell when value <= 85% of best value since entry.
const TRAIL_ARM = 1.0; // trail arms once value is above cost (always, here).
const MIN_TRADES = 3; // trades seen before an entry is allowed.
const TAPE_LEN = 10; // trades kept per mint for the flow check.
const MIN_BUYERS = 2; // distinct buyers in the tape.
const MIN_RISE = 0.03; // price up >= 3% since the tape's first trade.
const ADD_RISE = 0.05; // pyramid only >= 5% above the last buy's price.
const MAX_HOLD_SLOTS = 200_000; // ~12 h of the 24 h window.
const COOLDOWN_SLOTS = 5_000; // do not rebuy a mint right after exiting.
const NEAR_MIGRATION_SOL = 80n * SOL; // do not buy this close to migrating.
const PROBE_STAKE = MIN_BUY; // 0.01 SOL probe round trip.
const PACE_TARGET_COINS = 25; // coins to trade over the window.
const PACE_WINDOW_SLOTS = 403_000; // ~24 h of slots in the dev window.
const MAX_ORDERS = 16; // hello.caps.max_orders_per_batch.

// ------------------------------------------------------------------ helpers
interface TapeTrade {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Tape {
  mint: Pubkey;
  createdSlot: number;
  firstPrice: number; // SOL per token at the first trade seen.
  trades: TapeTrade[];
}

interface Pos {
  mint: Pubkey;
  entrySlot: number;
  lastBuyPrice: number;
  peakValue: number; // lamports, best mark value since entry.
  probe: boolean;
}

function priceOf(state: BotState, mint: Pubkey): number | null {
  const c = state.curves.get(mint);
  if (c === undefined) return null;
  const vt = Number(c.virtual_token_reserves);
  if (vt <= 0) return null;
  return Number(c.virtual_quote_reserves) / vt;
}

/** Net buy SOL (lamports, buys minus sells) over the tape. */
function tapeNet(tape: Tape): bigint {
  let net = 0n;
  for (const t of tape.trades) net += t.isBuy ? t.sol : -t.sol;
  return net;
}

/** Distinct buyers in the tape. */
function tapeBuyers(tape: Tape): number {
  const s = new Set<Pubkey>();
  for (const t of tape.trades) if (t.isBuy) s.add(t.user);
  return s.size;
}

// ------------------------------------------------------------------ the bot
const tapes = new Map<Pubkey, Tape>();
const positions = new Map<Pubkey, Pos>();
const cooldown = new Map<Pubkey, number>(); // mint -> slot the exit was decided.
let coinsTraded = 0;
let startSlot = -1;
const countedCoins = new Set<Pubkey>();

function noteTrade(mint: Pubkey, slot: number, price: number, isBuy: boolean, sol: bigint, user: Pubkey): void {
  let tape = tapes.get(mint);
  if (tape === undefined) {
    tape = { mint, createdSlot: slot, firstPrice: price, trades: [] };
    tapes.set(mint, tape);
  }
  tape.trades.push({ slot, isBuy, sol, user });
  if (tape.trades.length > TAPE_LEN) tape.trades.shift();
}

await runBot({
  onBatch(state, batch: Batch): OrderInput[] {
    if (startSlot < 0) startSlot = batch.slot;
    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();
    let free = state.freeCashLamports();
    const caps = state.hello.caps;

    // Fold this batch's events into the tapes first.
    for (const e of batch.events) {
      if (e.event === 'TradeEvent') {
        const p = priceOf(state, e.mint);
        if (p !== null) noteTrade(e.mint, e.slot, p, e.is_buy, BigInt(e.sol_amount), e.user);
      } else if (e.event === 'CreateEvent') {
        if (!tapes.has(e.mint)) {
          tapes.set(e.mint, { mint: e.mint, createdSlot: e.slot, firstPrice: 0, trades: [] });
        }
      }
    }

    // Track fills: a buy that landed on a new coin counts it as traded.
    for (const f of batch.fills) {
      if (f.side === 'buy' && f.status === 'filled' && !countedCoins.has(f.mint)) {
        countedCoins.add(f.mint);
        coinsTraded += 1;
      }
      if (f.side === 'sell' && f.status === 'filled') {
        const pos = positions.get(f.mint);
        if (pos !== undefined && state.positions.get(f.mint) === undefined) {
          positions.delete(f.mint);
          cooldown.set(f.mint, batch.slot);
        }
      }
    }

    // Forget positions the harness closed (complete / flatten).
    for (const mint of [...positions.keys()]) {
      if (!state.positions.has(mint) && !state.pending.has(mint)) {
        const hadPendingBuy = [...state.pending.values()].some(
          (p) => p.order.mint === mint && p.order.side === 'buy',
        );
        if (!hadPendingBuy) positions.delete(mint);
      }
    }

    // ---- exits first: they free slots and must not be crowded out. ----
    for (const [mint, holding] of state.positions) {
      const price = priceOf(state, mint);
      if (price === null) continue;
      const value = Number(holding.token_amount) * price;
      const cost = Number(holding.cost_lamports);
      let pos = positions.get(mint);
      if (pos === undefined) {
        pos = { mint, entrySlot: batch.slot, lastBuyPrice: price, peakValue: value, probe: false };
        positions.set(mint, pos);
      }
      if (value > pos.peakValue) pos.peakValue = value;
      const held = batch.slot - pos.entrySlot;
      const stopHit = value <= cost * STOP_LOSS;
      const trailHit = pos.peakValue >= cost * TRAIL_ARM && value <= pos.peakValue * TRAIL;
      const timeHit = held > MAX_HOLD_SLOTS;
      if (pos.probe || stopHit || trailHit || timeHit) {
        if (orders.length < MAX_ORDERS) {
          orders.push({
            side: 'sell',
            mint,
            token_amount: holding.token_amount,
            max_slippage_bps: SELL_SLIPPAGE_BPS,
          });
          positions.delete(mint);
          cooldown.set(mint, batch.slot);
        }
      }
    }

    // ---- entries and pyramids, from this batch's mints only. ----
    const pendingBuys = new Set<Pubkey>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') pendingBuys.add(p.order.mint);
    }
    let slots = caps.max_open_positions - state.committedPositionCount();

    // Pace check: are we behind on distinct coins traded?
    const elapsed = Math.max(0, batch.slot - startSlot);
    const paceTarget = (elapsed / PACE_WINDOW_SLOTS) * PACE_TARGET_COINS;
    const needProbe = coinsTraded + 2 < paceTarget;

    // Candidates in batch order (deterministic: the batch's own order).
    const seenThisBatch: Pubkey[] = [];
    for (const e of batch.events) {
      if (!seenThisBatch.includes(e.mint)) seenThisBatch.push(e.mint);
    }

    for (const mint of seenThisBatch) {
      if (orders.length >= MAX_ORDERS) break;
      if (slots <= 0) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (state.positions.has(mint) || pendingBuys.has(mint)) continue;
      const coolUntil = cooldown.get(mint);
      if (coolUntil !== undefined && batch.slot - coolUntil < COOLDOWN_SLOTS) continue;
      if (curve.real_quote_reserves > NEAR_MIGRATION_SOL) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY) continue;
      const tape = tapes.get(mint);
      if (tape === undefined) continue;

      const price = priceOf(state, mint);
      if (price === null) continue;

      const isProbe = needProbe;
      if (!isProbe) {
        // Flow filters for a real entry.
        if (tape.trades.length < MIN_TRADES) continue;
        if (tapeNet(tape) <= 0n) continue;
        if (tapeBuyers(tape) < MIN_BUYERS) continue;
        const first = tape.firstPrice > 0 ? tape.firstPrice : price;
        if (price < first * (1 + MIN_RISE)) continue;
      }

      const amount = isProbe ? PROBE_STAKE : cap < INITIAL_STAKE ? cap : INITIAL_STAKE;
      if (free < amount + txFee) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      free -= amount + txFee;
      slots -= 1;
      positions.set(mint, {
        mint,
        entrySlot: batch.slot,
        lastBuyPrice: price,
        peakValue: 0,
        probe: isProbe,
      });
    }

    // ---- pyramids into open positions that keep rising. ----
    for (const [mint, holding] of state.positions) {
      if (orders.length >= MAX_ORDERS) break;
      if (pendingBuys.has(mint)) continue;
      const pos = positions.get(mint);
      if (pos === undefined || pos.probe) continue;
      if (holding.cost_lamports >= TOTAL_STAKE) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves > NEAR_MIGRATION_SOL) continue;
      const price = priceOf(state, mint);
      if (price === null) continue;
      if (price < pos.lastBuyPrice * (1 + ADD_RISE)) continue;
      const tape = tapes.get(mint);
      if (tape !== undefined && tapeNet(tape) <= 0n) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < ADD_STAKE) continue;
      const room = TOTAL_STAKE - holding.cost_lamports;
      const amount = cap < ADD_STAKE ? cap : ADD_STAKE < room ? ADD_STAKE : room;
      if (amount < MIN_BUY) continue;
      if (free < amount + txFee) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      free -= amount + txFee;
      pos.lastBuyPrice = price;
    }

    return orders;
  },
});
