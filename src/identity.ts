// Identity checks for B20 names and symbols: lookalike Unicode, copies of well-known assets,
// and a normalized key that groups clones together.
import type { Address } from "viem";

export interface Canonical {
  symbol: string;
  name: string;
  /** Real Base contract; undefined for assets with no token on Base (native BTC, the Base brand). */
  address?: Address;
}

/** Verified on Base mainnet with symbol()/name() on 2026-10-31. All are ERC-20s, so no B20 is ever the real one. */
export const CANONICAL: Canonical[] = [
  { symbol: "USDC", name: "USD Coin", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  { symbol: "WETH", name: "Wrapped Ether", address: "0x4200000000000000000000000000000000000006" },
  { symbol: "cbBTC", name: "Coinbase Wrapped BTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" },
  { symbol: "EURC", name: "EURC", address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" },
  { symbol: "USDT", name: "Tether USD", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" },
  { symbol: "DAI", name: "Dai Stablecoin", address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" },
  { symbol: "USDS", name: "USDS Stablecoin", address: "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc" },
  { symbol: "AERO", name: "Aerodrome", address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631" },
  { symbol: "VIRTUAL", name: "Virtual Protocol", address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b" },
  { symbol: "DEGEN", name: "Degen", address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed" },
  { symbol: "BRETT", name: "Brett", address: "0x532f27101965dd16442E59d40670FaF5eBB142E4" },
  { symbol: "TOSHI", name: "Toshi", address: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4" },
  { symbol: "cbETH", name: "Coinbase Wrapped Staked ETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" },
  { symbol: "wstETH", name: "Wrapped liquid staked Ether 2.0", address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452" },
  { symbol: "ZORA", name: "Zora", address: "0x1111111111166b7FE7bd91427724B487980aFc69" },
  { symbol: "WBTC", name: "Wrapped BTC", address: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c" },
  { symbol: "BTC", name: "Bitcoin" },
  { symbol: "ETH", name: "Ether" },
  { symbol: "SOL", name: "Solana" },
  { symbol: "USD", name: "US Dollar" },
  { symbol: "BASE", name: "Base" },
];

/** Common Cyrillic and Greek letters that render like Latin ones. */
const CONFUSABLES: Record<string, string> = {
  а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", ѕ: "s", і: "i", ј: "j", ԁ: "d", ӏ: "l",
  α: "a", β: "b", ε: "e", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ζ: "z", η: "n",
};

const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/gu;

/** NFKC, lowercase, confusables folded, invisibles, marks, spaces and punctuation removed. */
export function skeleton(s: string): string {
  return [...s.normalize("NFKC").replace(INVISIBLE, "").toLowerCase()]
    .map((ch) => CONFUSABLES[ch] ?? ch)
    .join("")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

/** Grouping key for clone counts. Distinct from skeleton only in name: kept stable for published index files. */
export const identityKey = (s: string) => skeleton(s);

/** The ASCII letters and digits a reader would take away at a glance. */
export const asciiSkeleton = (s: string) => skeleton(s).replace(/[^a-z0-9]/g, "");

export interface UnicodeTrick {
  kind: "invisible" | "mixed-script" | "lookalike" | "styled";
  detail: string;
}

/** Explains why a string would look different from what it is, or returns undefined if it is plain. */
export function unicodeTrick(s: string): UnicodeTrick | undefined {
  if (INVISIBLE.test(s)) {
    INVISIBLE.lastIndex = 0;
    return { kind: "invisible", detail: "contains invisible characters" };
  }
  if ([...s].some((ch) => ch in CONFUSABLES || ch.toLowerCase() in CONFUSABLES) && /\p{Script=Latin}/u.test(s)) {
    return { kind: "lookalike", detail: "mixes Latin letters with Cyrillic or Greek lookalikes" };
  }
  if (s.normalize("NFKC") !== s && /[\p{L}\p{N}]/u.test(s) && asciiSkeleton(s)) {
    return { kind: "styled", detail: "uses styled or full-width letters that wallets may render as plain text" };
  }
  const letters = [...s].filter((ch) => /\p{L}/u.test(ch));
  const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
  const other = letters.length - latin;
  // A Latin word with a stray letter from another script ("USD𖼊") reads as the Latin word.
  if (latin >= 2 && other > 0 && other <= 2) {
    const odd = letters.filter((ch) => !/\p{Script=Latin}/u.test(ch)).join("");
    return { kind: "mixed-script", detail: `adds "${odd}" (U+${odd.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}) to Latin text` };
  }
  return undefined;
}

/** The well-known asset this name or symbol imitates, if any. */
export function imitates(name: string, symbol: string): Canonical | undefined {
  const sym = asciiSkeleton(symbol);
  const nm = asciiSkeleton(name);
  return CANONICAL.find((c) => {
    const cs = asciiSkeleton(c.symbol);
    return sym === cs || (nm.length >= 4 && nm === asciiSkeleton(c.name));
  });
}

const BRANDED = /\b(by virtuals|coinbase|base official|official)\b/i;

/** Names that claim a platform or an official status. Only meaningful for tokens created straight from the factory. */
export const claimsBrand = (name: string) => BRANDED.test(name);
