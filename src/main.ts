// Every string from the chain (name, symbol, URIs) is attacker-controlled, so the DOM is built
// with textContent only; nothing goes through innerHTML.
import { ROLE_NAMES, SCOPE_NAMES, type RoleName, type ScopeName } from "./b20.ts";
import { checkWallet, inspectToken, NotB20Error } from "./inspect.ts";
import { makeRpc, type NetworkId, type Rpc } from "./rpc.ts";
import type { Account, PolicyState, TokenSnapshot } from "./types.ts";
import { fmt, judge, type Finding, type Verdict } from "./verdict.ts";

type Child = Node | string | null | undefined | false;
function h(tag: string, attrs: Record<string, string> = {}, ...kids: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const k of kids) if (k) el.append(k);
  return el;
}

const out = document.getElementById("out")!;
const form = document.getElementById("search") as HTMLFormElement;
const input = document.getElementById("addr") as HTMLInputElement;
const params = new URLSearchParams(location.search);
const overrides = {
  rpc: params.get("rpc") ?? undefined,
  logsRpc: params.get("logsRpc") ?? undefined,
  chunk: params.get("chunk") ? Number(params.get("chunk")) : undefined,
};

let network: NetworkId = "base";
let run = 0;

function route(): { net: NetworkId; addr?: string } {
  const [, net, addr] = location.hash.split("/");
  return { net: net === "base-sepolia" ? "base-sepolia" : "base", addr };
}

function setNetwork(n: NetworkId) {
  network = n;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".net button")) b.setAttribute("aria-pressed", String(b.dataset.net === n));
}

for (const b of document.querySelectorAll<HTMLButtonElement>(".net button")) {
  b.addEventListener("click", () => {
    const { addr } = route();
    location.hash = addr ? `#/${b.dataset.net}/${addr}` : `#/${b.dataset.net}`;
  });
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = input.value.trim();
  if (v) location.hash = `#/${network}/${v}`;
});

window.addEventListener("hashchange", load);
load();

async function load() {
  const { net, addr } = route();
  setNetwork(net);
  if (!addr) {
    out.replaceChildren();
    return;
  }
  input.value = addr;
  const me = ++run;
  const rpc = makeRpc(net, overrides);
  const steps = h("ol");
  out.replaceChildren(h("div", { class: "panel status" }, "Inspecting on ", net === "base" ? "Base mainnet" : "Base Sepolia", "…", steps));
  let last: HTMLElement | undefined;
  try {
    const snap = await inspectToken(rpc, addr, (step) => {
      if (me !== run) return;
      last?.classList.add("done");
      last = h("li", {}, step);
      steps.append(last);
    });
    if (me !== run) return;
    render(rpc, snap, judge(snap));
    document.title = `${snap.symbol} · B20 Inspector`;
  } catch (e) {
    if (me !== run) return;
    const msg = e instanceof NotB20Error ? e.message : `Could not read this token: ${(e as Error).message.split("\n")[0]}`;
    out.replaceChildren(h("div", { class: "panel error" }, msg));
  }
}

const SEVERITY_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low", good: "OK" };
const GRADE = {
  immutable: { label: "Ownerless", sev: "good" },
  controlled: { label: "Issuer-controlled", sev: "medium" },
  unknown: { label: "Inconclusive", sev: "low" },
} as const;

function render(rpc: Rpc, s: TokenSnapshot, v: Verdict) {
  const ex = rpc.config.explorer;
  const grade = GRADE[v.grade];

  const summary = h(
    "div",
    { class: "panel verdict" },
    h("div", { class: "who-row" },
      h("span", { class: "token-name" }, `${s.name} (${s.symbol})`),
      h("span", { class: `badge sev-${grade.sev}` }, grade.label),
      v.risk !== "low" && h("span", { class: `badge sev-${v.risk}` }, `${SEVERITY_LABEL[v.risk]} risk`),
    ),
    h("p", { class: "headline" }, v.headline),
    h("div", { class: "addr-line mono" }, link(`${ex}/token/${s.address}`, s.address)),
  );

  const findings = h("ul", { class: "findings" }, ...v.findings.map(findingEl(ex)));

  out.replaceChildren(
    summary,
    h("div", { class: "panel" }, h("h2", {}, "What this means for holders"), findings),
    walletPanel(rpc, s),
    factsPanel(s, ex),
    rolesPanel(s, ex),
    policiesPanel(s, ex),
  );
}

