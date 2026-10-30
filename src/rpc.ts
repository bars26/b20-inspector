import { createPublicClient, fallback, http, type AbiEvent, type Address, type Log, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";

export type NetworkId = "base" | "base-sepolia";

interface NetworkConfig {
  chain: typeof base | typeof baseSepolia;
  /** Latest-state reads. */
  stateRpcs: string[];
  /** Historical eth_call (binary search for creation blocks). Must serve archive state. */
  archiveRpcs: string[];
  /** eth_getLogs with an address filter. `chunk` is the widest block span the endpoint accepts. */
  logsRpc: { url: string; chunk: number };
  /** No B20 exists before this block (a little before the Beryl activation). */
  b20Floor: bigint;
  explorer: string;
}

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  base: {
    chain: base,
    stateRpcs: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
    archiveRpcs: ["https://base.drpc.org", "https://mainnet.base.org"],
    logsRpc: { url: "https://base-rpc.publicnode.com", chunk: 50_000 },
    b20Floor: 47_700_000n, // Beryl: 2026-06-25
    explorer: "https://basescan.org",
  },
  "base-sepolia": {
    chain: baseSepolia,
    stateRpcs: ["https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org"],
    archiveRpcs: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"],
    logsRpc: { url: "https://base-sepolia-rpc.publicnode.com", chunk: 50_000 },
    b20Floor: 46_500_000n, // Beryl: 2026-06-18
    explorer: "https://sepolia.basescan.org",
  },
};

export interface RpcOverrides {
  rpc?: string;
  logsRpc?: string;
  chunk?: number;
}

/** Thrown when the log provider will not serve the requested range (e.g. pruned history without an archive key). */
export class HistoryUnavailableError extends Error {
  fromBlock: bigint;
  constructor(fromBlock: bigint, cause: string) {
    super(`Event history from block ${fromBlock} is not available from the log provider: ${cause}`);
    this.fromBlock = fromBlock;
  }
}

export interface Rpc {
  network: NetworkId;
  config: NetworkConfig;
  state: PublicClient;
  archive: PublicClient;
  logs: PublicClient;
  chunk: bigint;
}

export function makeRpc(network: NetworkId, o: RpcOverrides = {}): Rpc {
  const config = NETWORKS[network];
  // Each endpoint is tried once; on a 429 or error the fallback moves straight to the next one
  // and only then cycles back, which spreads bursts across the free providers.
  const mk = (urls: string[], retryCount = 3) =>
    createPublicClient({
      chain: config.chain,
      transport: fallback(urls.map((u) => http(u, { retryCount: 0 })), { retryCount, retryDelay: 500 }),
      batch: { multicall: false },
    }) as PublicClient;
  const custom = o.rpc ? [o.rpc] : [];
  return {
    network,
    config,
    state: mk([...custom, ...config.stateRpcs]),
    archive: mk([...custom, ...config.archiveRpcs]),
    // getLogsChunked retries on its own and must see history errors immediately.
    logs: mk([o.logsRpc ?? custom[0] ?? config.logsRpc.url], 0),
    chunk: BigInt(o.chunk ?? (o.logsRpc || o.rpc ? 10_000 : config.logsRpc.chunk)),
  };
}

/**
 * Smallest block in [lo, hi] where `pred` holds, assuming pred is monotone (false…false true…true).
 * Samples `fanout` points per round in parallel, so ~log_{fanout+1}(hi-lo) round trips.
 */
export async function findFirstBlock(
  lo: bigint,
  hi: bigint,
  pred: (block: bigint) => Promise<boolean>,
  fanout = 3,
): Promise<bigint> {
  while (hi - lo > 0n) {
    const span = hi - lo;
    const step = span / BigInt(fanout + 1) || 1n;
    const points: bigint[] = [];
    for (let p = lo + step; p < hi && points.length < fanout; p += step) points.push(p);
    if (points.length === 0) points.push(lo);
    const results = await Promise.all(points.map(pred));
    const firstTrue = results.indexOf(true);
    if (firstTrue === -1) lo = points[points.length - 1] + 1n;
    else {
      hi = points[firstTrue];
      if (firstTrue > 0) lo = points[firstTrue - 1] + 1n;
      else if (points[0] === lo) break;
    }
  }
  return hi;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isHistoryError(e: unknown) {
  const msg = (e as Error)?.message ?? String(e);
  // publicnode answers old ranges with an "archive … personal token" error, or a bare HTTP 403.
  return (e as { status?: number })?.status === 403 || /archive|pruned|missing trie|history|not available|personal token|dedicated|Status: 403/i.test(msg);
}

/** eth_getLogs over [from, to] split into provider-sized chunks, a few in flight at a time. */
export async function getLogsChunked<E extends AbiEvent>(
  rpc: Rpc,
  args: { address: Address; events: readonly E[]; fromBlock: bigint; toBlock: bigint; args?: Record<string, unknown> },
  concurrency = 4,
): Promise<Log[]> {
  const ranges: [bigint, bigint][] = [];
  for (let f = args.fromBlock; f <= args.toBlock; f += rpc.chunk) {
    const t = f + rpc.chunk - 1n;
    ranges.push([f, t > args.toBlock ? args.toBlock : t]);
  }
  const out: Log[][] = new Array(ranges.length);
  let next = 0;
  async function worker() {
    while (next < ranges.length) {
      const i = next++;
      const [fromBlock, toBlock] = ranges[i];
      for (let attempt = 0; ; attempt++) {
        try {
          out[i] = (await rpc.logs.getLogs({
            address: args.address,
            events: args.events as unknown as AbiEvent[],
            args: args.args as never,
            fromBlock,
            toBlock,
            strict: false,
          })) as Log[];
          break;
        } catch (e) {
          if (isHistoryError(e)) throw new HistoryUnavailableError(fromBlock, ((e as Error).message ?? String(e)).split("\n")[0]);
          if (attempt >= 4) throw e;
          await sleep(500 * 2 ** attempt);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ranges.length) }, worker));
  return out.flat().sort((a, b) =>
    a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0) : Number(a.blockNumber! - b.blockNumber!),
  );
}
