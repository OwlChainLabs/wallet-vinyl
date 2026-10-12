import type { Swap } from "./helius";

export type TokenResult = {
  mint: string;
  name: string;
  solIn: number; // SOL spent buying
  solOut: number; // SOL received selling
  pnl: number; // solOut - solIn (realized, SOL)
  buys: number;
  sells: number;
  holdMinutes: number | null; // first buy to last sell
  stillHolding: boolean;
};

export type Unit = "SOL" | "USD";

export function money(n: number, unit: Unit): string {
  const sign = n >= 0 ? "+" : "-";
  const abs = Math.abs(n);
  if (unit === "USD") {
    const v = abs >= 1000 ? `${(abs / 1000).toFixed(1)}k` : abs.toFixed(0);
    return `${sign}$${v}`;
  }
  return `${sign}${abs.toFixed(2)} SOL`;
}

export type WalletStats = {
  wallet: string;
  unit: Unit; // currency of all pnl numbers
  trades: number;
  tokensTraded: number;
  totalPnl: number;
  winRate: number; // share of closed positions with pnl > 0
  biggestWin: TokenResult | null;
  biggestLoss: TokenResult | null;
  fastestPaperHands: TokenResult | null; // shortest hold that closed in profit
  bagsHeld: number; // tokens bought, never sold
  buyOnly: boolean; // many buys, zero sells: looks like a bot or a wallet that sells elsewhere
  avgBuy: number | null; // average buy size (same unit)
  avgHoldMinutes: number | null;
  firstTrade: number | null;
  lastTrade: number | null;
};

export function computeStats(
  wallet: string,
  swaps: Swap[],
  names: Record<string, string>
): WalletStats {
  const by = new Map<string, TokenResult & { firstBuy?: number; lastSell?: number; tokenNet: number }>();

  for (const s of swaps) {
    let r = by.get(s.mint);
    if (!r) {
      r = {
        mint: s.mint,
        name: names[s.mint] ?? s.mint.slice(0, 4),
        solIn: 0, solOut: 0, pnl: 0, buys: 0, sells: 0,
        holdMinutes: null, stillHolding: false, tokenNet: 0,
      };
      by.set(s.mint, r);
    }
    r.tokenNet += s.tokenDelta;
    if (s.tokenDelta > 0) {
      // buy
      r.solIn += -s.solDelta;
      r.buys++;
      r.firstBuy = Math.min(r.firstBuy ?? s.timestamp, s.timestamp);
    } else {
      r.solOut += s.solDelta;
      r.sells++;
      r.lastSell = Math.max(r.lastSell ?? s.timestamp, s.timestamp);
    }
  }

  const results: TokenResult[] = [];
  for (const r of by.values()) {
    r.pnl = r.solOut - r.solIn;
    r.stillHolding = r.sells === 0 || r.tokenNet > 0;
    if (r.firstBuy && r.lastSell && r.lastSell >= r.firstBuy) {
      r.holdMinutes = (r.lastSell - r.firstBuy) / 60;
    }
    const { firstBuy, lastSell, tokenNet, ...clean } = r;
    void firstBuy; void lastSell; void tokenNet;
    results.push(clean);
  }

  const closed = results.filter((r) => r.buys > 0 && r.sells > 0);
  const wins = closed.filter((r) => r.pnl > 0);
  const sorted = [...closed].sort((a, b) => b.pnl - a.pnl);
  const holds = closed.map((r) => r.holdMinutes).filter((m): m is number => m !== null);
  const paper = wins
    .filter((r) => r.holdMinutes !== null)
    .sort((a, b) => (a.holdMinutes ?? 0) - (b.holdMinutes ?? 0))[0];
  const times = swaps.map((s) => s.timestamp);

  return {
    wallet,
    unit: "SOL",
    trades: swaps.length,
    tokensTraded: results.length,
    // net SOL result: closed positions plus bags never sold counted as lost.
    // tokens only sold (bought before our window) are left out, we do not know their cost.
    totalPnl: results.filter((r) => r.buys > 0).reduce((sum, r) => sum + r.pnl, 0),
    winRate: closed.length ? wins.length / closed.length : 0,
    biggestWin: sorted[0] && sorted[0].pnl > 0 ? sorted[0] : null,
    biggestLoss: sorted.at(-1) && sorted.at(-1)!.pnl < 0 ? sorted.at(-1)! : null,
    fastestPaperHands: paper ?? null,
    bagsHeld: results.filter((r) => r.buys > 0 && r.sells === 0).length,
    buyOnly: swaps.length >= 20 && swaps.every((s) => s.tokenDelta > 0),
    avgBuy: avg(swaps.filter((s) => s.tokenDelta > 0).map((s) => -s.solDelta)),
    avgHoldMinutes: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
    firstTrade: times.length ? Math.min(...times) : null,
    lastTrade: times.length ? Math.max(...times) : null,
  };
}

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

