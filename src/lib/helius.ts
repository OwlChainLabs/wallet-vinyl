// Reads public swap history for a wallet via the Helius Enhanced Transactions API.
// Only the public address is used. No keys, no signing.

const SOL_MINT = "So11111111111111111111111111111111111111112";

export type Swap = {
  signature: string;
  timestamp: number; // unix seconds
  mint: string; // the non-SOL token
  solDelta: number; // SOL received (+) or spent (-) by the wallet
  tokenDelta: number; // token received (+) or sent (-)
};

type TokenTransfer = {
  fromUserAccount?: string;
  toUserAccount?: string;
  mint: string;
  tokenAmount: number;
};

type NativeTransfer = {
  fromUserAccount?: string;
  toUserAccount?: string;
  amount: number; // lamports
};

type TokenBalanceChange = {
  userAccount?: string;
  mint: string;
  rawTokenAmount?: { tokenAmount: string; decimals: number };
};

type AccountData = {
  account: string;
  nativeBalanceChange?: number; // lamports
  tokenBalanceChanges?: TokenBalanceChange[];
};

type EnhancedTx = {
  signature: string;
  timestamp: number;
  type: string;
  feePayer?: string;
  accountData?: AccountData[];
  tokenTransfers?: TokenTransfer[];
  nativeTransfers?: NativeTransfer[];
};

function key(): string {
  const k = process.env.HELIUS_API_KEY;
  if (!k) throw new Error("HELIUS_API_KEY is not set");
  return k;
}

// Turn one transaction into a "wallet swapped SOL <-> token" record using the real
// balance changes of the wallet (works no matter which terminal or parser was used).
// SOL change includes fees, tips and account rent: that is what the trade really cost.
// Wrapped SOL counts as SOL.
function toSwap(tx: EnhancedTx, wallet: string): Swap | null {
  // only transactions the wallet signed itself; skips other people's trades
  // that merely mention this address (e.g. dev wallets of active coins)
  if (tx.feePayer && tx.feePayer !== wallet) return null;

  let sol = 0;
  const tokens = new Map<string, number>();

  for (const a of tx.accountData ?? []) {
    if (a.account === wallet) sol += (a.nativeBalanceChange ?? 0) / 1e9;
    for (const c of a.tokenBalanceChanges ?? []) {
      if (c.userAccount !== wallet || !c.rawTokenAmount) continue;
      const amt = Number(c.rawTokenAmount.tokenAmount) / 10 ** c.rawTokenAmount.decimals;
      if (c.mint === SOL_MINT) sol += amt;
      else tokens.set(c.mint, (tokens.get(c.mint) ?? 0) + amt);
    }
  }

  // keep the token with the biggest move
  let best: [string, number] | null = null;
  for (const [mint, d] of tokens) {
    if (d === 0) continue;
    if (!best || Math.abs(d) > Math.abs(best[1])) best = [mint, d];
  }
  if (!best) return null;
  // buy: token in, SOL out. sell: token out, SOL in (or ~0 for dust sells after fees).
  // token in AND SOL in makes no sense as a trade (airdrop + refund), skip it.
  if (best[1] > 0 && sol >= 0) return null;

  return {
    signature: tx.signature,
    timestamp: tx.timestamp,
    mint: best[0],
    solDelta: sol,
    tokenDelta: best[1],
  };
}

// Fetch the latest transactions unfiltered (fast even for busy wallets)
// and pick out the swaps ourselves. Up to `maxPages` pages of 100 tx.
// how many recent swaps we look at (keeps it fast and cheap)
const MAX_SWAPS = 1000;

export async function fetchSwaps(wallet: string, maxPages = 12): Promise<Swap[]> {
  const swaps: Swap[] = [];
  let before: string | undefined;
  let beforeParam = "before";

  // hard budget for the whole search, every request must finish inside it
  const deadline = Date.now() + 15_000;
  const remaining = () => deadline - Date.now();

  for (let page = 0; page < maxPages; page++) {
    if (remaining() < 1_500) break;
    const url = new URL(`https://api.helius.xyz/v0/addresses/${wallet}/transactions`);
    url.searchParams.set("api-key", key());
    url.searchParams.set("limit", "100");
    if (before) url.searchParams.set(beforeParam, before);

    let res: Response;
    try {
      res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(Math.min(8_000, remaining())) });
      // free tier rate limit: wait a moment and try once more if there is time
      if (res.status === 429 && remaining() > 3_000) {
        await new Promise((r) => setTimeout(r, 1_000));
        res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(Math.min(8_000, remaining())) });
      }
    } catch (err) {
      // timed out: roast what we have, or give up if we have nothing
      console.error(`helius timeout for ${wallet}`, err);
      if (swaps.length > 0) break;
      throw new Error("helius timeout");
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Busy wallets: Helius stops when a window has no swaps and tells us
      // where to continue ("...with the `before-signature` parameter set to <sig>").
      const next = body.match(/`([a-z-]+)` parameter set to ([1-9A-HJ-NP-Za-km-z]{60,100})/i);
      if (next) {
        beforeParam = next[1];
        before = next[2];
        continue;
      }
      console.error(`helius ${res.status} for ${wallet}: ${body.slice(0, 300)}`);
      // keep what we already have instead of failing the whole roast
      if (swaps.length > 0) break;
      throw new Error(`helius error ${res.status}`);
    }

    const txs = (await res.json()) as EnhancedTx[];
    if (!Array.isArray(txs) || txs.length === 0) break;

    for (const tx of txs) {
      const s = toSwap(tx, wallet);
      if (s) swaps.push(s);
    }
    before = txs[txs.length - 1].signature;
    if (swaps.length >= MAX_SWAPS) break;
    if (txs.length < 100) break;
  }
  return swaps.slice(0, MAX_SWAPS);
}

// Look up token names/symbols for a list of mints (Helius DAS).
export async function fetchTokenNames(mints: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (mints.length === 0) return out;

  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "names",
      method: "getAssetBatch",
      params: { ids: mints.slice(0, 100) },
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  // names are nice to have, never block the roast on them
  if (!res || !res.ok) return out;
  const data = await res.json().catch(() => null);
  for (const a of data?.result ?? []) {
    if (!a?.id) continue;
    const sym = a?.content?.metadata?.symbol || a?.token_info?.symbol;
    const name = a?.content?.metadata?.name;
    out[a.id] = sym ? `$${sym}` : name || a.id.slice(0, 4);
  }
  return out;
}
