// Usage: node scripts/judge.ts <token>... — prints the verdict for each token on Base mainnet.
import { makeRpc } from "../src/rpc.ts";
import { inspectToken } from "../src/inspect.ts";
import { judge } from "../src/verdict.ts";
const rpc = makeRpc("base");
for (const t of process.argv.slice(2)) {
  const t0 = Date.now();
  try {
    const s = await inspectToken(rpc, t);
    const v = judge(s);
    console.log(`\n${s.name} (${s.symbol}) — ${v.grade}/${v.risk} — ${v.headline}  [${((Date.now() - t0) / 1000).toFixed(1)}s, history ${s.historyComplete ? "full" : "partial"}, via ${s.creation?.via ?? "factory"}]`);
    for (const f of v.findings) console.log(`  ${f.severity.padEnd(8)} ${f.title}${f.who ? "  ← " + f.who.map((a) => a.address.slice(0, 8) + "/" + a.kind).join(", ") : ""}${f.grantors ? "  (grantable by " + f.grantors.map((a) => a.address.slice(0, 8)).join(", ") + ")" : ""}`);
  } catch (e) { console.log(`\n${t} ERROR ${(e as Error).message.split("\n")[0]}`); }
}
