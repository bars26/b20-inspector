import { getAddress, type Address, type Hex, type Log } from "viem";
import {
  B20_FACTORY, INVERT_BIT, PAUSABLE, POLICY_REGISTRY, POLICY_TYPES, ROLES, ROLE_NAMES, SCOPES, SCOPE_NAMES,
  factoryAbi, registryAbi, roleNameOf, tokenAbi, variantFromAddress,
  type PausableFeature, type RoleName, type ScopeName,
} from "./b20.ts";
import { HistoryUnavailableError, findFirstBlock, getLogsChunked, type Rpc } from "./rpc.ts";
import type { Account, AccountKind, PolicyState, RoleState, TokenSnapshot } from "./types.ts";

export class NotB20Error extends Error {}

export type Progress = (step: string) => void;

/** An address no issuer would list; used to read a policy's default answer. */
const PROBE_ACCOUNT: Address = "0x000000000000000000000000000000000000b20b";

/** localStorage when it exists and works (browser), otherwise a no-op (node scripts, private mode). */
const storage = {
  get(k: string): string | null {
    try {
      return globalThis.localStorage?.getItem(k) ?? null;
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      globalThis.localStorage?.setItem(k, v);
    } catch {
      /* storage unavailable */
    }
  },
};

const tokenEvents =tokenAbi.filter((x) => x.type === "event");
const memberEvents = registryAbi.filter((x) => x.name === "AllowlistUpdated" || x.name === "BlocklistUpdated");

