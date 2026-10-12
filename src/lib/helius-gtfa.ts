// Own trades via Helius getTransactionsForAddress.
// The tokenTransfer filter returns only transactions where tokens moved in or out of
// this wallet, so other people's trades that merely mention the address (e.g. creator
// fees on a dev wallet's coin) are skipped server side.
// Balances come straight from the transaction meta: real on-chain changes,
// fees and tips included. Only the public address is used.
import type { Swap } from "./helius";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const MAX_SWAPS = 1000;

type TokenBal = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: { amount: string; decimals: number };
};

type FullTx = {
  blockTime?: number;
  transaction: {
    signatures: string[];
    message: { accountKeys: Array<string | { pubkey: string }> };
  };
  meta?: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBal[];
    postTokenBalances?: TokenBal[];
  };
};

const keyOf = (k: string | { pubkey: string }) => (typeof k === "string" ? k : k.pubkey);

function toSwap(tx: FullTx, wallet: string): Swap | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;
  const keys = tx.transaction.message.accountKeys.map(keyOf);
  // only trades the wallet paid for itself
  if (keys[0] !== wallet) return null;

  let sol = (meta.postBalances[0] - meta.preBalances[0]) / 1e9;

  const tokens = new Map<string, number>();
  const add = (list: TokenBal[] | undefined, sign: number) => {
    for (const b of list ?? []) {
      if (b.owner !== wallet || !b.uiTokenAmount) continue;
      const amt = (sign * Number(b.uiTokenAmount.amount)) / 10 ** b.uiTokenAmount.decimals;
      tokens.set(b.mint, (tokens.get(b.mint) ?? 0) + amt);
    }
  };
  add(meta.postTokenBalances, 1);
  add(meta.preTokenBalances, -1);

  const wsol = tokens.get(SOL_MINT);
  if (wsol) sol += wsol;
  tokens.delete(SOL_MINT);

  let best: [string, number] | null = null;
  for (const [mint, d] of tokens) {
    if (Math.abs(d) < 1e-12) continue;
    if (!best || Math.abs(d) > Math.abs(best[1])) best = [mint, d];
  }
  if (!best) return null;
  if (best[1] > 0 && sol >= 0) return null; // tokens in and SOL in: not a trade

  return {
    signature: tx.transaction.signatures[0],
    timestamp: tx.blockTime ?? 0,
    mint: best[0],
    solDelta: sol,
    tokenDelta: best[1],
  };
}

export async function fetchOwnTrades(wallet: string): Promise<Swap[]> {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error("HELIUS_API_KEY is not set");

  const swaps: Swap[] = [];
  const deadline = Date.now() + 15_000;
  let paginationToken: string | undefined;

  for (let page = 0; page < 15 && swaps.length < MAX_SWAPS; page++) {
    const left = deadline - Date.now();
    if (left < 1_500) break;

    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "own-trades",
        method: "getTransactionsForAddress",
        params: [
          wallet,
          {
            transactionDetails: "full",
            encoding: "json",
            maxSupportedTransactionVersion: 1,
            sortOrder: "desc",
            limit: 100,
            ...(paginationToken ? { paginationToken } : {}),
            filters: { status: "succeeded", tokenTransfer: { direction: "any" } },
          },
        ],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(Math.min(10_000, left)),
    }).catch((err) => {
      if (swaps.length > 0) return null; // keep what we have
      throw err;
    });
    if (!res) break;

    const data = await res.json().catch(() => null);
    if (!res.ok || data?.error) {
      const msg = JSON.stringify(data?.error ?? res.status).slice(0, 300);
      console.error(`helius gtfa error for ${wallet}: ${msg}`);
      if (swaps.length > 0) break;
      throw new Error(`helius gtfa error: ${msg}`);
    }

    const items: FullTx[] = data?.result?.data ?? [];
    for (const tx of items) {
      const s = toSwap(tx, wallet);
      if (s) swaps.push(s);
    }
    paginationToken = data?.result?.paginationToken ?? undefined;
    if (!paginationToken || items.length === 0) break;
  }

  return swaps.slice(0, MAX_SWAPS);
}
