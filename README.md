# B20 Inspector

**Live: https://b20-inspector.vercel.app**

Paste a [B20](https://docs.base.org/specifications/b20/index) token address and see who controls it: who can mint, seize, pause, blocklist, rename or rescale it, and what that means for a holder's balance.

B20 is Base's native token standard (live since the Beryl upgrade, extended in Cobalt). Every B20 token carries a role tree and policy slots. Most launchpad tokens are created without an admin, so their rules are final. Issued assets such as tokenized stocks keep an admin, minters, pausers and a blocklist. Copies of well-known tickers are common. The inspector tells these apart.

## What it checks

- **Roles**: current holders of every B20 role, rebuilt from `RoleGranted`/`RoleRevoked` since creation and confirmed with `hasRole`. It also shows who can grant a role to themselves through the role-admin chain.
- **Supply**: the supply cap, how much room is left under it, and whether an admin can raise it.
- **Seizure**: `SEIZE_ROLE` only matters for wallets the `SEIZE_EXEMPT_POLICY` does not authorize, so the inspector checks both. It also flags past `Seized` events and the deprecated `BURN_BLOCKED_ROLE`.
- **Pause**: current paused features and who can pause or unpause.
- **Policies**: the policy on each of the six scopes. It decodes the policy type from the ID, plus the NOT bit, the admin, and composite children. Allow/blocklist members are rebuilt from registry events and re-checked with `isAuthorized`.
- **Identity**: B20 copies of major tickers (BTC, ETH, USDC…), platform branding on tokens created straight from the factory, renames since launch, and scheduled UI-multiplier changes.
- **Copies and spam**: whether other B20 tokens use the same normalized symbol or name (and which came first), and how many tokens the creating wallet has launched. Known issuers are recognized only when the launch contract and the token's own metadata agree.
- **Check a wallet**: whether a given address can send, receive or submit transfers right now, and whether it can be seized.

The verdict engine (`src/verdict.ts`) is a pure function of the on-chain snapshot and is unit-tested, as is the identity library (`src/identity.ts`: Unicode confusables, styled and invisible characters, and a registry of real Base assets checked on-chain).

## New-token feed

`#/base/new` lists every B20 token created in the last seven days. Rows carry warnings for copied tickers, deceptive Unicode, mass deployers and known issuers, and can be filtered.

The feed reads a factory index that a GitHub Actions workflow (`.github/workflows/index.yml`) extends every 15 minutes:

- `scripts/build-index.ts` scans `B20Created` events, finds each creator from the creation transaction, and writes `meta`, `recent`, `symbols`, `names` and `deployers` JSON. For ERC-4337 bundles, the creator is the smart account from the `UserOperationEvent`, not the bundler.
- The files go to the `data` branch as a single force-pushed commit, and the site fetches them from raw.githubusercontent.com. Vercel ignores that branch (`vercel.json`).
- The browser reads the blocks the index has not reached yet straight from the chain, so the feed stays current between runs.

The index starts where the free log provider's history begins (early September 2026 on mainnet). Tokens created before that are still inspectable one by one, but they are missing from clone and deployer counts. Pass `?data=<url>` to point the site at another copy of the index.

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
node scripts/build-index.ts local-index base-sepolia   # build an index, then open /?data=/local-index#/base-sepolia/new
```

Interfaces and constants come from [base/base-std](https://github.com/base/base-std).

Independent, read-only tool. Not affiliated with Base or Coinbase.
