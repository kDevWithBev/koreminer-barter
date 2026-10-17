// Claim checker. It does not touch the runner, the seed, or a payout.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { BRIDGE } from "./claim.mjs";
import { checkLink, commitLink, readLinks, saveLinks } from "./links.mjs";
import { signatureOwns } from "./claim-sig.mjs";
import * as KeetaNet from "@keetanetwork/keetanet-client";

const dir = "/opt/koreminer";
const claims = `${dir}/claims`;
const noncesPath = `${claims}/nonces.json`;
const linksPath = `${dir}/links.json`;
const rpc = process.env.BASE_RPC || "https://base.gateway.tenderly.co";
const hits = new Map();

function readNonces() {
  try { return JSON.parse(readFileSync(noncesPath, "utf8")); } catch { return []; }
}

function writeJson(path, value) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path);
}

function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((time) => now - time < 3_600_000);
  if (recent.length >= 20) return true;
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

async function ethCall(to, data) {
  const response = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "koreminer/1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const body = await response.json();
  return body.result ?? "";
}

const blocked = new Set([
  BRIDGE,
  "keeta_aabxtne7hbivzeknf3c6dw7rb7uiln7pbntwubrwccb7uz62ihjlmlaordxh6fa",
  "keeta_aabe7jhqj3bzv3jg3l6el5myl24yvjawy73btyurwdv5kyhpsmv7a2yec4ep4sq",
]);

function payable(value) {
  if (typeof value !== "string" || !/^keeta_[a-z0-9]{40,80}$/.test(value)) return false;
  if (blocked.has(value)) return false;
  try {
    const account = KeetaNet.lib.Account.fromPublicKeyString(value);
    return account.publicKeyString.toString() === value;
  } catch {
    return false;
  }
}

async function decide(body) {
  if (body?.check === "address") {
    return payable(body.keeta) ? { ok: true } : { ok: false, reason: "bad-keeta" };
  }
  const checked = checkLink(body);
  if (!checked.ok) return checked;
  if (!payable(checked.keeta)) return { ok: false, reason: "bad-keeta" };
  const nonces = readNonces();
  if (nonces.includes(checked.nonce)) return { ok: false, reason: "used-nonce" };
  const owned = await signatureOwns({
    message: checked.message,
    signature: body.signature,
    base: checked.base,
    call: ethCall,
  });
  if (!owned) return { ok: false, reason: "bad-signature" };
  const links = commitLink(readLinks(linksPath), checked);
  nonces.push(checked.nonce);
  writeJson(noncesPath, nonces);
  saveLinks(linksPath, links);
  return { ok: true, base: checked.base, keeta: checked.keeta };
}

mkdirSync(claims, { recursive: true });
const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/verify") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: "not-found" }));
    return;
  }
  const ip = req.socket.remoteAddress ?? "unknown";
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body?.check !== "address" && limited(ip)) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "slow-down" }));
      return;
    }
    const result = await decide(body);
    res.writeHead(result.ok ? 200 : 400, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: "bad-request" }));
  }
});

if (process.argv[1] && process.argv[1].endsWith("claimd.mjs")) {
  server.listen(8791, "127.0.0.1", () => console.log("Claim checker on 127.0.0.1:8791"));
}

export { decide };