const findingEl = (ex: string) => (f: Finding) =>
  h("li", { class: "finding" },
    h("span", { class: `badge sev-${f.severity}` }, SEVERITY_LABEL[f.severity]),
    h("h3", {}, f.title),
    h("p", {}, f.detail),
    (f.who || f.grantors) &&
      h("div", { class: "people" },
        f.who && h("span", { class: "label" }, "Held by"),
        ...(f.who ?? []).map((a) => chip(a, ex)),
        f.grantors && h("span", { class: "label" }, f.who ? "· can be granted by" : "Can be granted by"),
        ...(f.grantors ?? []).map((a) => chip(a, ex)),
      ),
  );

function walletPanel(rpc: Rpc, s: TokenSnapshot) {
  const field = h("input", { placeholder: "0x… your wallet", spellcheck: "false", "aria-label": "Wallet address" }) as HTMLInputElement;
  const result = h("div", { class: "check-result" });
  const f = h("form", { class: "check" }, field, h("button", { class: "btn", type: "submit" }, "Check"));
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    result.replaceChildren(h("span", { class: "none" }, "Checking…"));
    try {
      const c = await checkWallet(rpc, s, field.value);
      const cell = (ok: boolean, yes: string, no: string) => h("div", { class: ok ? "sev-good" : "sev-critical" }, ok ? yes : no);
      result.replaceChildren(
        h("div", { class: "sev-low" }, `Balance: ${fmt(c.balance, s.decimals)} ${s.symbol}`),
        cell(c.canSend, "Can send", "Cannot send"),
        cell(c.canReceive, "Can receive", "Cannot receive"),
        cell(c.canSubmit, "Can submit transfers", "Cannot submit transfers"),
        cell(!c.seizable, "Not seizable", "Seizable"),
      );
    } catch (err) {
      result.replaceChildren(h("span", { class: "error" }, `Could not check: ${(err as Error).message.split("\n")[0]}`));
    }
  });
  return h("div", { class: "panel" }, h("h2", {}, "Check a wallet"), f, result);
}

function factsPanel(s: TokenSnapshot, ex: string) {
  const uncapped = s.supplyCap >= (1n << 128n) - 1n;
  const c = s.creation;
  const facts: [string, Child][] = [
    ["Type", s.variant === "STABLECOIN" ? `Stablecoin${s.currency ? ` (${s.currency})` : ""}` : "Asset"],
    ["Decimals", String(s.decimals)],
    ["Total supply", `${fmt(s.totalSupply, s.decimals)} ${s.symbol}`],
    ["Supply cap", uncapped ? "None" : `${fmt(s.supplyCap, s.decimals)} ${s.symbol}`],
    ["Paused", s.pausedFeatures.length ? s.pausedFeatures.join(", ") : "Nothing"],
    ["Created", c ? h("span", {}, new Date(c.timestamp * 1000).toISOString().slice(0, 16).replace("T", " "), " UTC · ", link(`${ex}/tx/${c.txHash}`, `block ${c.block}`)) : "Unknown"],
    ["Created by", c ? chip({ address: c.from, kind: "eoa" }, ex, false) : "Unknown"],
    ["Launched through", c ? (c.via ? chip({ address: c.via, kind: "contract" }, ex, false) : "Factory, directly") : "Unknown"],
    ["Metadata URI", s.contractURI ? (safeHttps(s.contractURI) ? link(s.contractURI, s.contractURI) : s.contractURI) : "None"],
    ["Event history", s.historyComplete ? "Complete" : "Partial (log provider limit)"],
  ];
  if (s.multiplier && s.multiplier.current !== 10n ** 18n) facts.splice(4, 0, ["UI multiplier", `×${Number(s.multiplier.current) / 1e18}`]);
  return h("div", { class: "panel" }, h("h2", {}, "Token"),
    h("dl", { class: "facts" }, ...facts.map(([k, val]) => h("div", {}, h("dt", {}, k), h("dd", {}, val)))));
}

const ROLE_HELP: Record<RoleName, string> = {
  DEFAULT_ADMIN_ROLE: "Grants every role, sets policies and the supply cap",
  MINT_ROLE: "Creates new tokens",
  BURN_ROLE: "Burns its own tokens",
  BURN_BLOCKED_ROLE: "Burns blocked holders' balances (deprecated)",
  SEIZE_ROLE: "Moves tokens out of non-exempt wallets",
  PAUSE_ROLE: "Pauses transfers, mint, burn or seize",
  UNPAUSE_ROLE: "Lifts a pause",
  METADATA_ROLE: "Renames the token and edits metadata",
  OPERATOR_ROLE: "Rescales displayed balances, posts announcements",
};