export async function inspectToken(rpc: Rpc, input: string, progress: Progress = () => {}): Promise<TokenSnapshot> {
  const address = getAddress(input.trim());
  const variant = variantFromAddress(address);
  if (!variant) throw new NotB20Error("Not a B20 address: B20 tokens start with 0xb2000000000000000000.");

  progress("Reading token state");
  const head = await rpc.state.getBlockNumber();
  const initialized = await rpc.state.readContract({ address: B20_FACTORY, abi: factoryAbi, functionName: "isB20Initialized", args: [address] });
  if (!initialized) throw new NotB20Error("This address has the B20 prefix but no token has been created there yet.");

  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    rpc.state.readContract({ address, abi: tokenAbi, functionName: functionName as never, args: args as never, blockNumber: head }) as Promise<T>;
  const optional = <T>(p: Promise<T>) => p.then((v) => v, () => undefined);

  const [name, symbol, decimals, totalSupply, supplyCap, paused, contractURI, currency, multiplier] = await Promise.all([
    read<string>("name"),
    read<string>("symbol"),
    read<number>("decimals"),
    read<bigint>("totalSupply"),
    read<bigint>("supplyCap"),
    read<readonly number[]>("pausedFeatures"),
    optional(read<string>("contractURI")),
    variant === "STABLECOIN" ? optional(read<string>("currency")) : undefined,
    variant === "ASSET"
      ? optional(Promise.all([read<bigint>("uiMultiplier"), read<bigint>("newUIMultiplier"), read<bigint>("effectiveAt")]))
      : undefined,
  ]);

  progress("Locating the creation block");
  const creationBlock = await findFirstBlock(rpc.config.b20Floor, head, (blockNumber) =>
    rpc.archive.readContract({ address: B20_FACTORY, abi: factoryAbi, functionName: "isB20Initialized", args: [address], blockNumber }),
  );
  const creation = await readCreation(rpc, address, creationBlock);

  progress("Replaying role and policy events");
  let logs: Log[] = [];
  let historyComplete = true;
  let historyError: string | undefined;
  try {
    logs = await getLogsChunked(rpc, { address, events: tokenEvents, fromBlock: creationBlock, toBlock: head });
  } catch (e) {
    if (!(e instanceof HistoryUnavailableError)) throw e;
    historyComplete = false;
    historyError = e.message;
  }

  const ev = (n: string) => logs.filter((l) => (l as Log & { eventName?: string }).eventName === n) as (Log & { args: any })[];

  // Candidates: everyone ever granted a role, plus the creator and launch contract
  // (checked directly so the answer stays right even without history).
  const candidates = new Set<Address>();
  for (const l of ev("RoleGranted")) candidates.add(getAddress(l.args.account));
  if (creation) {
    candidates.add(creation.from);
    if (creation.via) candidates.add(creation.via);
  }

  progress("Confirming current role holders");
  const kinds = new Map<Address, AccountKind>();
  const kindOf = async (a: Address): Promise<AccountKind> => {
    if (!kinds.has(a)) {
      const code = (await rpc.state.getCode({ address: a, blockNumber: head })) ?? "0x";
      kinds.set(a, code === "0x" ? "eoa" : code.toLowerCase().startsWith("0xef0100") ? "delegated-eoa" : "contract");
    }
    return kinds.get(a)!;
  };

  const roles = {} as Record<RoleName, RoleState>;
  await Promise.all(
    ROLE_NAMES.map(async (role) => {
      const [adminHash, held] = await Promise.all([
        read<Hex>("getRoleAdmin", [ROLES[role]]),
        Promise.all([...candidates].map(async (a) => ((await read<boolean>("hasRole", [ROLES[role], a])) ? a : undefined))),
      ]);
      const holders: Account[] = [];
      for (const a of held) if (a) holders.push({ address: a, kind: await kindOf(a) });
      roles[role] = { holders, adminRole: roleNameOf(adminHash) ?? adminHash };
    }),
  );

  progress("Resolving transfer and seize policies");
  const policyCache = new Map<bigint, Promise<PolicyState>>();
  const policy = (id: bigint) => {
    if (!policyCache.has(id)) policyCache.set(id, readPolicy(rpc, id, head, kindOf, policy));
    return policyCache.get(id)!;
  };
  const policies = {} as Record<ScopeName, PolicyState>;
  await Promise.all(
    SCOPE_NAMES.map(async (scope) => {
      policies[scope] = await policy(await read<bigint>("policyId", [SCOPES[scope]]));
    }),
  );

  const seized = ev("Seized");
  const nameUpdates = ev("NameUpdated");
  const symbolUpdates = ev("SymbolUpdated");

  return {
    network: rpc.network,
    address,
    variant,
    name,
    symbol,
    decimals: Number(decimals),
    totalSupply,
    supplyCap,
    currency,
    contractURI: contractURI || undefined,
    pausedFeatures: paused.map((f) => PAUSABLE[f]).filter(Boolean) as PausableFeature[],
    creation,
    historyComplete,
    historyError,
    roles,
    lastAdminRenounced: ev("LastAdminRenounced").length > 0,
    policies,
    multiplier: multiplier ? { current: multiplier[0], pending: multiplier[1], effectiveAt: multiplier[2] } : undefined,
    seizures: { count: seized.length, total: seized.reduce((s, l) => s + (l.args.amount as bigint), 0n) },
    renames: {
      name: nameUpdates.at(-1)?.args.newName,
      symbol: symbolUpdates.at(-1)?.args.newSymbol,
      count: nameUpdates.length + symbolUpdates.length,
    },
    announcements: ev("Announcement").length,
    headBlock: head,
  };
}

async function readCreation(rpc: Rpc, token: Address, block: bigint): Promise<TokenSnapshot["creation"]> {
  try {
    const query = {
      address: B20_FACTORY,
      event: factoryAbi.find((x) => x.type === "event")!,
      args: { token },
      fromBlock: block,
      toBlock: block,
    } as const;
    // The log provider covers recent blocks best; the archive endpoints cover older ones.
    const [created] = await rpc.logs.getLogs(query).catch(() => rpc.archive.getLogs(query));
    if (!created) return undefined;
    const [tx, blk] = await Promise.all([
      rpc.archive.getTransaction({ hash: created.transactionHash! }),
      rpc.archive.getBlock({ blockNumber: block }),
    ]);
    const to = tx.to ? getAddress(tx.to) : undefined;
    return {
      block,
      timestamp: Number(blk.timestamp),
      txHash: created.transactionHash!,
      from: getAddress(tx.from),
      via: to && to !== getAddress(B20_FACTORY) ? to : undefined,
      initialName: created.args.name ?? "",
      initialSymbol: created.args.symbol ?? "",
    };
  } catch {
    return undefined;
  }
}

