// Builds or extends the factory index for one network.
// Usage: node scripts/build-index.ts <out-dir> [base|base-sepolia] [--max-blocks N]
// Reads <out-dir>/<network>/tokens.json if present and continues from its last block.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeRpc, type NetworkId } from "../src/rpc.ts";
import { ENTRY_POINTS, derive, firstReadableBlock, resolveCreators, scanFactory, type IndexMeta, type Row } from "../src/indexer.ts";

const [outDir, net = "base", ...rest] = process.argv.slice(2);
if (!outDir) throw new Error("usage: build-index.ts <out-dir> [network] [--max-blocks N]");
const maxBlocks = rest[0] === "--max-blocks" ? BigInt(rest[1]) : undefined;
const network = net as NetworkId;
const rpc = makeRpc(network);
const dir = join(outDir, network);
mkdirSync(dir, { recursive: true });

const log = (...a: unknown[]) => console.error(`[${network}]`, ...a);
const read = <T>(f: string): T | undefined => (existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), "utf8")) : undefined);
const write = (f: string, v: unknown) => writeFileSync(join(dir, f), JSON.stringify(v));

const prevMeta = read<IndexMeta>("meta.json");
let rows = read<Row[]>("tokens.json") ?? [];

// Stay a few blocks behind head so a sequencer reorg cannot leave phantom rows.
const head = (await rpc.state.getBlockNumber()) - 5n;
let fromBlock: bigint;
if (prevMeta) fromBlock = BigInt(prevMeta.toBlock) + 1n;
else {
  fromBlock = await firstReadableBlock(rpc, rpc.config.b20Floor, head);
  log("history starts at block", fromBlock);
}
const coverageFrom = prevMeta ? prevMeta.fromBlock : Number(fromBlock);
let toBlock = maxBlocks && head - fromBlock > maxBlocks ? fromBlock + maxBlocks - 1n : head;

if (fromBlock > toBlock) {
  log("up to date");
} else {
  const t0 = Date.now();
  const { rows: fresh, hashes } = await scanFactory(rpc, fromBlock, toBlock);
  log(`scanned ${fromBlock}..${toBlock}: ${fresh.length} new tokens in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const t1 = Date.now();
  await resolveCreators(rpc, fresh, hashes);
  log(`resolved creators in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  const known = new Set(rows.map((r) => r[0]));
  rows = rows.concat(fresh.filter((r) => !known.has(r[0])));
}
if (fromBlock > toBlock) toBlock = BigInt(prevMeta?.toBlock ?? Number(head));

// Rows indexed before bundles were understood credit the bundler; re-resolve them from the receipt.
const bundled = rows.filter((r) => ENTRY_POINTS.has(r[7]));
if (bundled.length) {
  const hashes = new Map<string, `0x${string}`>();
  for (const r of bundled) {
    // One block at a time, gently: this runs once over a backlog and must not trip rate limits.
    await new Promise((res) => setTimeout(res, 150));
    const { hashes: h } = await scanFactory(rpc, BigInt(r[1]), BigInt(r[1]));
    const hash = h.get(r[0]);
    if (hash) hashes.set(r[0], hash);
    else r[7] = ""; // creation log no longer readable: leave the creator unknown rather than retry forever
    r[6] = "";
  }
  await resolveCreators(rpc, bundled, hashes);
  log(`re-resolved ${bundled.length} tokens created through 4337 bundles`);
}

const anchorBlock = await rpc.state.getBlock({ blockNumber: toBlock });
const meta: IndexMeta = {
  network,
  fromBlock: coverageFrom,
  toBlock: Number(toBlock),
  count: rows.length,
  updatedAt: new Date().toISOString(),
  anchor: { block: Number(toBlock), timestamp: Number(anchorBlock.timestamp) },
};
const d = derive(rows, meta.toBlock);
write("tokens.json", rows);
write("recent.json", d.recent);
write("symbols.json", d.symbols);
write("names.json", d.names);
write("deployers.json", d.deployers);
write("meta.json", meta);
log(`wrote ${rows.length} tokens (${d.recent.length} recent, ${Object.keys(d.symbols).length} cloned symbols, ${Object.keys(d.deployers).length} serial deployers)`);
