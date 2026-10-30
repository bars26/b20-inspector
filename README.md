# B20 Inspector

Paste a [B20](https://docs.base.org/specifications/b20/index) token address and see who controls it: who can mint, seize, pause, blocklist, rename or rescale it, and what that means for a holder's balance.

B20 is Base's native token standard (live since the Beryl upgrade, extended in Cobalt). Every B20 token carries a role tree and policy slots. Most launchpad tokens are created without an admin, so their rules are final. Issued assets such as tokenized stocks keep an admin, minters, pausers and a blocklist. Copies of well-known tickers are common. The inspector tells these apart.

## What it checks

- **Roles**: current holders of every B20 role, rebuilt from `RoleGranted`/`RoleRevoked` since creation and confirmed with `hasRole`. It also shows who can grant a role to themselves through the role-admin chain.
- **Supply**: the supply cap, how much room is left under it, and whether an admin can raise it.
- **Seizure**: `SEIZE_ROLE` only matters for wallets the `SEIZE_EXEMPT_POLICY` does not authorize, so the inspector checks both. It also flags past `Seized` events and the deprecated `BURN_BLOCKED_ROLE`.
- **Pause**: current paused features and who can pause or unpause.
- **Policies**: the policy on each of the six scopes. It decodes the policy type from the ID, plus the NOT bit, the admin, and composite children. Allow/blocklist members are rebuilt from registry events and re-checked with `isAuthorized`.
- **Identity**: B20 copies of major tickers (BTC, ETH, USDC…), platform branding on tokens created straight from the factory, renames since launch, and scheduled UI-multiplier changes.
- **Check a wallet**: whether a given address can send, receive or submit transfers right now, and whether it can be seized.

The verdict engine (`src/verdict.ts`) is a pure function of the on-chain snapshot and is unit-tested.

## How it reads the chain

Everything runs in the browser against free public RPCs. There is no backend and nothing is stored, apart from cached policy creation blocks in `localStorage`.

1. Latest state via `eth_call` (publicnode, falling back to mainnet.base.org).
2. The creation block, found by a parallel search over `isB20Initialized(token)` at historical blocks (archive `eth_call` via drpc / mainnet.base.org).
3. Token events from the creation block to head, via `eth_getLogs` in 50,000-block chunks (publicnode).

The free log provider keeps roughly the last two months of history. For older tokens or policies, the page reports partial history. In that case the creator and launch contract are still checked with `hasRole`, but the grade stays "Inconclusive" rather than claiming the token is ownerless. To use your own archive provider:

```
https://<host>/?logsRpc=https://your-archive-rpc&chunk=10000#/base/0xb200…
```

`?rpc=` overrides the state and archive endpoints too.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # verdict engine tests
npm run build      # typecheck + static build in dist/
node scripts/judge.ts 0xb200…   # print verdicts from the terminal
```

Interfaces and constants come from [base/base-std](https://github.com/base/base-std).

Independent, read-only tool. Not affiliated with Base or Coinbase.
