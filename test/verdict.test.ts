import { describe, expect, it } from "vitest";
import { MAX_SUPPLY_CAP, ROLE_NAMES, SCOPE_NAMES, type RoleName } from "../src/b20.ts";
import type { Account, PolicyState, TokenSnapshot } from "../src/types.ts";
import { fmt, judge } from "../src/verdict.ts";

const EOA: Account = { address: "0x1111111111111111111111111111111111111111", kind: "eoa" };
const SAFE: Account = { address: "0x2222222222222222222222222222222222222222", kind: "contract" };

const allow0: PolicyState = { id: 0n, inverted: false, type: "BLOCKLIST", exists: true, members: null, defaultAuthorized: true };

function snap(over: Partial<TokenSnapshot> = {}, roles: Partial<Record<RoleName, Account[]>> = {}): TokenSnapshot {
  return {
    network: "base",
    address: "0xb200000000000000000000b5adfbfc0edcefc0d4",
    variant: "ASSET",
    name: "Meme",
    symbol: "MEME",
    decimals: 18,
    totalSupply: 10n ** 27n,
    supplyCap: 10n ** 27n,
    pausedFeatures: [],
    creation: { block: 1n, timestamp: 0, txHash: "0x00", from: EOA.address, initialName: "Meme", initialSymbol: "MEME" },
    historyComplete: true,
    roles: Object.fromEntries(ROLE_NAMES.map((r) => [r, { holders: roles[r] ?? [], adminRole: "DEFAULT_ADMIN_ROLE" }])) as TokenSnapshot["roles"],
    lastAdminRenounced: false,
    policies: Object.fromEntries(SCOPE_NAMES.map((s) => [s, allow0])) as TokenSnapshot["policies"],
    seizures: { count: 0, total: 0n },
    renames: { count: 0 },
    announcements: 0,
    headBlock: 2n,
    ...over,
  };
}

const ids = (v: ReturnType<typeof judge>) => v.findings.map((f) => f.id);

