// Builds a wallet's record: one groove per token it traded, in order of first trade.
// Trade data comes from the same libs as wallet-roast (Helius, Solana Tracker as fallback).
// Only the public address is used.
import { fetchSwaps, fetchTokenNames, type Swap } from "./lib/helius";
import { fetchOwnTrades } from "./lib/helius-gtfa";
import { fetchTradesST, hasSolanaTrackerKey } from "./lib/solanatracker";
import { isValidWallet } from "./lib/validate";

export type Groove = { token: string; size: number; pnl: number; t: number };
export type Record = {
  wallet: string;
  source: string;
  grooves: Groove[];
  title: string;
  tracks: { [token: string]: string };
  error?: string;
};

const MAX_GROOVES = 120;

async function loadSwaps(wallet: string): Promise<{ swaps: Swap[]; names: { [m: string]: string }; source: string }> {
  let swaps: Swap[] = [];
  let names: { [m: string]: string } = {};
  let source = "none";
  if (process.env.HELIUS_API_KEY) {
    try {
      source = "helius-gtfa";
      swaps = await fetchOwnTrades(wallet);
    } catch {
      source = "helius-enhanced";
      swaps = await fetchSwaps(wallet).catch(() => [] as Swap[]);
    }
  }
  if (swaps.length < 5 && hasSolanaTrackerKey()) {
    const st = await fetchTradesST(wallet, 1000).catch(() => ({ swaps: [] as Swap[], names: {} }));
    if (st.swaps.length > swaps.length) {
      swaps = st.swaps;
      names = st.names;
      source = "solanatracker";
    }
  }
  return { swaps, names, source };
}

// one groove per token: SOL spent is the size, SOL out minus SOL in is the pnl.
// coins never sold count as lost, same as wallet-roast.
function toGrooves(swaps: Swap[], names: { [m: string]: string }): Groove[] {
  const by = new Map<string, { spent: number; got: number; t: number }>();
  for (const s of [...swaps].sort((a, b) => a.timestamp - b.timestamp)) {
    const g = by.get(s.mint) ?? { spent: 0, got: 0, t: s.timestamp };
    if (s.solDelta < 0) g.spent += -s.solDelta;
    else g.got += s.solDelta;
    by.set(s.mint, g);
  }
  const out = [...by.entries()]
    .filter(([, g]) => g.spent > 0.001)
    .map(([m, g]) => ({ token: names[m] ?? m.slice(0, 4) + "…", size: g.spent, pnl: g.got - g.spent, t: g.t, mint: m }))
    .sort((a, b) => a.t - b.t)
    .slice(-MAX_GROOVES);
  return out.map(({ token, size, pnl, t }) => ({ token, size: +size.toFixed(4), pnl: +pnl.toFixed(4), t }));
}

const SYSTEM = `You name records. A crypto trader's wallet was pressed on a vinyl record. You get their biggest wins and losses.
Write a funny album title and a track name for each listed coin, like a real tracklist. Roast the trading, never the person.
Rules: only use the coins and numbers given. No slurs, nothing about looks, race, gender, religion or anything personal. No financial advice. No emojis.
Album title: max 6 words, a real joke (e.g. "Songs in the Key of Rug", "Exit Liquidity (Deluxe Edition)").
Track names: max 6 words each, must include the coin name (e.g. "BONK (I Should Have Sold)").
Answer with JSON only: {"title":"...","tracks":{"COIN":"track name", ...}}`;

async function nameAlbum(grooves: Groove[]): Promise<{ title: string; tracks: { [k: string]: string } }> {
  const key = process.env.ANTHROPIC_API_KEY;
  const top = [...grooves].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)).slice(0, 5);
  const fallback = { title: "Untitled Trades", tracks: {} as { [k: string]: string } };
  if (!key || !top.length) return fallback;
  const net = grooves.reduce((a, g) => a + g.pnl, 0);
  const wins = grooves.filter((g) => g.pnl > 0).length;
  const facts = [
    `tokens traded: ${grooves.length}`,
    `net pnl: ${net.toFixed(2)} SOL (unsold coins count as lost)`,
    `win rate: ${Math.round((wins / grooves.length) * 100)}%`,
    ...top.map((g) => `${g.token}: ${g.pnl >= 0 ? "+" : ""}${g.pnl.toFixed(2)} SOL on ${g.size.toFixed(2)} SOL in`),
  ].join("\n");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5",
        max_tokens: 800,
        output_config: { effort: "low" },
        system: SYSTEM,
        messages: [{ role: "user", content: facts }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return fallback;
    const data: any = await res.json();
    const text: string = (data?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return { title: String(json.title || fallback.title).slice(0, 80), tracks: json.tracks ?? {} };
  } catch {
    return fallback;
  }
}

export async function buildRecord(wallet: string): Promise<Record> {
  if (!isValidWallet(wallet)) return { wallet, source: "none", grooves: [], title: "", tracks: {}, error: "invalid wallet" };
  const { swaps, names, source } = await loadSwaps(wallet);
  const missing = [...new Set(swaps.map((s) => s.mint))].filter((m) => !names[m]);
  if (missing.length && process.env.HELIUS_API_KEY) Object.assign(names, await fetchTokenNames(missing).catch(() => ({})));
  const grooves = toGrooves(swaps, names);
  if (grooves.length < 3) return { wallet, source, grooves, title: "", tracks: {}, error: "not enough trades" };
  const album = await nameAlbum(grooves);
  return { wallet, source, grooves, ...album };
}
