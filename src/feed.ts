// Loads the published factory index, tops it up with the blocks it has not reached yet,
// and answers per-token questions (clones, serial deployers) for the feed and the verdict.
import { getAddress, type Address } from "viem";
import { claimsBrand, identityKey, imitates, unicodeTrick, type Canonical, type UnicodeTrick } from "./identity.ts";
import { blockTime, resolveCreators, scanFactory, type CloneStats, type IndexMeta, type Row } from "./indexer.ts";
import type { NetworkId, Rpc } from "./rpc.ts";

const DEFAULT_DATA = "https://raw.githubusercontent.com/bars26/b20-inspector/data/index";

/**
 * Launch contracts whose tokens we can attribute. A label is only shown when the token's own
 * metadata agrees too, so a look-alike contract cannot borrow it.
 */
export const KNOWN_ISSUERS: Record<string, { label: string; uriPrefix: string }> = {
  // Creates Coinbase's tokenized stocks (GTLBc, JNJc, …); their contractURI points at api.coinbase.com.
  "0x4bA3E29E254F25E94E61C4c9d67b37027331534D": { label: "Coinbase tokenized stocks", uriPrefix: "https://api.coinbase.com/" },
};

export interface LoadedIndex {
  meta: IndexMeta;
  /** Last RECENT_DAYS of tokens plus the live tail, newest first. */
  recent: Row[];
  symbols: CloneStats;
  names: CloneStats;
  deployers: Record<string, number>;
  headBlock: number;
}

export interface IndexContext {
  coverageFrom: number;
  coverageFromTime: number;
  /** Tokens (including this one) sharing the normalized symbol / name, and the first of them. */
  symbolClones?: { count: number; first: Address; firstBlock: number; firstTime: number };
  nameClones?: { count: number; first: Address; firstBlock: number; firstTime: number };
  deployerLaunches?: number;
}

const cache = new Map<string, Promise<LoadedIndex>>();

export function loadIndex(rpc: Rpc, dataBase = DEFAULT_DATA): Promise<LoadedIndex> {
  const key = `${rpc.network}|${dataBase}`;
  if (!cache.has(key)) {
    const p = load(rpc, dataBase);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return cache.get(key)!;
}

async function load(rpc: Rpc, dataBase: string): Promise<LoadedIndex> {
  const get = async <T>(f: string): Promise<T> => {
    const r = await fetch(`${dataBase}/${rpc.network}/${f}`, { cache: "no-cache" });
    if (!r.ok) throw new Error(`index file ${f}: HTTP ${r.status}`);
    return r.json();
  };
  const [meta, recent, symbols, names, deployers, head] = await Promise.all([
    get<IndexMeta>("meta.json"),
    get<Row[]>("recent.json"),
    get<CloneStats>("symbols.json"),
    get<CloneStats>("names.json"),
    get<Record<string, number>>("deployers.json"),
    rpc.state.getBlockNumber(),
  ]);

  // The published index trails the chain by up to one cron interval; read the gap directly.
  const tail: Row[] = [];
  if (BigInt(meta.toBlock) < head) {
    try {
      const { rows, hashes } = await scanFactory(rpc, BigInt(meta.toBlock) + 1n, head);
      await resolveCreators(rpc, rows, hashes, 4).catch(() => {});
      tail.push(...rows);
    } catch {
      /* the feed still works from the published index */
    }
  }
  const all = recent.concat(tail.filter((t) => !recent.some((r) => r[0] === t[0])));
  for (const r of tail) {
    bump(symbols, identityKey(r[4]), r);
    bump(names, identityKey(r[3]), r);
    if (r[6] && !r[7]) deployers[r[6]] = (deployers[r[6]] ?? 0) + 1;
  }
  all.sort((a, b) => b[1] - a[1]);
  return { meta, recent: all, symbols, names, deployers, headBlock: Number(head) };
}

function bump(stats: CloneStats, key: string, r: Row) {
  if (!key) return;
  const s = stats[key];
  if (s) s[0]++;
  else stats[key] = [1, r[0], r[1]];
}

/** Clone stats only list keys seen at least twice; a missing key means this token is the only one. */
function clones(stats: CloneStats, key: string, idx: LoadedIndex) {
  const s = stats[key];
  if (!s || s[0] < 2) return undefined;
  return { count: s[0], first: getAddress(s[1]), firstBlock: s[2], firstTime: blockTime(idx.meta, s[2]) };
}

/** `creator` should be passed only for direct launches; behind a launch contract the sender may be a relayer. */
export function contextFor(idx: LoadedIndex, t: { name: string; symbol: string; creator?: Address }): IndexContext {
  return {
    coverageFrom: idx.meta.fromBlock,
    coverageFromTime: blockTime(idx.meta, idx.meta.fromBlock),
    symbolClones: clones(idx.symbols, identityKey(t.symbol), idx),
    nameClones: clones(idx.names, identityKey(t.name), idx),
    deployerLaunches: t.creator ? idx.deployers[t.creator] : undefined,
  };
}

export interface RowFlags {
  imitates?: Canonical;
  trick?: UnicodeTrick;
  clones?: number;
  serial?: number;
  issuer?: string;
  /** Names a platform but was created straight from the factory. */
  brandClaim?: boolean;
}

/** Cheap flags for a feed row, from the index alone (no RPC). */
export function rowFlags(idx: LoadedIndex, r: Row): RowFlags {
  const sym = idx.symbols[identityKey(r[4])];
  return {
    imitates: imitates(r[3], r[4]),
    trick: unicodeTrick(r[4]) ?? unicodeTrick(r[3]),
    clones: sym && sym[0] > 1 ? sym[0] : undefined,
    serial: r[6] && !r[7] ? idx.deployers[r[6]] : undefined,
    // Feed rows have no contractURI, so the label here only says which contract launched it.
    issuer: r[7] ? KNOWN_ISSUERS[r[7]]?.label : undefined,
    brandClaim: !r[7] && claimsBrand(r[3]),
  };
}

export const rowTime = (idx: LoadedIndex, r: Row) => blockTime(idx.meta, r[1]);

export type { NetworkId };
