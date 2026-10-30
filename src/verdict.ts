// Turns a TokenSnapshot into what a holder needs to know: who can do what to their balance.
// Pure and synchronous so it can be unit-tested against hand-built snapshots.
import { MAX_SUPPLY_CAP, type RoleName, type ScopeName } from "./b20.ts";
import type { Account, PolicyState, TokenSnapshot } from "./types.ts";

export type Severity = "critical" | "high" | "medium" | "low" | "good";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** Accounts that hold the power now. */
  who?: Account[];
  /** Accounts that do not hold it but can grant it to themselves through the role-admin chain. */
  grantors?: Account[];
}

interface Reach {
  who: Account[];
  grantors: Account[];
  any: boolean;
}

/** immutable: nobody holds any lever. controlled: an issuer holds levers. unknown: history missing and no lever found. */
export type Grade = "immutable" | "controlled" | "unknown";

export interface Verdict {
  grade: Grade;
  risk: Exclude<Severity, "good">;
  headline: string;
  findings: Finding[];
}

const RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, good: 0 };

/** Tickers whose real Base deployments are ERC-20s, so a B20 using them is never the canonical asset. */
const MAJOR_TICKERS = new Set(["BTC", "ETH", "WETH", "CBBTC", "WBTC", "USDC", "USDT", "DAI", "USDS", "EURC", "SOL", "CBETH", "WSTETH"]);
const BRANDED = /\b(by virtuals|coinbase|base official|official)\b/i;