function rolesPanel(s: TokenSnapshot, ex: string) {
  const rows = ROLE_NAMES.filter((r) => s.variant === "ASSET" || r !== "OPERATOR_ROLE").map((r) => {
    const st = s.roles[r];
    const admin = st.adminRole;
    const adminName = admin === "DEFAULT_ADMIN_ROLE" ? "admin" : admin.length > 30 ? `${admin.slice(0, 10)}…` : admin;
    const adminHeld = (s.roles[admin as RoleName]?.holders.length ?? 1) > 0;
    return h("tr", {},
      h("td", {}, h("div", { class: "mono" }, r), h("div", { class: "none" }, ROLE_HELP[r])),
      h("td", {}, ...(st.holders.length ? st.holders.map((a) => chip(a, ex)) : [h("span", { class: "none" }, "Nobody")])),
      h("td", { class: adminHeld ? "mono" : "mono none" }, adminHeld ? adminName : `${adminName} (none)`),
    );
  });
  return h("div", { class: "panel" }, h("h2", {}, "Roles"),
    !s.historyComplete && h("p", { class: "none" }, "History is partial: holders below were confirmed with hasRole, but accounts granted roles before the provider's history window may be missing."),
    h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Role"), h("th", {}, "Current holders"), h("th", {}, "Granted by"))), h("tbody", {}, ...rows))));
}

const SCOPE_HELP: Record<ScopeName, string> = {
  TRANSFER_SENDER_POLICY: "Checked on the sender",
  TRANSFER_RECEIVER_POLICY: "Checked on the receiver",
  TRANSFER_EXECUTOR_POLICY: "Checked on whoever submits the transfer",
  MINT_RECEIVER_POLICY: "Checked on mint recipients",
  SEIZE_EXEMPT_POLICY: "Authorized wallets cannot be seized",
  SEIZE_RECEIVER_POLICY: "Where seized tokens may go",
};

function policyCell(p: PolicyState, ex: string): Child {
  if (p.id === 0n) return h("span", { class: "none" }, "Everyone (no policy)");
  const kids: Child[] = [
    h("div", {}, `#${p.id}${p.inverted ? " (NOT)" : ""} · ${p.type?.toLowerCase() ?? "malformed"}${p.exists ? "" : " · does not exist"}`),
    h("div", { class: "none" }, p.defaultAuthorized ? "Ordinary wallets pass" : "Ordinary wallets are rejected"),
  ];
  if (p.admin) kids.push(h("div", {}, h("span", { class: "label" }, "Admin "), chip(p.admin, ex)));
  if (p.members) kids.push(h("div", { class: "none" }, `${p.members.length} listed address${p.members.length === 1 ? "" : "es"}`));
  else if (p.exists && !p.children) kids.push(h("div", { class: "none" }, "Members: history too old for the public log provider"));
  if (p.children) kids.push(h("div", { class: "none" }, `Combines ${p.children.map((c) => `#${c.id}`).join(", ")}`));
  return h("div", {}, ...kids);
}

function policiesPanel(s: TokenSnapshot, ex: string) {
  const rows = SCOPE_NAMES.map((sc) =>
    h("tr", {}, h("td", {}, h("div", { class: "mono" }, sc), h("div", { class: "none" }, SCOPE_HELP[sc])), h("td", {}, policyCell(s.policies[sc], ex))),
  );
  return h("div", { class: "panel" }, h("h2", {}, "Policies"),
    h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Scope"), h("th", {}, "Policy"))), h("tbody", {}, ...rows))));
}

const KIND = { eoa: "wallet", contract: "contract", "delegated-eoa": "smart wallet" };
function chip(a: Account, ex: string, showKind = true) {
  return h("a", { class: "chip", href: `${ex}/address/${a.address}`, target: "_blank", rel: "noopener noreferrer" },
    `${a.address.slice(0, 6)}…${a.address.slice(-4)}`,
    showKind && h("span", { class: "kind" }, KIND[a.kind]));
}

function safeHttps(u: string) {
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
}

function link(href: string, text: string) {
  return h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);
}
