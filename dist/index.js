// plugin-onchain-forensics — token risk grades and settlement safety for elizaOS agents.
//
// Every answer comes from the live On-chain Forensics x402 API. Calls start on the free
// daily sample (trial=1); when the sample is spent the route returns its real 402
// challenge, which this plugin decodes into price + payTo so the agent can state the
// cost instead of failing. To settle paid calls, pass a `payFetch` in plugin config:
//
//   import { wrapFetchWithPayment } from "x402-fetch";
//   const plugin = createForensicsPlugin({ payFetch: wrapFetchWithPayment(fetch, wallet) });

export const SERVICE = "onchain-forensics";
export const CATALOG = "https://onchainforensics.dev/llms.txt";
const BASE = "https://solene-fa2010da.base44.app/functions";
const UA = "elizaos-plugin-onchain-forensics/1.0.0 (+https://onchainforensics.dev)";

const ROUTES = {
  verdict: { fn: "forensicsVerdict", price: 0.02, question: "Is this token alive, and how risky is a buy?" },
  settlesafe: { fn: "forensicsSettlesafe", price: 0.02, question: "Safe to settle or accept as payment?" },
  mints: { fn: "forensicsMints", price: 0.02, question: "Who can still print this token, and have they?" },
  wallet: { fn: "forensicsWallet", price: 0.05, question: "Does this wallet actually hold what it claims?" },
};

function decodeChallenge(header) {
  try {
    const decoded = typeof atob === "function"
      ? atob(header)
      : Buffer.from(header, "base64").toString("utf8");
    const j = JSON.parse(decoded);
    const a = (j.accepts || [])[0] || {};
    return {
      price_usd: a.amount ? Number(a.amount) / 1e6 : null,
      network: a.network,
      asset: a.asset,
      payTo: a.payTo,
      maxTimeoutSeconds: a.maxTimeoutSeconds,
      x402Version: j.x402Version,
    };
  } catch {
    return null;
  }
}

/**
 * One call to a Forensics route. Never throws on 402: the decoded challenge comes back
 * in `challenge` so the caller can price the decision.
 */
export async function callRoute(routeKey, params = {}, opts = {}) {
  const route = ROUTES[routeKey];
  if (!route) throw new Error(`unknown route: ${routeKey}`);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  if (opts.trial !== false) qs.set("trial", "1");
  const url = `${BASE}/${route.fn}?${qs.toString()}`;
  const headers = { "User-Agent": UA, Accept: "application/json" };
  if (opts.creditKey) headers["X-Credit-Key"] = opts.creditKey;
  const doFetch = typeof opts.payFetch === "function" ? opts.payFetch : fetch;
  const started = Date.now();
  const res = await doFetch(url, { method: "GET", headers });
  const ms = Date.now() - started;
  const text = await res.text();
  let raw = null;
  try { raw = JSON.parse(text); } catch { /* non-JSON body */ }
  const header = res.headers.get("payment-required") || res.headers.get("PAYMENT-REQUIRED");
  const body = raw && raw.data && typeof raw.data === "object" ? raw.data : raw;
  return {
    status: res.status,
    ms,
    data: body,
    envelope: raw,
    challenge: res.status === 402 && header ? decodeChallenge(header) : null,
  };
}

const addressIn = (text = "") => (String(text).match(/0x[0-9a-fA-F]{40}/) || [])[0];
const chainIn = (text = "") => {
  const t = String(text);
  if (/\beth(ereum)?\b/i.test(t)) return "ethereum";
  if (/\bsolana\b/i.test(t)) return "solana";
  return "base";
};
const usd = (n) => (typeof n === "number" ? `$${n >= 1000 ? `${Math.round(n / 1000)}k` : n.toFixed(2)}` : "n/a");

function paywallLine(challenge, routeKey) {
  if (!challenge) return `The ${routeKey} call did not return a payload.`;
  const net = challenge.network === "eip155:8453" ? "Base" : challenge.network;
  return `That ${routeKey} call costs $${challenge.price_usd} in USDC on ${net} (payTo ${challenge.payTo}). `
    + "This runtime has no x402 signer wired in, so I can report the price but cannot settle it.";
}