export function judge(s: TokenSnapshot, now = Math.floor(Date.now() / 1000)): Verdict {
  const f: Finding[] = [];
  const holders = (r: RoleName) => s.roles[r]?.holders ?? [];
  const admins = holders("DEFAULT_ADMIN_ROLE");

  /** Accounts that hold `role`, and those that can grant it to themselves through its admin chain. */
  const reach = (role: RoleName): Reach => {
    const who = holders(role);
    const grantors = new Map<string, Account>();
    const seen = new Set<string>([role]);
    let cur: string = s.roles[role]?.adminRole ?? role;
    while (!seen.has(cur)) {
      seen.add(cur);
      const st = s.roles[cur as RoleName];
      if (!st) break; // admin role is a custom hash we do not track
      for (const a of st.holders) if (!who.some((w) => w.address === a.address)) grantors.set(a.address, a);
      cur = st.adminRole;
    }
    const g = [...grantors.values()];
    return { who, grantors: g, any: who.length + g.length > 0 };
  };
  /** A power deserves its own finding when someone holds it, or can reach it other than as DEFAULT_ADMIN (already reported). */
  const live = (r: Reach) => r.who.length > 0 || r.grantors.some((g) => !admins.some((a) => a.address === g.address));
  const people = (r: Reach) => ({ who: r.who.length ? r.who : undefined, grantors: r.grantors.length ? r.grantors : undefined });

  // --- Root control ---
  if (admins.length) {
    const singleKey = admins.length === 1 && admins[0].kind !== "contract";
    f.push({
      id: "admin",
      severity: "high",
      title: singleKey ? "A single wallet has full admin control" : "Admin control is held",
      detail:
        "DEFAULT_ADMIN_ROLE can grant any role, change transfer policies and raise the supply cap at any time. " +
        (singleKey ? "It is held by one externally owned key, so one compromised key controls the token." : "Check whether the holder is a multisig or timelock."),
      who: admins,
    });
  }

  // --- Supply ---
  const minters = reach("MINT_ROLE");
  const uncapped = s.supplyCap >= MAX_SUPPLY_CAP;
  if (live(minters)) {
    const capRaisable = admins.length > 0;
    f.push({
      id: "mint",
      severity: uncapped || capRaisable ? "high" : "medium",
      title: uncapped ? "New supply can be minted without limit" : "New supply can be minted",
      detail: uncapped
        ? "There is no supply cap, so holders can be diluted at will."
        : `Minting is limited by a supply cap with ${pct(s.supplyCap - s.totalSupply, s.supplyCap)} headroom` +
          (capRaisable ? ", but an admin can raise the cap." : "."),
      ...people(minters),
    });
  } else if (s.historyComplete || admins.length) {
    f.push({
      id: "fixed-supply",
      severity: "good",
      title: admins.length ? "Nobody can mint right now" : "Supply is fixed",
      detail: admins.length ? "No account holds MINT_ROLE, though an admin could grant it." : "No account holds or can obtain MINT_ROLE.",
    });
  }

  // --- Seizure ---
  const seizers = reach("SEIZE_ROLE");
  const exempt = s.policies.SEIZE_EXEMPT_POLICY;
  const holdersSeizable = exempt && !exempt.defaultAuthorized;
  if (live(seizers) && holdersSeizable) {
    f.push({
      id: "seize",
      severity: "critical",
      title: "Balances can be seized",
      detail: "SEIZE_ROLE can move tokens out of any wallet that the seize-exempt policy does not protect, and ordinary wallets are not protected.",
      ...people(seizers),
    });
  } else if (live(seizers)) {
    f.push({
      id: "seize-dormant",
      severity: admins.length ? "medium" : "low",
      title: "Seizure is set up but currently blocked",
      detail:
        "An account holds SEIZE_ROLE, but the seize-exempt policy protects every wallet today." +
        (admins.length ? " An admin can switch that policy and enable seizing." : ""),
      ...people(seizers),
    });
  }
  if (s.seizures.count) {
    f.push({
      id: "seized-before",
      severity: "high",
      title: `Seized ${s.seizures.count} time${s.seizures.count > 1 ? "s" : ""} already`,
      detail: `Tokens have been moved out of holder wallets by the issuer (${fmt(s.seizures.total, s.decimals)} ${s.symbol} in total).`,
    });
  }
  const blockedBurners = reach("BURN_BLOCKED_ROLE");
  if (live(blockedBurners)) {
    f.push({
      id: "burn-blocked",
      severity: "high",
      title: "Blocked holders' balances can be burned",
      detail: "BURN_BLOCKED_ROLE (deprecated, still callable) can destroy the balance of any address the transfer policy blocks.",
      ...people(blockedBurners),
    });
  }

  // --- Pause ---
  if (s.pausedFeatures.length) {
    const transfers = s.pausedFeatures.includes("TRANSFER");
    f.push({
      id: "paused-now",
      severity: transfers ? "critical" : "high",
      title: transfers ? "Transfers are paused right now" : `Paused right now: ${s.pausedFeatures.join(", ")}`,
      detail: transfers ? "Nobody can send this token until an unpauser lifts the pause." : "Some token operations are frozen.",
      ...people(reach("UNPAUSE_ROLE")),
    });
  }
  const pausers = reach("PAUSE_ROLE");
  if (live(pausers)) {
    f.push({
      id: "pause",
      severity: "high",
      title: "Transfers can be frozen for everyone",
      detail: "PAUSE_ROLE can halt all transfers (and minting, burning or seizing) in one call.",
      ...people(pausers),
    });
  }

  // --- Transfer policies ---
  const scopes: [ScopeName, string][] = [
    ["TRANSFER_SENDER_POLICY", "sending"],
    ["TRANSFER_RECEIVER_POLICY", "receiving"],
    ["TRANSFER_EXECUTOR_POLICY", "submitting transfers"],
  ];
  const gates = new Map<string, { p: PolicyState; uses: string[] }>();
  for (const [scope, use] of scopes) {
    const p = s.policies[scope];
    if (!p || p.id === 0n) continue;
    const key = p.id.toString();
    if (!gates.has(key)) gates.set(key, { p, uses: [] });
    gates.get(key)!.uses.push(use);
  }
  for (const { p, uses } of gates.values()) f.push(policyFinding(p, uses, s.symbol));
  if (!gates.size && admins.length) {
    f.push({
      id: "no-transfer-policy",
      severity: "low",
      title: "No transfer restrictions today",
      detail: "Any wallet can send and receive, but an admin can attach a blocklist or allowlist at any time.",
    });
  }

  // --- Metadata & display ---
  const editors = reach("METADATA_ROLE");
  if (live(editors)) {
    f.push({
      id: "metadata",
      severity: "medium",
      title: "Name and symbol can be changed",
      detail: "METADATA_ROLE can rename the token, which wallets and explorers will display.",
      ...people(editors),
    });
  }
  if (s.renames.count && s.creation) {
    f.push({
      id: "renamed",
      severity: "medium",
      title: "Renamed since creation",
      detail: `Launched as "${s.creation.initialName}" (${s.creation.initialSymbol}).`,
    });
  }
  if (s.variant === "ASSET") {
    const operators = reach("OPERATOR_ROLE");
    if (live(operators)) {
      f.push({
        id: "operator",
        severity: "medium",
        title: "Displayed balances can be rescaled",
        detail: "OPERATOR_ROLE can change the UI multiplier (as in a stock split) and post announcements. Raw balances do not change, but what wallets show does.",
        ...people(operators),
      });
    }
    const m = s.multiplier;
    if (m && m.pending !== m.current && m.effectiveAt > BigInt(now)) {
      f.push({
        id: "multiplier-scheduled",
        severity: "high",
        title: "A balance rescale is scheduled",
        detail: `Displayed balances will change by ×${ratio(m.pending, m.current)} on ${new Date(Number(m.effectiveAt) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC.`,
      });
    }
  }

  // --- Identity ---
  if (MAJOR_TICKERS.has(s.symbol.toUpperCase().replace(/[^A-Z]/g, ""))) {
    f.push({
      id: "impersonation-ticker",
      severity: "critical",
      title: `Not the real ${s.symbol}`,
      detail: `The canonical ${s.symbol} on Base is a standard ERC-20, never a B20 token. Anything under this ticker on a 0xb2… address is a copy.`,
    });
  } else if (BRANDED.test(s.name) && s.creation && !s.creation.via) {
    f.push({
      id: "impersonation-brand",
      severity: "high",
      title: "Claims a brand but was created directly",
      detail: `"${s.name}" names a platform, but the token was created straight from the factory by a wallet, not through that platform's contract.`,
    });
  }

  // --- No levers ---
  const levers = f.some((x) => ["admin", "mint", "seize", "seize-dormant", "burn-blocked", "pause", "metadata", "operator"].includes(x.id) || x.id.startsWith("policy-"));
  if (!levers && s.historyComplete) {
    f.push({
      id: "ownerless",
      severity: "good",
      title: s.lastAdminRenounced ? "Admin was renounced" : "Created without an admin",
      detail: "No account holds any role, and no role can ever be granted again. The token's rules are final.",
    });
  }
  if (!s.historyComplete) {
    f.push({
      id: "history-missing",
      severity: "low",
      title: "Role history could not be read in full",
      detail:
        "The public log provider does not serve blocks this old. Roles held by the creator were checked directly, but other accounts granted roles earlier would not show up.",
    });
  }

  f.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const grade: Grade = levers ? "controlled" : s.historyComplete ? "immutable" : "unknown";
  const worst = f.find((x) => x.severity !== "good")?.severity ?? "low";
  const risk = worst === "good" ? "low" : worst;
  return { grade, risk, headline: headline(grade, f), findings: f };
}