// 1 = disaster, 10 = god-tier. Simple and explainable on purpose.
export function degenScore(s: WalletStats): number {
  if (s.trades === 0) return 0;
  let score = 5;
  score += (s.winRate - 0.5) * 6; // win rate moves it up to ±3
  const scale = s.unit === "USD" ? 2000 : 10; // ~$2k or ~10 SOL per point
  score += Math.max(-2, Math.min(2, s.totalPnl / scale)); // pnl moves it up to ±2
  if (s.bagsHeld > 10) score -= 1;
  return Math.max(1, Math.min(10, Math.round(score)));
}

// Per-token pnl as returned by Solana Tracker (/pnl/{wallet}), values in USD.
export type PnlToken = {
  holding?: number;
  realized?: number;
  total_invested?: number;
  total_sold?: number;
  buy_transactions?: number;
  sell_transactions?: number;
  first_buy_time?: number;
  last_sell_time?: number;
  last_trade_time?: number;
};

const toSec = (t?: number) => (t ? (t > 1e12 ? t / 1000 : t) : undefined);

export function statsFromPnl(
  wallet: string,
  tokens: Record<string, PnlToken>,
  names: Record<string, string>
): WalletStats {
  const results: TokenResult[] = Object.entries(tokens).map(([mint, t]) => {
    const first = toSec(t.first_buy_time);
    const lastSell = toSec(t.last_sell_time);
    return {
      mint,
      name: names[mint] ?? mint.slice(0, 4),
      solIn: t.total_invested ?? 0,
      solOut: t.total_sold ?? 0,
      pnl: t.realized ?? 0,
      buys: t.buy_transactions ?? 0,
      sells: t.sell_transactions ?? 0,
      holdMinutes: first && lastSell && lastSell >= first ? (lastSell - first) / 60 : null,
      stillHolding: (t.holding ?? 0) > 0,
    };
  });

  const closed = results.filter((r) => r.sells > 0);
  const wins = closed.filter((r) => r.pnl > 0);
  const sorted = [...closed].sort((a, b) => b.pnl - a.pnl);
  const holds = closed.map((r) => r.holdMinutes).filter((m): m is number => m !== null);
  const paper = wins
    .filter((r) => r.holdMinutes !== null)
    .sort((a, b) => (a.holdMinutes ?? 0) - (b.holdMinutes ?? 0))[0];
  const times = Object.values(tokens)
    .flatMap((t) => [toSec(t.first_buy_time), toSec(t.last_trade_time)])
    .filter((x): x is number => !!x);

  return {
    wallet,
    unit: "USD",
    trades: results.reduce((n, r) => n + r.buys + r.sells, 0),
    tokensTraded: results.length,
    totalPnl: closed.reduce((sum, r) => sum + r.pnl, 0),
    winRate: closed.length ? wins.length / closed.length : 0,
    biggestWin: sorted[0] && sorted[0].pnl > 0 ? sorted[0] : null,
    biggestLoss: sorted.at(-1) && sorted.at(-1)!.pnl < 0 ? sorted.at(-1)! : null,
    fastestPaperHands: paper ?? null,
    bagsHeld: results.filter((r) => r.buys > 0 && r.sells === 0).length,
    buyOnly: results.length >= 5 && results.every((r) => r.sells === 0),
    avgBuy: (() => {
      const buys = results.reduce((n, r) => n + r.buys, 0);
      return buys ? results.reduce((n, r) => n + r.solIn, 0) / buys : null;
    })(),
    avgHoldMinutes: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
    firstTrade: times.length ? Math.min(...times) : null,
    lastTrade: times.length ? Math.max(...times) : null,
  };
}