export function createForensicsPlugin(config = {}) {
  const opts = { payFetch: config.payFetch, creditKey: config.creditKey, trial: config.trial !== false };

  const tokenVerdictAction = {
    name: "TOKEN_VERDICT",
    similes: ["GRADE_TOKEN", "IS_THIS_TOKEN_SAFE", "TOKEN_RISK", "CHECK_TOKEN"],
    description:
      "Grade an ERC-20 before trading or holding it: A-F letter grade, activity score, transfer flow, "
      + "holder breadth and DEX depth. Use whenever the user names a token contract address and asks "
      + "whether it is safe, alive, worth buying, or a scam. $0.02 per lookup, free trial calls each day.",
    examples: [[
      { user: "user", content: { text: "grade 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 on base" } },
      { user: "assistant", content: { text: "Checking that contract before you touch it.", action: "TOKEN_VERDICT" } },
    ]],
    validate: async (_runtime, message) => Boolean(addressIn(message?.content?.text)),
    handler: async (_runtime, message, _state, _options, callback) => {
      const address = addressIn(message?.content?.text);
      if (!address) return { success: false, text: "I need a token contract address (0x...).", data: {} };
      const chain = chainIn(message?.content?.text);
      const r = await callRoute("verdict", { address, chain }, opts);
      let text;
      if (r.status === 200 && r.data) {
        const d = r.data;
        const depth = d.market_depth || {};
        const lines = [
          `${d.token_name || d.token_symbol || address} on ${chain}: grade ${d.grade} (${d.grade_label || d.verdict_tier || "?"}), score ${d.activity_score_0_100}/100.`,
          `${d.transfers_recent ?? "?"} transfers from ${d.unique_wallets_recent ?? "?"} wallets in ${d.window_min ?? "?"}m.`,
          depth.available
            ? `Depth ${usd(depth.liquidity_usd)} across ${depth.pairs_on_chain ?? "?"} pairs, ${usd(depth.volume_24h_usd)} 24h volume.`
            : `Depth unavailable (${depth.reason || "no DEX pair"}).`,
        ];
        if (Array.isArray(d.flags) && d.flags.length) lines.push(`Flags: ${d.flags.join(", ")}.`);
        if (d.plain_take) lines.push(d.plain_take);
        text = lines.filter(Boolean).join(" ");
        if (callback) await callback({ text, action: "TOKEN_VERDICT", content: { grade: d.grade, address, chain } });
        return { success: true, text, data: { grade: d.grade, score: d.activity_score_0_100, flags: d.flags, market_depth: depth } };
      }
      text = paywallLine(r.challenge, "verdict");
      if (callback) await callback({ text, action: "TOKEN_VERDICT" });
      return { success: false, text, data: { challenge: r.challenge, status: r.status } };
    },
  };

  const settleSafeAction = {
    name: "SETTLE_SAFE_CHECK",
    similes: ["CAN_I_SETTLE", "CHECK_SETTLEMENT_SAFETY", "IS_THIS_SAFE_TO_ACCEPT"],
    description:
      "Check whether an asset is safe to settle or accept as payment: canonical registry match, "
      + "ERC-20 readability, decimals and risk flags. Use before quoting a price in an unfamiliar token "
      + "or signing a settlement. $0.02 per lookup, free trial calls each day.",
    examples: [[
      { user: "user", content: { text: "is 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 safe to accept as payment on base?" } },
      { user: "assistant", content: { text: "Checking the asset before you quote in it.", action: "SETTLE_SAFE_CHECK" } },
    ]],
    validate: async (_runtime, message) => Boolean(addressIn(message?.content?.text)),
    handler: async (_runtime, message, _state, _options, callback) => {
      const address = addressIn(message?.content?.text);
      if (!address) return { success: false, text: "I need a contract address to check.", data: {} };
      const chain = chainIn(message?.content?.text);
      const r = await callRoute("settlesafe", { address, chain }, opts);
      let text;
      if (r.status === 200 && r.data) {
        const d = r.data;
        text = `${d.settle_safe ? "SAFE to settle" : "NOT safe to settle"}: ${d.asset_status || "unknown"}.`
          + (Array.isArray(d.reasons) && d.reasons.length ? ` ${d.reasons.join("; ")}` : "");
        if (callback) await callback({ text, action: "SETTLE_SAFE_CHECK" });
        return { success: true, text, data: { settle_safe: d.settle_safe, asset_status: d.asset_status, risk_flags: d.risk_flags } };
      }
      text = paywallLine(r.challenge, "settlesafe");
      if (callback) await callback({ text, action: "SETTLE_SAFE_CHECK" });
      return { success: false, text, data: { challenge: r.challenge, status: r.status } };
    },
  };

  const tokenMintsAction = {
    name: "TOKEN_MINTS",
    similes: ["WHO_CAN_MINT", "CHECK_MINT_AUTHORITY", "SUPPLY_INFLATION_RISK"],
    description:
      "Report mint activity on a token: how many mint events fired, how much supply they created, over "
      + "what block window, and how complete the read was. Use when the user asks about supply inflation, "
      + "hidden mint functions, or whether the team can print more. $0.02 per lookup, free trial calls each day.",
    examples: [[
      { user: "user", content: { text: "can the team still mint 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed?" } },
      { user: "assistant", content: { text: "Checking mint authority and recent prints.", action: "TOKEN_MINTS" } },
    ]],
    validate: async (_runtime, message) => Boolean(addressIn(message?.content?.text)),
    handler: async (_runtime, message, _state, _options, callback) => {
      const address = addressIn(message?.content?.text);
      if (!address) return { success: false, text: "I need a token contract address (0x...).", data: {} };
      const chain = chainIn(message?.content?.text);
      const r = await callRoute("mints", { address, chain }, opts);
      let text;
      if (r.status === 200 && r.data) {
        const d = r.data;
        const win = d.window || {};
        const n = d.mint_count ?? d.events_returned ?? 0;
        const parts = [
          n === 0
            ? `No mint events in the last ${win.window_min ?? "?"} minutes.`
            : `${n} mint event${n === 1 ? "" : "s"} in the last ${win.window_min ?? "?"} minutes, ${d.total_minted ?? "?"} units minted.`,
          d.data_quality ? `Read quality ${d.data_quality}.` : "",
          n > 0 && Array.isArray(d.events) && d.events.length
            ? `Latest mint from ${d.events[0].to || d.events[0].minter || "unknown"} at block ${d.events[0].blockNumber || d.events[0].block || "?"}.`
            : "",
          d.plain_take || "",
        ];
        text = parts.filter(Boolean).join(" ");
        if (callback) await callback({ text, action: "TOKEN_MINTS" });
        return { success: true, text, data: d };
      }
      text = paywallLine(r.challenge, "mints");
      if (callback) await callback({ text, action: "TOKEN_MINTS" });
      return { success: false, text, data: { challenge: r.challenge, status: r.status } };
    },
  };

  const walletScreenAction = {
    name: "WALLET_SCREEN",
    similes: ["CHECK_WALLET_RISK", "IS_THIS_WALLET_SAFE", "SCREEN_COUNTERPARTY"],
    description:
      "Screen a wallet before you transact with it: trust tier and pass/fail, wallet vs contract, "
      + "EIP-7702 delegation, transfer counts and distinct counterparties. Use when the user asks whether "
      + "a counterparty wallet is safe to pay or accept payment from. $0.05 per lookup, free trial calls each day.",
    examples: [[
      { user: "user", content: { text: "should I accept payment from 0x000000000000000000000000000000000000dEaD?" } },
      { user: "assistant", content: { text: "Screening that address first.", action: "WALLET_SCREEN" } },
    ]],
    validate: async (_runtime, message) => Boolean(addressIn(message?.content?.text)),
    handler: async (_runtime, message, _state, _options, callback) => {
      const address = addressIn(message?.content?.text);
      if (!address) return { success: false, text: "I need a wallet address (0x...).", data: {} };
      const chain = chainIn(message?.content?.text);
      const r = await callRoute("wallet", { address, chain }, opts);
      let text;
      if (r.status === 200 && r.data) {
        const d = r.data;
        const parts = [
          `Trust ${d.trust_pass ? "PASS" : "FAIL"} (${d.trust_tier || "unknown"}).`,
          d.is_contract ? "Address holds contract code." : "Ordinary wallet.",
          d.eip_7702_delegated ? "EIP-7702 delegated: the code can act with this address's authority." : "",
          d.total_txs_sent !== undefined ? `${d.total_txs_sent} transactions sent, ${d.unique_counterparties ?? 0} distinct counterparties.` : "",
          Array.isArray(d.trust_reasons) && d.trust_reasons.length ? d.trust_reasons.join("; ") + "." : "",
          d.plain_take || "",
        ];
        text = parts.filter(Boolean).join(" ");
        if (callback) await callback({ text, action: "WALLET_SCREEN" });
        return { success: true, text, data: d };
      }
      text = paywallLine(r.challenge, "wallet");
      if (callback) await callback({ text, action: "WALLET_SCREEN" });
      return { success: false, text, data: { challenge: r.challenge, status: r.status } };
    },
  };

  const forensicsProvider = {
    name: "FORENSICS_CONTEXT",
    description: "On-chain risk context: what the Forensics routes answer and what each one costs.",
    position: 90,
    get: async (_runtime, message) => {
      const text = String(message?.content?.text || "");
      const relevant = /token|coin|contract|wallet|settle|payment|0x[0-9a-fA-F]{40}|rug|scam|mint|liquidity/i.test(text);
      if (!relevant) return { text: "", values: {}, data: {} };
      return {
        text: [
          "On-chain Forensics is available through actions TOKEN_VERDICT, SETTLE_SAFE_CHECK, TOKEN_MINTS and WALLET_SCREEN.",
          "Each returns a deterministic answer with no LLM in the decision path: a verdict carries a grade, an",
          "activity score, holder breadth and DEX depth; settlesafe carries a settle/no-settle decision; mints",
          "carries mint authority and recent prints; wallet screens a counterparty. A first call per day is free,",
          "then $0.02-$0.05 in USDC on Base. Never guess a token's safety from the name: call the action with the",
          `contract address. Full catalog: ${CATALOG}`,
        ].join(" "),
        values: { routes: Object.keys(ROUTES), prices_usd: Object.fromEntries(Object.entries(ROUTES).map(([k, v]) => [k, v.price])) },
        data: {},
      };
    },
  };

  return {
    name: "onchain-forensics",
    description:
      "Token due diligence for agents: A-F risk grades with holder breadth and DEX depth, settlement-safety "
      + "checks, mint-authority forensics and wallet screening, over the x402-payable On-chain Forensics API.",
    actions: [tokenVerdictAction, settleSafeAction, tokenMintsAction, walletScreenAction],
    providers: [forensicsProvider],
    evaluators: [],
    services: [],
  };
}

const plugin = createForensicsPlugin();
export default plugin;
export { plugin };
