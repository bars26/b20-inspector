import type { Address, Hex } from "viem";
import type { NetworkId } from "./rpc.ts";
import type { PausableFeature, PolicyType, RoleName, ScopeName, Variant } from "./b20.ts";

export type AccountKind = "eoa" | "contract" | "delegated-eoa";

export interface Account {
  address: Address;
  kind: AccountKind;
}

export interface RoleState {
  /** Current holders, each confirmed with hasRole at the latest block. */
  holders: Account[];
  /** Role that administers this one (getRoleAdmin). Unknown hashes are kept raw. */
  adminRole: RoleName | Hex;
}

export interface PolicyState {
  id: bigint;
  inverted: boolean;
  /** Decoded from the ID's top byte; undefined when malformed. */
  type?: PolicyType;
  exists: boolean;
  admin?: Account;
  pendingAdmin?: Address;
  children?: PolicyState[];
  /** Current members of an allow/blocklist, or null when the history could not be read. */
  members: Address[] | null;
  /** What isAuthorized returns for an arbitrary address that was never listed. */
  defaultAuthorized: boolean;
}

export interface TokenSnapshot {
  network: NetworkId;
  address: Address;
  variant: Variant;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  supplyCap: bigint;
  currency?: string;
  contractURI?: string;
  pausedFeatures: PausableFeature[];
  creation?: {
    block: bigint;
    timestamp: number;
    txHash: Hex;
    /** Sender of the creation transaction. */
    from: Address;
    /** Contract that called the factory, when it was not called directly (a launchpad, an issuer contract). */
    via?: Address;
    initialName: string;
    initialSymbol: string;
  };
  /** Whether role and event history was read in full from creation to now. */
  historyComplete: boolean;
  historyError?: string;
  roles: Record<RoleName, RoleState>;
  lastAdminRenounced: boolean;
  policies: Record<ScopeName, PolicyState>;
  multiplier?: { current: bigint; pending: bigint; effectiveAt: bigint };
  seizures: { count: number; total: bigint };
  renames: { name?: string; symbol?: string; count: number };
  announcements: number;
  headBlock: bigint;
}
