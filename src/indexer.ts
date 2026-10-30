// Factory index: every B20Created event, with the creating wallet and launch contract.
// The node script (scripts/build-index.ts) builds it; the browser reads the published files
// and tops them up with the blocks the index has not reached yet.
import { getAddress, parseAbiItem, toEventSelector, type Address, type Log } from "viem";
import { B20_FACTORY, factoryAbi } from "./b20.ts";
import { HistoryUnavailableError, getLogsChunked, isHistoryError, type NetworkId, type Rpc } from "./rpc.ts";
import { identityKey } from "./identity.ts";

/** [address, block, variant (0 asset, 1 stablecoin), name, symbol, decimals, creator, via ("" when direct)] */
export type Row = [Address, number, 0 | 1, string, string, number, Address | "", Address | ""];

export interface IndexMeta {
  network: NetworkId;
  /** First block the index covers; earlier history was not readable from the log provider. */
  fromBlock: number;
  toBlock: number;
  count: number;
  updatedAt: string;
  /** Block/timestamp pair; Base blocks are exactly 2s apart, so any block's time follows from it. */
  anchor: { block: number; timestamp: number };
}

/** Clone counts keyed by identityKey: [count, first token, first block]. */
export type CloneStats = Record<string, [number, Address, number]>;

export const RECENT_DAYS = 7;
const BLOCKS_PER_DAY = 43_200;
/** Deployers below this many launches are left out of deployers.json. */
export const SERIAL_MIN = 3;

export const blockTime = (meta: Pick<IndexMeta, "anchor">, block: number) => meta.anchor.timestamp + (block - meta.anchor.block) * 2;

const createdEvent = factoryAbi.filter((x) => x.type === "event");

/** First block the log provider still serves, found once to know where the free history begins. */
export async function firstReadableBlock(rpc: Rpc, start: bigint, head: bigint): Promise<bigint> {
  // Binary search on "a one-chunk getLogs from here succeeds"; history availability is monotone.
  let lo = start, hi = head;
  while (hi - lo > rpc.chunk) {
    const mid = lo + (hi - lo) / 2n;
    try {
      await rpc.logs.getLogs({ address: B20_FACTORY, fromBlock: mid, toBlock: mid });
      hi = mid;
    } catch (e) {
      if (!isHistoryError(e)) throw e;
      lo = mid + 1n;
    }
  }
  return hi;
}

/** ERC-4337 EntryPoints (v0.6, v0.7, v0.8). A transaction sent to one is a bundle: its sender is a bundler, not the creator. */
export const ENTRY_POINTS = new Set<string>([
  "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
  "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
]);
const USER_OP_EVENT = toEventSelector(
  parseAbiItem("event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"),
);

/**
 * Fill creator and via, a few lookups at a time. creator is the transaction sender and via the
 * contract it called when that was not the factory. For a 4337 bundle the creator is the smart
 * account from the single UserOperationEvent, or left unknown ("") when the bundle held several.
 */
export async function resolveCreators(rpc: Rpc, rows: Row[], hashes: Map<string, `0x${string}`>, concurrency = 6) {
  const todo = rows.filter((r) => !r[6] && hashes.has(r[0]));
  let next = 0;
  const factory = getAddress(B20_FACTORY);
  async function worker() {
    while (next < todo.length) {
      const r = todo[next++];
      const hash = hashes.get(r[0]);
      if (!hash) continue;
      for (let attempt = 0; ; attempt++) {
        try {
          const tx = await rpc.archive.getTransaction({ hash });
          const to = tx.to ? getAddress(tx.to) : "";
          if (ENTRY_POINTS.has(to)) {
            const receipt = await rpc.archive.getTransactionReceipt({ hash });
            const ops = receipt.logs.filter((l) => getAddress(l.address) === to && l.topics[0] === USER_OP_EVENT);
            r[6] = ops.length === 1 ? getAddress(`0x${ops[0].topics[2]!.slice(26)}`) : "";
            r[7] = "";
          } else {
            r[6] = getAddress(tx.from);
            r[7] = to && to !== factory ? to : "";
          }
          break;
        } catch (e) {
          if (attempt >= 5) throw e;
          await new Promise((res) => setTimeout(res, 400 * 2 ** attempt));
        }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

/** B20Created logs in [from, to] as rows (creator/via empty), plus each token's creation tx hash for resolveCreators. */
export async function scanFactory(rpc: Rpc, from: bigint, to: bigint) {
  const logs = (await getLogsChunked(rpc, { address: B20_FACTORY, events: createdEvent, fromBlock: from, toBlock: to })) as (Log & { args: any })[];
  const hashes = new Map<string, `0x${string}`>();
  const rows = logs.map((l) => {
    const token = getAddress(l.args.token);
    hashes.set(token, l.transactionHash!);
    return [token, Number(l.blockNumber), Number(l.args.variant) === 1 ? 1 : 0, l.args.name ?? "", l.args.symbol ?? "", Number(l.args.decimals ?? 0), "", ""] as Row;
  });
  return { rows, hashes };
}

export interface Derived {
  recent: Row[];
  symbols: CloneStats;
  names: CloneStats;
  deployers: Record<string, number>;
}

/** Files the browser loads, computed from the full row list (sorted by block). */
export function derive(rows: Row[], toBlock: number): Derived {
  const symbols: CloneStats = {};
  const names: CloneStats = {};
  const deployers: Record<string, number> = {};
  const bump = (stats: CloneStats, key: string, r: Row) => {
    if (!key) return;
    const s = stats[key];
    if (s) s[0]++;
    else stats[key] = [1, r[0], r[1]];
  };
  for (const r of rows) {
    bump(symbols, identityKey(r[4]), r);
    bump(names, identityKey(r[3]), r);
    // Only direct launches count: behind a launch contract the sender is often the platform's relayer.
    if (r[6] && !r[7]) deployers[r[6]] = (deployers[r[6]] ?? 0) + 1;
  }
  // Only collisions and serial deployers are interesting; dropping the rest keeps the files small.
  for (const stats of [symbols, names]) for (const k of Object.keys(stats)) if (stats[k][0] < 2) delete stats[k];
  for (const k of Object.keys(deployers)) if (deployers[k] < SERIAL_MIN) delete deployers[k];
  const since = toBlock - RECENT_DAYS * BLOCKS_PER_DAY;
  return { recent: rows.filter((r) => r[1] > since), symbols, names, deployers };
}

export { HistoryUnavailableError };
