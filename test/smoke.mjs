import plugin, { createForensicsPlugin, callRoute } from "../dist/index.js";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const byName = Object.fromEntries(plugin.actions.map((a) => [a.name, a]));
check("plugin exposes 4 actions", plugin.actions.length === 4, plugin.actions.map((a) => a.name).join(","));
check("plugin has a provider", plugin.providers.length === 1, String(plugin.providers[0]?.name));

const addrMsg = { content: { text: "is 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed safe to hold?" } };
const emptyMsg = { content: { text: "hey, what's up?" } };
for (const [name, action] of Object.entries(byName)) {
  check(`${name} validate(address)`, (await action.validate({}, addrMsg)) === true);
  check(`${name} validate(no address)`, (await action.validate({}, emptyMsg)) === false);
}

// provider ignores small talk, answers on on-chain questions
const prov = plugin.providers[0];
const quiet = await prov.get({}, emptyMsg);
check("provider stays quiet on small talk", quiet.text === "", JSON.stringify(quiet.text).slice(0, 40));
const loud = await prov.get({}, addrMsg);
check("provider injects route context", loud.text.includes("TOKEN_VERDICT"), String(loud.text).length + " chars");

// live call: mint activity (free trial allowance)
let cb = null;
const mints = await byName.TOKEN_MINTS.handler(
  {}, addrMsg, {}, {},
  async (r) => { cb = r; },
);
check("TOKEN_MINTS returns text", typeof mints.text === "string" && mints.text.length > 20, mints.text.slice(0, 90));
check("TOKEN_MINTS callback fired", Boolean(cb && cb.text), cb ? "ok" : "no callback");

// live call: wallet screen
const wallet = await byName.WALLET_SCREEN.handler({}, addrMsg, {}, {});
check("WALLET_SCREEN returns text", typeof wallet.text === "string" && wallet.text.length > 20, wallet.text.slice(0, 90));

// paywall path: forced non-trial call on a fresh route must decode a challenge, not throw
const paid = await callRoute("verdict", { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chain: "base" }, { trial: false });
check("paid call returns 402 + decoded price", paid.status === 402 && paid.challenge?.price_usd === 0.02, `status ${paid.status}, $${paid.challenge?.price_usd} to ${paid.challenge?.payTo}`);

// handler must degrade to the price line, never throw, when the paywall is hit
const blocked = await byName.TOKEN_VERDICT.handler({}, addrMsg, {}, {});
check("TOKEN_VERDICT degrades cleanly", typeof blocked.text === "string" && blocked.text.length > 20, blocked.text.slice(0, 100));

// config hook is respected
const custom = createForensicsPlugin({ payFetch: async () => new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }) });
const hooked = await custom.actions[0].handler({}, addrMsg, {}, {});
check("payFetch hook is used", hooked.success === true, hooked.text.slice(0, 60));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