async function readPolicy(
  rpc: Rpc,
  id: bigint,
  head: bigint,
  kindOf: (a: Address) => Promise<AccountKind>,
  child: (id: bigint) => Promise<PolicyState>,
): Promise<PolicyState> {
  const inverted = (id & INVERT_BIT) !== 0n;
  const base = id & ~INVERT_BIT;
  const type = POLICY_TYPES[Number(base >> 56n)];
  const reg = <T>(functionName: string, args: readonly unknown[], blockNumber = head) =>
    (blockNumber === head ? rpc.state : rpc.archive).readContract({
      address: POLICY_REGISTRY, abi: registryAbi, functionName: functionName as never, args: args as never, blockNumber,
    }) as Promise<T>;

  const [exists, defaultAuthorized] = await Promise.all([reg<boolean>("policyExists", [id]), reg<boolean>("isAuthorized", [id, PROBE_ACCOUNT])]);
  const state: PolicyState = { id, inverted, type, exists, members: null, defaultAuthorized };
  if (id === 0n || !exists) return state;

  const [admin, pending] = await Promise.all([reg<Address>("policyAdmin", [id]), reg<Address>("pendingPolicyAdmin", [id])]);
  if (admin !== "0x0000000000000000000000000000000000000000") state.admin = { address: admin, kind: await kindOf(admin) };
  if (pending !== "0x0000000000000000000000000000000000000000") state.pendingAdmin = pending;

  if (type === "UNION" || type === "INTERSECT") {
    const ids = await reg<readonly bigint[]>("compositePolicyChildIds", [base]);
    state.children = await Promise.all(ids.map(child));
    return state;
  }

  try {
    // A policy's creation block never changes, and popular policies are shared by many tokens.
    const key = `b20i:born:${rpc.network}:${base}`;
    const cached = storage.get(key);
    const born = cached
      ? BigInt(cached)
      : await findFirstBlock(rpc.config.b20Floor, head, (blockNumber) => reg<boolean>("policyExists", [base], blockNumber));
    storage.set(key, born.toString());
    const logs = (await getLogsChunked(rpc, {
      address: POLICY_REGISTRY,
      events: memberEvents,
      args: { policyId: base },
      fromBlock: born,
      toBlock: head,
    })) as (Log & { args: any })[];
    const set = new Set<Address>();
    for (const l of logs) {
      const add = l.args.allowed ?? l.args.blocked;
      for (const a of l.args.accounts as Address[]) add ? set.add(getAddress(a)) : set.delete(getAddress(a));
    }
    // Keep only accounts the registry still agrees on: an allowlist member is authorized,
    // a blocklist member is not.
    const listed = await Promise.all(
      [...set].map(async (a) => ((await reg<boolean>("isAuthorized", [base, a])) === (type === "ALLOWLIST") ? a : undefined)),
    );
    state.members = listed.filter((a): a is Address => !!a);
  } catch (e) {
    if (!(e instanceof HistoryUnavailableError)) throw e;
  }
  return state;
}

export interface WalletCheck {
  balance: bigint;
  canSend: boolean;
  canReceive: boolean;
  /** Whether a transfer this wallet submits itself passes the executor policy. */
  canSubmit: boolean;
  seizable: boolean;
}

/** What a specific wallet can do with this token right now, straight from isAuthorized. */
export async function checkWallet(rpc: Rpc, s: TokenSnapshot, input: string): Promise<WalletCheck> {
  const account = getAddress(input.trim());
  const auth = (scope: ScopeName) =>
    rpc.state.readContract({ address: POLICY_REGISTRY, abi: registryAbi, functionName: "isAuthorized", args: [s.policies[scope].id, account] });
  const [balance, send, receive, submit, exempt] = await Promise.all([
    rpc.state.readContract({ address: s.address, abi: tokenAbi, functionName: "balanceOf", args: [account] }),
    auth("TRANSFER_SENDER_POLICY"),
    auth("TRANSFER_RECEIVER_POLICY"),
    auth("TRANSFER_EXECUTOR_POLICY"),
    auth("SEIZE_EXEMPT_POLICY"),
  ]);
  const paused = s.pausedFeatures.includes("TRANSFER");
  return {
    balance,
    canSend: send && !paused,
    canReceive: receive && !paused,
    canSubmit: submit && !paused,
    seizable: !exempt && s.roles.SEIZE_ROLE.holders.length + s.roles.DEFAULT_ADMIN_ROLE.holders.length > 0,
  };
}