function policyFinding(p: PolicyState, uses: string[], symbol: string): Finding {
  const what = uses.includes("sending") && uses.includes("receiving") ? "transferring" : uses.join(" and ");
  const id = `policy-${p.id}`;
  const notTag = p.inverted ? " (inverted)" : "";
  if (!p.exists) {
    return {
      id,
      severity: p.defaultAuthorized ? "medium" : "critical",
      title: `Policy #${p.id} on ${what} does not exist`,
      detail: p.defaultAuthorized
        ? "The token points at an unassigned policy ID that currently lets everyone through. Whoever later creates that ID decides who can trade."
        : `The token points at an unassigned policy ID that blocks every wallet from ${what} ${symbol}.`,
    };
  }
  const listed = p.members === null ? "" : ` It lists ${p.members.length} address${p.members.length === 1 ? "" : "es"}.`;
  const owner = p.admin ? "" : " Nobody can change the list any more.";
  if (!p.defaultAuthorized) {
    return {
      id,
      severity: "high",
      title: `Only approved wallets can do ${what}`,
      detail: `Policy #${p.id}${notTag} (${p.type?.toLowerCase() ?? "unknown"}) rejects ordinary wallets; a holder must be added by the policy admin.${listed}${owner}`,
      who: p.admin ? [p.admin] : undefined,
    };
  }
  return {
    id,
    severity: p.admin ? "medium" : "low",
    title: p.admin ? `Individual wallets can be blocked from ${what}` : `A fixed blocklist applies to ${what}`,
    detail: `Policy #${p.id}${notTag} (${p.type?.toLowerCase() ?? "unknown"}) lets ordinary wallets through, but its admin can add any address and freeze it in place.${listed}${owner}`,
    who: p.admin ? [p.admin] : undefined,
  };
}

function headline(grade: Grade, f: Finding[]): string {
  if (grade === "immutable") return "Ownerless: nobody can change this token's rules.";
  if (grade === "unknown") return "No issuer powers found, but older history is missing.";
  const powers: string[] = [];
  const has = (...ids: string[]) => f.some((x) => ids.includes(x.id));
  if (has("mint")) powers.push("mint");
  if (has("seize", "burn-blocked")) powers.push("seize");
  if (has("pause")) powers.push("pause");
  if (f.some((x) => x.id.startsWith("policy-"))) powers.push("block wallets");
  if (has("metadata")) powers.push("rename");
  if (has("operator")) powers.push("rescale");
  if (!powers.length) return has("admin") ? "An admin can grant itself any power at any time." : "Issuer-controlled token.";
  return `The issuer can ${list(powers)}.`;
}

const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

function pct(part: bigint, whole: bigint) {
  if (whole === 0n) return "0%";
  return `${(Number((part * 10_000n) / whole) / 100).toLocaleString("en-US")}%`;
}

function ratio(a: bigint, b: bigint) {
  return b === 0n ? "∞" : (Number((a * 10_000n) / b) / 10_000).toString();
}

export function fmt(v: bigint, decimals: number) {
  const s = v.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, "").slice(0, 4) : "";
  return BigInt(int).toLocaleString("en-US") + (frac ? `.${frac}` : "");
}
