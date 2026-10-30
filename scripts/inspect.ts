// Usage: node scripts/inspect.ts <token> [base|base-sepolia]
import { makeRpc, type NetworkId } from "../src/rpc.ts";
import { inspectToken } from "../src/inspect.ts";
const [token, net = "base"] = process.argv.slice(2);
const t0 = Date.now();
const snap = await inspectToken(makeRpc(net as NetworkId), token, (s) => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`));
console.log(JSON.stringify(snap, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.error(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
