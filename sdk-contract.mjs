// The KeetaNet SDK surface the pit runner uses (pit-run.mjs, the pit half of chain.mjs, run.mjs's pit hand-off), checked
// against the REAL SDK by sdk-contract-check.mjs and by ops/pit-preflight.mjs on the server. Box 3 on Oct 26 fell back
// because a fake client hid that UserClient has no getHistory. No network calls here, no keys.
export const SDK_VERSION = "0.18.7"; // /opt/koreminer/node_modules, client/index.js md5 4ccd1d4637c00aec945a499492ed4fee
export const CLIENT_CALLS = ["pendingBlock", "balance", "initBuilder", "publishBuilder", "getQuotes"]; // client.X (UserClient)
export const NETWORK_CALLS = ["getHistory"]; // client.client.X (the UserClient's network Client), any account
export const BUILDER_CALLS = ["send", "computeBlocks", "computeFeeBlock"]; // builder.X (UserClientBuilder)

// Names of the SDK pieces that are missing. uc is a UserClient made by UserClient.fromNetwork (read-only is fine).
export function sdkMissing(KN, uc) {
  const miss = [];
  const fn = (o, n, label) => { if (typeof o?.[n] !== "function") miss.push(label); };
  fn(KN?.UserClient, "fromNetwork", "UserClient.fromNetwork");
  for (const n of ["fromPublicKeyString", "fromSeed", "generateBaseAddresses"]) fn(KN?.lib?.Account, n, `lib.Account.${n}`);
  if (typeof KN?.lib?.Vote?.Staple !== "function") miss.push("lib.Vote.Staple");
  for (const n of CLIENT_CALLS) fn(uc, n, `UserClient.${n}`);
  if (!uc?.client) miss.push("UserClient.client");
  for (const n of NETWORK_CALLS) fn(uc?.client, n, `UserClient.client.${n}`);
  for (const n of BUILDER_CALLS) fn(KN?.Client?.Builder?.prototype, n, `Client.Builder.${n}`);
  return miss;
}

// A UserClient with no signer that reads as `account` (a public key). It cannot sign or publish anything.
export function readOnlyClient(KN, account) {
  return KN.UserClient.fromNetwork("main", null, { account: KN.lib.Account.fromPublicKeyString(account) });
}

// Every client./client.client./builder. call in the given sources, so a new call cannot skip the lists above.
export function callsIn(src) {
  const out = new Set();
  src = src.replace(/\/\/.*$/gm, ""); // comments are not calls
  for (const m of src.matchAll(/\bclient\.client\.(\w+)/g)) out.add(`client.client.${m[1]}`);
  for (const m of src.matchAll(/(?<!\.)\bclient\??\.(?!client\b)(\w+)/g)) out.add(`client.${m[1]}`);
  for (const m of src.matchAll(/\bbuilder\??\.(\w+)/g)) out.add(`builder.${m[1]}`);
  for (const m of src.matchAll(/\binitBuilder\(\)\.(\w+)/g)) out.add(`builder.${m[1]}`);
  return out;
}
export const KNOWN_CALLS = new Set([...CLIENT_CALLS.map((n) => `client.${n}`), ...NETWORK_CALLS.map((n) => `client.client.${n}`), ...BUILDER_CALLS.map((n) => `builder.${n}`)]);