describe("judge", () => {
  it("calls an adminless, fully-minted launchpad token immutable", () => {
    const v = judge(snap());
    expect(v.grade).toBe("immutable");
    expect(ids(v)).toContain("ownerless");
    expect(ids(v)).toContain("fixed-supply");
    expect(v.headline).toMatch(/Ownerless/);
  });

  it("refuses to call it immutable when history is missing", () => {
    const v = judge(snap({ historyComplete: false }));
    expect(v.grade).toBe("unknown");
    expect(ids(v)).toContain("history-missing");
    expect(ids(v)).not.toContain("ownerless");
  });

  it("flags a single EOA admin and unlimited mint", () => {
    const v = judge(snap({ supplyCap: MAX_SUPPLY_CAP }, { DEFAULT_ADMIN_ROLE: [EOA], MINT_ROLE: [SAFE] }));
    expect(v.grade).toBe("controlled");
    const admin = v.findings.find((f) => f.id === "admin")!;
    expect(admin.title).toMatch(/single wallet/);
    const mint = v.findings.find((f) => f.id === "mint")!;
    expect(mint.title).toMatch(/without limit/);
    expect(mint.severity).toBe("high");
  });

  it("treats a role as reachable through its admin chain", () => {
    const s = snap({}, { BURN_ROLE: [EOA] });
    s.roles.MINT_ROLE.adminRole = "BURN_ROLE";
    s.roles.DEFAULT_ADMIN_ROLE.holders = [];
    const mint = judge(s).findings.find((f) => f.id === "mint")!;
    expect(mint.who).toBeUndefined();
    expect(mint.grantors).toEqual([EOA]);
  });

  it("caps mint severity when the supply cap is binding and no admin can raise it", () => {
    const s = snap({ totalSupply: 50n, supplyCap: 100n }, { MINT_ROLE: [SAFE] });
    const mint = judge(s).findings.find((f) => f.id === "mint")!;
    expect(mint.severity).toBe("medium");
    expect(mint.detail).toContain("50% headroom");
  });

  it("only reports active seizure when ordinary wallets are not exempt", () => {
    const dormant = judge(snap({}, { SEIZE_ROLE: [EOA] }));
    expect(ids(dormant)).toContain("seize-dormant");
    expect(ids(dormant)).not.toContain("seize");

    const exposed = snap({}, { SEIZE_ROLE: [EOA] });
    exposed.policies = { ...exposed.policies, SEIZE_EXEMPT_POLICY: { ...allow0, id: 7n, type: "ALLOWLIST", defaultAuthorized: false, members: [] } };
    const v = judge(exposed);
    expect(v.findings[0].id).toBe("seize");
    expect(v.risk).toBe("critical");
  });

  it("leaves powers only DEFAULT_ADMIN could grant to the admin finding", () => {
    const v = judge(snap({}, { DEFAULT_ADMIN_ROLE: [EOA] }));
    expect(ids(v)).toEqual(expect.arrayContaining(["admin", "fixed-supply", "no-transfer-policy"]));
    expect(ids(v)).not.toContain("seize-dormant");
    expect(ids(v)).not.toContain("pause");
    expect(v.headline).toBe("An admin can grant itself any power at any time.");
  });

  it("names the admin as a grantor next to the current holder", () => {
    const pause = judge(snap({}, { DEFAULT_ADMIN_ROLE: [EOA], PAUSE_ROLE: [SAFE] })).findings.find((f) => f.id === "pause")!;
    expect(pause.who).toEqual([SAFE]);
    expect(pause.grantors).toEqual([EOA]);
  });

  it("puts an active transfer pause at the top", () => {
    const v = judge(snap({ pausedFeatures: ["TRANSFER"] }, { PAUSE_ROLE: [EOA], UNPAUSE_ROLE: [SAFE] }));
    expect(v.findings[0].id).toBe("paused-now");
    expect(v.findings[0].who).toEqual([SAFE]);
    expect(v.findings[0].grantors).toBeUndefined();
  });

  it("merges one policy bound to several transfer scopes into one finding", () => {
    const block: PolicyState = { id: 5n, inverted: false, type: "BLOCKLIST", exists: true, admin: EOA, members: null, defaultAuthorized: true };
    const s = snap();
    s.policies = { ...s.policies, TRANSFER_SENDER_POLICY: block, TRANSFER_RECEIVER_POLICY: block, TRANSFER_EXECUTOR_POLICY: block };
    const policy = judge(s).findings.filter((f) => f.id.startsWith("policy-"));
    expect(policy).toHaveLength(1);
    expect(policy[0].title).toBe("Individual wallets can be blocked from transferring");
    expect(judge(s).grade).toBe("controlled");
  });

  it("warns when an allowlist shuts out ordinary wallets", () => {
    const s = snap();
    s.policies = { ...s.policies, TRANSFER_RECEIVER_POLICY: { id: 9n, inverted: false, type: "ALLOWLIST", exists: true, admin: SAFE, members: [EOA.address], defaultAuthorized: false } };
    const f = judge(s).findings.find((x) => x.id === "policy-9")!;
    expect(f.severity).toBe("high");
    expect(f.detail).toContain("lists 1 address.");
  });

  it("flags a dangling policy id", () => {
    const s = snap();
    s.policies = { ...s.policies, TRANSFER_SENDER_POLICY: { id: 3n, inverted: false, type: "BLOCKLIST", exists: false, members: null, defaultAuthorized: true } };
    expect(judge(s).findings.find((x) => x.id === "policy-3")!.title).toMatch(/does not exist/);
  });

  it("flags B20 copies of major tickers", () => {
    const v = judge(snap({ name: "Bitcoin USD", symbol: "BTC" }));
    expect(v.findings[0].id).toBe("impersonation-ticker");
    expect(v.risk).toBe("critical");
    expect(v.grade).toBe("immutable"); // ownerless, but still a copy
  });

  it("flags platform branding on a token created straight from the factory", () => {
    expect(ids(judge(snap({ name: "Safu by Virtuals", symbol: "SAFU" })))).toContain("impersonation-brand");
    const viaLaunchpad = snap({ name: "Safu by Virtuals", symbol: "SAFU" });
    viaLaunchpad.creation = { ...viaLaunchpad.creation!, via: SAFE.address };
    expect(ids(judge(viaLaunchpad))).not.toContain("impersonation-brand");
  });

  it("warns about a scheduled multiplier change only while it is in the future", () => {
    const m = { current: 10n ** 18n, pending: 2n * 10n ** 18n, effectiveAt: 2000n };
    expect(ids(judge(snap({ multiplier: m }), { now: 1000 }))).toContain("multiplier-scheduled");
    expect(ids(judge(snap({ multiplier: m }), { now: 3000 }))).not.toContain("multiplier-scheduled");
    expect(judge(snap({ multiplier: m }), { now: 1000 }).findings.find((f) => f.id === "multiplier-scheduled")!.detail).toContain("×2");
  });

  it("records prior seizures and renames", () => {
    const v = judge(snap({ seizures: { count: 2, total: 15n * 10n ** 17n }, renames: { count: 1, name: "New" } }));
    expect(v.findings.find((f) => f.id === "seized-before")!.detail).toContain("1.5 MEME");
    expect(v.findings.find((f) => f.id === "renamed")!.detail).toContain('Launched as "Meme"');
  });
});

