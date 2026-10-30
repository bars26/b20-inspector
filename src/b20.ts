// B20 surface used by the inspector. Signatures copied from base/base-std
// src/interfaces (IB20, IB20Asset, IB20Stablecoin, IB20Factory, IPolicyRegistry, IERC8056).
import { keccak256, parseAbi, toHex, type Address, type Hex } from "viem";

export const B20_FACTORY: Address = "0xB20f000000000000000000000000000000000000";
export const POLICY_REGISTRY: Address = "0x8453000000000000000000000000000000000002";

/** Every B20 token address starts with this prefix; the next byte encodes the variant. */
export const B20_PREFIX = "0xb2000000000000000000";

export const factoryAbi = parseAbi([
  "function isB20(address token) view returns (bool)",
  "function isB20Initialized(address token) view returns (bool)",
  "event B20Created(address indexed token, uint8 indexed variant, string name, string symbol, uint8 decimals, bytes variantEventParams)",
]);

export const tokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function supplyCap() view returns (uint256)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getRoleAdmin(bytes32 role) view returns (bytes32)",
  "function pausedFeatures() view returns (uint8[])",
  "function policyId(bytes32 policyScope) view returns (uint64)",
  "function contractURI() view returns (string)",
  // IB20Stablecoin
  "function currency() view returns (string)",
  // IB20Asset + IERC8056
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",

  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)",
  "event LastAdminRenounced(address indexed previousAdmin)",
  "event Paused(address indexed updater, uint8[] features)",
  "event Unpaused(address indexed updater, uint8[] features)",
  "event PolicyUpdated(bytes32 indexed policyScope, uint64 oldPolicyId, uint64 newPolicyId)",
  "event SupplyCapUpdated(address indexed updater, uint256 oldSupplyCap, uint256 newSupplyCap)",
  "event Seized(address indexed caller, address indexed from, address indexed to, uint256 amount)",
  "event BurnedBlocked(address indexed caller, address indexed from, uint256 amount)",
  "event NameUpdated(address indexed updater, string newName)",
  "event SymbolUpdated(address indexed updater, string newSymbol)",
  "event Announcement(address indexed caller, string id, string description, string uri)",
  "event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp)",
]);

export const registryAbi = parseAbi([
  "function policyExists(uint64 policyId) view returns (bool)",
  "function policyAdmin(uint64 policyId) view returns (address)",
  "function pendingPolicyAdmin(uint64 policyId) view returns (address)",
  "function compositePolicyChildIds(uint64 policyId) view returns (uint64[])",
  "function isAuthorized(uint64 policyId, address account) view returns (bool)",
  "event PolicyCreated(uint64 indexed policyId, address indexed creator, uint8 policyType)",
  "event AllowlistUpdated(uint64 indexed policyId, address indexed updater, bool allowed, address[] accounts)",
  "event BlocklistUpdated(uint64 indexed policyId, address indexed updater, bool blocked, address[] accounts)",
  "event CompositePolicyUpdated(uint64 indexed policyId, address indexed updater, uint64[] childPolicyIds)",
]);

const id = (name: string): Hex => keccak256(toHex(name));

export const ROLES = {
  DEFAULT_ADMIN_ROLE: `0x${"0".repeat(64)}` as Hex,
  MINT_ROLE: id("MINT_ROLE"),
  BURN_ROLE: id("BURN_ROLE"),
  BURN_BLOCKED_ROLE: id("BURN_BLOCKED_ROLE"),
  SEIZE_ROLE: id("SEIZE_ROLE"),
  PAUSE_ROLE: id("PAUSE_ROLE"),
  UNPAUSE_ROLE: id("UNPAUSE_ROLE"),
  METADATA_ROLE: id("METADATA_ROLE"),
  OPERATOR_ROLE: id("OPERATOR_ROLE"),
} as const;
export type RoleName = keyof typeof ROLES;
export const ROLE_NAMES = Object.keys(ROLES) as RoleName[];
export const roleNameOf = (hash: Hex): RoleName | undefined =>
  ROLE_NAMES.find((n) => ROLES[n].toLowerCase() === hash.toLowerCase());

export const SCOPES = {
  TRANSFER_SENDER_POLICY: id("TRANSFER_SENDER_POLICY"),
  TRANSFER_RECEIVER_POLICY: id("TRANSFER_RECEIVER_POLICY"),
  TRANSFER_EXECUTOR_POLICY: id("TRANSFER_EXECUTOR_POLICY"),
  MINT_RECEIVER_POLICY: id("MINT_RECEIVER_POLICY"),
  SEIZE_EXEMPT_POLICY: id("SEIZE_EXEMPT_POLICY"),
  SEIZE_RECEIVER_POLICY: id("SEIZE_RECEIVER_POLICY"),
} as const;
export type ScopeName = keyof typeof SCOPES;
export const SCOPE_NAMES = Object.keys(SCOPES) as ScopeName[];

export const PAUSABLE = ["TRANSFER", "MINT", "BURN", "SEIZE"] as const;
export type PausableFeature = (typeof PAUSABLE)[number];

export const POLICY_TYPES = ["BLOCKLIST", "ALLOWLIST", "UNION", "INTERSECT"] as const;
export type PolicyType = (typeof POLICY_TYPES)[number];

/** Bit 63 of a policy ID is the NOT flag (Denim). */
export const INVERT_BIT = 1n << 63n;
export const ALWAYS_ALLOW = 0n;

export const MAX_SUPPLY_CAP = (1n << 128n) - 1n;
export const WAD = 10n ** 18n;

export type Variant = "ASSET" | "STABLECOIN";
/** Byte right after the 10-byte prefix: 0x00 asset, 0x01 stablecoin. */
export function variantFromAddress(addr: string): Variant | undefined {
  const a = addr.toLowerCase();
  if (!a.startsWith(B20_PREFIX)) return undefined;
  const b = a.slice(B20_PREFIX.length, B20_PREFIX.length + 2);
  return b === "00" ? "ASSET" : b === "01" ? "STABLECOIN" : undefined;
}
