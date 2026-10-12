// Solana addresses are base58, 32 to 44 characters.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidWallet(input: string): boolean {
  return BASE58.test(input.trim());
}

export function shortAddr(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

// short stable id for a piece of text, used to bust caches (x keeps link previews per url)
export function shortHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