describe("judge with index context", () => {
  const first = "0x9999999999999999999999999999999999999999" as const;
  const index = (over: Record<string, unknown> = {}) => ({ coverageFrom: 1, coverageFromTime: 1_757_000_000, ...over });

  it("calls out a copy and names the original", () => {
    const v = judge(snap(), { index: index({ symbolClones: { count: 5, first, firstBlock: 1, firstTime: 1_760_000_000 } }) });
    const c = v.findings.find((f) => f.id === "clone")!;
    expect(c.severity).toBe("high");
    expect(c.title).toBe("One of 5 B20 tokens with this symbol");
    expect(c.detail).toContain(first);
  });

  it("treats a single duplicate as information, not a warning", () => {
    const v = judge(snap(), { index: index({ symbolClones: { count: 2, first, firstBlock: 1, firstTime: 1_760_000_000 } }) });
    expect(v.findings.find((f) => f.id === "clone")!.severity).toBe("low");
  });

  it("credits the original instead of flagging it", () => {
    const s = snap();
    const v = judge(s, { index: index({ symbolClones: { count: 3, first: s.address, firstBlock: 1, firstTime: 1 } }) });
    expect(v.findings.find((f) => f.id === "cloned")!.title).toBe("2 later B20 tokens copied this symbol");
    expect(ids(v)).not.toContain("clone");
  });

  it("flags serial deployers from ten launches up as medium", () => {
    expect(judge(snap(), { index: index({ deployerLaunches: 2 }) }).findings.some((f) => f.id === "serial-deployer")).toBe(false);
    expect(judge(snap(), { index: index({ deployerLaunches: 4 }) }).findings.find((f) => f.id === "serial-deployer")!.severity).toBe("low");
    expect(judge(snap(), { index: index({ deployerLaunches: 37 }) }).findings.find((f) => f.id === "serial-deployer")!.severity).toBe("medium");
  });

  it("trusts a known issuer only when its metadata agrees", () => {
    const coinbase = "0x4bA3E29E254F25E94E61C4c9d67b37027331534D" as const;
    const s = snap({ contractURI: "https://api.coinbase.com/v1/tokenized-stocks/metadata/GTLBc" });
    s.creation = { ...s.creation!, via: coinbase };
    const v = judge(s, { index: index({ symbolClones: { count: 2, first, firstBlock: 1, firstTime: 1 }, deployerLaunches: 200 }) });
    expect(ids(v)).toContain("known-issuer");
    expect(ids(v)).not.toContain("clone");
    expect(ids(v)).not.toContain("serial-deployer");

    const spoof = snap({ contractURI: "https://evil.example/metadata" });
    spoof.creation = { ...spoof.creation!, via: coinbase };
    expect(ids(judge(spoof))).not.toContain("known-issuer");
  });
});

describe("judge identity", () => {
  it("flags deceptive Unicode", () => {
    const v = judge(snap({ name: "USD𖼊", symbol: "USD𖼊" }));
    expect(ids(v)).toEqual(expect.arrayContaining(["unicode-trick", "impersonation-ticker"]));
    expect(v.findings.find((f) => f.id === "impersonation-ticker")!.title).toBe("Uses the bare USD ticker");
  });
  it("points at the real contract for copied assets", () => {
    const f = judge(snap({ name: "USD Coin", symbol: "ＵＳＤＣ" })).findings.find((x) => x.id === "impersonation-ticker")!;
    expect(f.severity).toBe("critical");
    expect(f.detail).toContain("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });
  it("says Base has no token", () => {
    expect(judge(snap({ name: "Base", symbol: "BASE" })).findings.find((x) => x.id === "impersonation-ticker")!.title).toBe("Base has no token");
  });
});

describe("fmt", () => {
  it("formats raw amounts", () => {
    expect(fmt(0n, 18)).toBe("0");
    expect(fmt(1_234_567_800_000_000_000_000_000n, 18)).toBe("1,234,567.8");
    expect(fmt(10n ** 27n, 18)).toBe("1,000,000,000");
    expect(fmt(1_234_567_800_000_000_000_000n, 18)).toBe("1,234.5678");
    expect(fmt(5n, 0)).toBe("5");
    expect(fmt(123_456_789n, 8)).toBe("1.2345");
  });
});
