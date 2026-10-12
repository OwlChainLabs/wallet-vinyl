// Wallet trade history from Solana Tracker. Trades are indexed per trader,
// so it works for busy wallets and trading terminals (Axiom, Photon, ...).
// Only the public address is used.
import type { Swap } from "./helius";
import type { PnlToken } from "./pnl";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const MAX_SWAPS = 1000;

type Side = {
  address: string;
  amount: number;
  token?: { name?: string; symbol?: string };
};

type Trade = {
  tx: string;
  from: Side;
  to: Side;
  volume?: { usd?: number; sol?: number };
  time: number;
};

type Page = { trades?: Trade[]; nextCursor?: number | string; hasNextPage?: boolean };

export function hasSolanaTrackerKey(): boolean {
  return !!process.env.SOLANATRACKER_API_KEY;
}

export async function fetchTradesST(
  wallet: string,
  maxSwaps = MAX_SWAPS
): Promise<{ swaps: Swap[]; names: Record<string, string> }> {
  const key = process.env.SOLANATRACKER_API_KEY;
  if (!key) throw new Error("SOLANATRACKER_API_KEY is not set");

  const swaps: Swap[] = [];
  const names: Record<string, string> = {};
  const deadline = Date.now() + 15_000;
  let cursor: string | undefined;

  for (let page = 0; page < 2 && swaps.length < maxSwaps; page++) {
    const left = deadline - Date.now();
    if (left < 1_500) break;

    const url = new URL(`https://data.solanatracker.io/wallet/${wallet}/trades`);
    if (cursor) url.searchParams.set("cursor", cursor);

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "x-api-key": key },
        cache: "no-store",
        signal: AbortSignal.timeout(Math.min(10_000, left)),
      });
    } catch (err) {
      console.error(`solanatracker timeout for ${wallet}`, err);
      if (swaps.length > 0) break;
      throw new Error("solanatracker timeout");
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`solanatracker ${res.status} for ${wallet}: ${body.slice(0, 300)}`);
      if (swaps.length > 0) break;
      throw new Error(`solanatracker error ${res.status}`);
    }

    const data = (await res.json()) as Page;
    for (const t of data.trades ?? []) {
      const buy = t.from?.address === SOL_MINT;
      const sell = t.to?.address === SOL_MINT;
      if (buy === sell) continue; // skip token <-> token (e.g. USDC) for now

      const tokenSide = buy ? t.to : t.from;
      const solSide = buy ? t.from : t.to;
      const solAmount = t.volume?.sol ?? solSide.amount;
      if (!solAmount || !tokenSide?.address) continue;

      const sym = tokenSide.token?.symbol;
      if (sym) names[tokenSide.address] = `$${sym}`;
      else if (tokenSide.token?.name) names[tokenSide.address] = tokenSide.token.name;

      swaps.push({
        signature: t.tx,
        // time may come in ms or seconds
        timestamp: t.time > 1e12 ? Math.floor(t.time / 1000) : t.time,
        mint: tokenSide.address,
        solDelta: buy ? -solAmount : solAmount,
        tokenDelta: buy ? tokenSide.amount : -tokenSide.amount,
      });
    }

    if (!data.hasNextPage || data.nextCursor == null) break;
    cursor = String(data.nextCursor);
  }

  return { swaps: swaps.slice(0, maxSwaps), names };
}

// Full-history pnl per token (USD). One request, no paging.
export async function fetchPnlST(
  wallet: string,
  timeoutMs = 25_000
): Promise<Record<string, PnlToken>> {
  const key = process.env.SOLANATRACKER_API_KEY;
  if (!key) throw new Error("SOLANATRACKER_API_KEY is not set");
  let res: Response;
  try {
    res = await fetch(`https://data.solanatracker.io/pnl/${wallet}`, {
      headers: { "x-api-key": key },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    console.error(`solanatracker pnl timeout after ${timeoutMs}ms for ${wallet}`);
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`solanatracker pnl ${res.status} for ${wallet}: ${body.slice(0, 300)}`);
    throw new Error(`solanatracker pnl error ${res.status}`);
  }
  const data = await res.json();
  return (data?.tokens ?? {}) as Record<string, PnlToken>;
}
