# plugin-onchain-forensics

Give your elizaOS agent an opinion about a token contract before it trades one.

Four actions, no LLM in the decision path: the agent asks a deterministic engine, and the engine
answers with a grade, a score and the evidence behind it.

```
npx elizaos plugins add plugin-onchain-forensics
```

or

```bash
npm install plugin-onchain-forensics
```

## What the agent gets

| Action | The question it answers | Price |
| --- | --- | --- |
| `TOKEN_VERDICT` | Is this token alive, and how risky is a buy? | $0.02 |
| `SETTLE_SAFE_CHECK` | Can I settle in it or accept it as payment? | $0.02 |
| `TOKEN_MINTS` | Is supply still being printed? | $0.02 |
| `WALLET_SCREEN` | Does this counterparty wallet check out? | $0.05 |

A real answer from `TOKEN_VERDICT`:

```
USD Coin (USDC) on base: grade A (LIVE AND BROAD), score 89/100.
1504 transfers from 640 wallets in 108m. Depth $30M across 12 pairs, $41M 24h volume.
```

The grade carries its basis. `market_depth` can raise a flow-only grade
(`grade_basis: "flow+depth"`) but it can never lower one, never override a risk flag, and never
lift a non-token. A quiet token with $30M of liquidity reads `C / QUIET BUT LIQUID`, not `F`.

## Wiring it into a character

```js
import forensics from "plugin-onchain-forensics";

export const character = {
  name: "Desk",
  plugins: [forensics],
  // ...
};
```

The provider `FORENSICS_CONTEXT` injects the route menu and prices only when a message mentions
tokens, contracts, wallets, settlement, rugs or liquidity. Small talk stays clean.

## Paying for calls

Every route gives free trial calls each day, so a fresh agent gets a real answer before it ever
needs a wallet. After the trial, the route returns its x402 challenge, and the plugin decodes it
into price, network and `payTo` so the agent can state the cost instead of throwing.

To settle paid calls, pass a fetch wrapper that handles x402:

```js
import { wrapFetchWithPayment } from "x402-fetch";
import { createForensicsPlugin } from "plugin-onchain-forensics";

const forensics = createForensicsPlugin({
  payFetch: wrapFetchWithPayment(fetch, walletClient), // USDC on Base, eip155:8453
});
```

`createForensicsPlugin` also takes `creditKey` (sent as `X-Credit-Key` for prepaid tiers) and
`trial: false` to skip the free sample and always present the paid path.

## Why an agent should not guess

A model that has never seen a contract will still answer "looks fine". `TOKEN_VERDICT` returns
`data_quality` and a `window` on every call, so a partial read is reported as partial instead of
being rounded down to zero. No signer, no data, or unreadable chain all come back as a labelled
state, never as a confident "A".

Full catalog, prices and the OpenAPI spec: <https://onchainforensics.dev/llms.txt>

## Test

```bash
npm run smoke
```

Runs 18 checks against the live API: action wiring, provider gating, a real trial call, the 402
degradation path, and the `payFetch` hook.

MIT licensed. Issues and feature requests: <https://github.com/leohoudinisanders-byte/plugin-onchain-forensics>.
