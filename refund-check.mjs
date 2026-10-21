import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, constants, copyFileSync, existsSync, fchmodSync, fchownSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { accounted, booksFromJson } from "./books.mjs";
import { RESERVE } from "./share.mjs";
import { main, DRAIN_SHA256, MEMO, INTAKE, REFUND_FEE_CAP } from "./refund.mjs";

const RAW = 10n ** 18n;
const BASE = { id: "kta" };
const BASE_TEXT = "kta";
const FIXTURE = new URL("./refund-fixture-books.json", import.meta.url);
const DRAIN = new URL("./refund-drain.json", import.meta.url);
const SINK = "keeta_aabe7jhqj3bzv3jg3l6el5myl24yvjawy73btyurwdv5kyhpsmv7a2yec4ep4sq";
const TREY_A = "keeta_aabik63e6x7svkclg74scrqe373rhy5v4xtbp7lx7wcbkrdk2evpiqcl3cihd2i";
const TREY_B = "keeta_aabz6zxbs2n4r7iiobclndobrnowxdf4pjrb5lwe6bvpeo564bot6krjbrsbbvy";
const BRIDGE = "keeta_aqltdal4rshtky5iehd765y3mdjkcmku5d4ulo5fgonzqrxulwepnogq33mle";
const EXCLUDED = new Set([TREY_A, TREY_B, BRIDGE, INTAKE, SINK]);
const NOW = () => Date.parse("2026-10-20T12:00:00.000Z");
const FEE = 4n * 10n ** 15n;
const tmpBefore = new Set(readdirSync(tmpdir()));
const SUITE = mkdtempSync(join(tmpdir(), "kore-refund-suite-"));
const plantSlot = { current: null };
const stopViolations = [];
let mainCalls = 0;
let stopCreated = 0;
let suiteGone = false;

function suiteParentIsSafe(path) {
  return dirname(path) === tmpdir() && basename(path).startsWith("kore-refund-suite-");
}

function removeSuite() {
  if (suiteGone || !existsSync(SUITE) || !suiteParentIsSafe(SUITE)) return;
  rmSync(SUITE, { recursive: true, force: true });
  suiteGone = true;
}

process.on("exit", () => {
  console.log(`F-A checked ${mainCalls} main() calls, ${stopCreated} created STOP, ${stopViolations.length} violations`);
  for (const row of stopViolations) console.log(`F-A violation ${row.label} ${row.detail}`);
  try { removeSuite(); } catch { /* the failure is already reported */ }
});

function plantStop(dir, body) {
  const path = join(dir, "STOP");
  writeFileSync(path, body);
  const st = statSync(path);
  plantSlot.current = { bytes: readFileSync(path), mtimeMs: st.mtimeMs, mode: st.mode, ino: st.ino };
}

function callerOfGo() {
  const lines = (new Error().stack ?? "").split("\n");
  const hit = lines.find((line) => line.includes("refund-check.mjs") && !/\bat (async )?(go|run|callerOfGo)\b/.test(line));
  return (hit ?? "unknown call").trim();
}

function stopAllowlist(source) {
  const reasons = [];
  const lines = source.split("\n");
  const allowedStop = [
    'for (const name of ["STOP", "HALT", "PAYHOLD", "FEEHOLD"]) {',
    'stopFd = io.openSync(`${dir}/STOP`, "wx", 0o600); // GUARD:R4-exclusive',
    'return refuse("STOP already exists");',
    'io.chmodSync(`${dir}/STOP`, 0o600);',
  ];
  const stopLines = lines.map((line) => line.trim()).filter((line) => line.includes("STOP"));
  if (stopLines.length !== allowedStop.length || stopLines.some((line, index) => line !== allowedStop[index])) {
    reasons.push(`STOP lines ${JSON.stringify(stopLines)}`);
  }
  const allowedFd = [
    "let stopFd;",
    'stopFd = io.openSync(`${dir}/STOP`, "wx", 0o600); // GUARD:R4-exclusive',
    'io.writeFileSync(stopFd, "refund in progress\\n");',
    "io.fsyncSync(stopFd);",
    "} finally { io.closeSync(stopFd); }",
  ];
  const fdLines = lines.map((line) => line.trim()).filter((line) => line.includes("stopFd"));
  if (fdLines.length !== allowedFd.length || fdLines.some((line, index) => line !== allowedFd[index])) {
    reasons.push(`stopFd lines ${JSON.stringify(fdLines)}`);
  }
  if (source.includes("clearStop")) reasons.push("clearStop is present");
  if (/\brmSync\b/.test(source) || /\brmdirSync\b/.test(source)) reasons.push("rmSync or rmdirSync is present");
  const stripped = source
    .replace(/import \{\n[\s\S]*?\} from "node:fs";\n/, "")
    .replace(/function bindIo\(hook = \{\}\) \{[\s\S]*?\n\}/, "");
  if (/(?<!io\.)\bunlinkSync\b/.test(stripped) || /(?<!io\.)\brenameSync\b/.test(stripped)) {
    reasons.push("bare unlinkSync or renameSync outside import and bindIo");
  }
  const count = (text, needle) => text.split(needle).length - 1;
  if (count(source, "io.unlinkSync(") !== 1) reasons.push("io.unlinkSync( count");
  if (count(source, "io.renameSync(") !== 2) reasons.push("io.renameSync( count");
  if (count(source, "bestEffortUnlink(") !== 2) reasons.push("bestEffortUnlink( count");
  if (/\bunlink\s*\(/.test(source) || /\brename\s*\(/.test(source) || /\brm\s*\(/.test(source) || /\brmdir\s*\(/.test(source)) {
    reasons.push("async unlink rename rm or rmdir");
  }
  if (source.includes("node:fs/promises") || source.includes("fs/promises") || source.includes(".promises")) reasons.push("promises");
  const spawns = lines.filter((line) => line.includes("spawnSync("));
  if (spawns.length !== 1 || !spawns[0].includes("systemctl")) reasons.push("spawnSync");
  if (/\bexecSync\s*\(/.test(source) || /\bexecFile(Sync)?\s*\(/.test(source) || /\bfork\s*\(/.test(source) || /\bexec\s*\(/.test(source) || /\bspawn\s*\(/.test(source)) {
    reasons.push("exec fork or spawn");
  }
  if (source.includes("io[")) reasons.push("computed io access");
  if (/\brequire\s*\(/.test(source) || source.includes("createRequire")) reasons.push("require");
  if (/\btruncateSync\b/.test(source) || /\bftruncateSync\b/.test(source) || /\btruncate\s*\(/.test(source) || /\butimesSync\b/.test(source) || /\bfutimesSync\b/.test(source) || /\blutimesSync\b/.test(source) || /\butimes\s*\(/.test(source)) {
    reasons.push("truncate or utimes");
  }
  const dynamics = [...source.matchAll(/\bimport\s*\([^)\n]*\)/g)].map((match) => match[0]);
  if (dynamics.length !== 3 || dynamics.some((item) => item !== 'import("@keetanetwork/keetanet-client")')) {
    reasons.push(`dynamic import ${JSON.stringify(dynamics)}`);
  }
  if ([...source.matchAll(/\bimport\s*\(/g)].length !== (source.match(/await import\("@keetanetwork\/keetanet-client"\)/g) ?? []).length) {
    reasons.push("dynamic import is not awaited");
  }
  return { ok: reasons.length === 0, reason: reasons.join("; ") };
}

const allow = stopAllowlist(readFileSync(new URL("./refund.mjs", import.meta.url), "utf8"));
console.log(`F-A allowlist ${allow.ok ? "ok" : `FAIL ${allow.reason}`}`);

function removeReceipts(dir) {
  const refundDir = join(dir, "refund");
  if (!existsSync(refundDir)) return;
  for (const name of readdirSync(refundDir)) {
    if (name.startsWith("receipt-")) rmSync(join(refundDir, name));
  }
}

function countingFs(inner = {}) {
  const counter = { n: 0 };
  const real = { mkdirSync, chmodSync, fchmodSync, fchownSync, writeFileSync, appendFileSync, copyFileSync, renameSync, unlinkSync, openSync };
  const fs = { ...inner };
  for (const name of ["mkdirSync", "chmodSync", "fchmodSync", "fchownSync", "writeFileSync", "appendFileSync", "copyFileSync", "renameSync", "unlinkSync"]) {
    const impl = inner[name] ?? real[name];
    fs[name] = (...args) => {
      counter.n += 1;
      return impl(...args);
    };
  }
  const openImpl = inner.openSync ?? openSync;
  fs.openSync = (path, flags, mode) => {
    if (flags !== "r") counter.n += 1;
    return openImpl(path, flags, mode);
  };
  return { fs, counter };
}

const FE_STOP = "Stop. Do not adjust books. Send this output to Forge and KeeLend Ops.";

function feStopped(result, counter, shot, dir, books, hash) {
  const first = `REFUND_VERIFY: UNKNOWN_RECEIPT_NO_DONE ${hash}`;
  return result.code === 4
    && result.lines.length === 3
    && result.lines[0].startsWith("REFUND verify ")
    && result.lines[1] === first
    && result.lines[2] === FE_STOP
    && !has(result.lines, "BOOKS_MISMATCH")
    && !has(result.lines, "BOOKS_OK")
    && !has(result.lines, "REFUND_LANDED")
    && !has(result.lines, "finished now")
    && quiet(result.lines)
    && !result.lines.join("\n").includes("SECRET")
    && snapshot(dir) === shot
    && counter.n === 0
    && readFileSync(join(dir, "books.json")).equals(books);
}

async function twoVerifies(ran, hash, innerFactory) {
  const books = readFileSync(ran.booksPath);
  const seen = [];
  for (let i = 0; i < 2; i += 1) {
    const shot = snapshot(ran.dir);
    const counted = countingFs(innerFactory ? innerFactory() : {});
    const verified = await ran.again(["--verify"], { fs: counted.fs });
    seen.push(feStopped(verified, counted.counter, shot, ran.dir, books, hash));
  }
  return seen.every(Boolean);
}

const EXPECT = {
  aabd7qpx: "10558.233467",
  aab3cujp: "1497.191981",
  aab6z3pj: "1390.000000",
  aabemrl4: "960.606044",
  aabsq7gb: "851.638650",
  aab2mszm: "300.000000",
  aabal6jl: "133.365418",
  aabjln6p: "100.000000",
  aabbhuaq: "93.999606",
  aabffpbw: "92.192513",
  aabalimm: "91.354718",
  aabiilnj: "84.046341",
  aabjveq4: "54.447412",
  aabrmmct: "4.750445",
};

let passed = 0;
function check(name, ok) {
  if (!ok) throw new Error(name);
  passed += 1;
  console.log("ok", name);
}

function grab(lines, prefix) {
  const line = lines.find((item) => item.startsWith(prefix));
  if (!line) throw new Error(`missing ${prefix}`);
  return line.slice(prefix.length);
}

function has(lines, text) {
  return lines.some((line) => line.includes(text));
}

function oldHistory() {
  return [{
    voteStaple: {
      timestamp: () => new Date("2026-10-01T00:00:00.000Z"),
      blocksHash: { toString: () => "OLD" },
      blocks: [],
    },
  }];
}

function hashOf(text) {
  return { toString: () => text };
}

function staple(hash, fee, external = MEMO) {
  return {
    voteStaple: {
      timestamp: () => new Date("2026-10-20T12:00:00.000Z"),
      blocksHash: { toString: () => "STAPLE" },
      blocks: [
        {
          account: INTAKE,
          hash: hashOf(hash),
          operations: [{ type: 0, external, amount: 1n, token: BASE, to: "x" }],
        },
        {
          account: INTAKE,
          hash: hashOf("FEE"),
          operations: [{ type: 0, amount: fee, token: BASE, to: "fee" }],
        },
      ],
    },
  };
}

function defaultQuotes() {
  return [0, 1, 2, 3].map(() => ({ fee: { amount: 10n ** 15n, token: BASE } }));
}

function snapshot(dir) {
  const rows = [];
  function add(path, st) {
    const kind = st.isDirectory() ? "dir" : "file";
    const body = st.isDirectory() ? "" : createHash("sha256").update(readFileSync(path)).digest("hex");
    rows.push(`${path}:${kind}:${st.mode}:${st.mtimeMs}:${body}`);
  }
  function walk(path) {
    const st = statSync(path);
    add(path, st);
    if (!st.isDirectory()) return;
    for (const name of readdirSync(path).sort()) walk(join(path, name));
  }
  walk(dir);
  return rows.join("\n");
}

function parseRows(lines) {
  const rows = [];
  for (const line of lines) {
    const match = line.match(/^(\d+) (keeta_[a-z0-9]+) stake (\S+) weight (\S+) addback (\S+) total (\S+) raw (\d+)$/);
    if (match) rows.push({ n: match[1], key: match[2], stake: match[3], weight: match[4], addback: match[5], total: match[6], raw: match[7] });
  }
  return rows;
}

async function run(opts = {}) {
  const dir = mkdtempSync(join(SUITE, "kore-refund-"));
  const booksPath = join(dir, "books.json");
  writeFileSync(booksPath, opts.booksText ?? readFileSync(FIXTURE));
  const books = booksFromJson(JSON.parse(readFileSync(booksPath, "utf8")));
  const live = {
    balance: opts.balance ?? accounted(books),
    pending: opts.pending ?? null,
    history: opts.history ?? oldHistory(),
    quotes: Object.prototype.hasOwnProperty.call(opts, "quotes") ? opts.quotes : [0, 1, 2, 3].map(() => ({ fee: { amount: 10n ** 15n, token: opts.base ?? BASE } })),
  };
  const counts = { publish: 0, send: 0, recover: 0, quotes: 0, builds: 0, feeBuilds: 0, init: 0, seed: 0, balance: 0, pending: 0 };
  const opened = [];
  const blockHash = opts.blockHash ?? "REFUNDHASH";
  let balanceReads = 0;
  let pendingReads = 0;
  const client = {
    async balance() {
      counts.balance += 1;
      balanceReads += 1;
      if (opts.onBalance) return opts.onBalance(balanceReads, live);
      return live.balance;
    },
    async pendingBlock() {
      counts.pending += 1;
      pendingReads += 1;
      if (opts.onPending) return opts.onPending(pendingReads, live);
      return live.pending;
    },
    async getQuotes() {
      counts.quotes += 1;
      if (opts.onQuote) await opts.onQuote(dir, live);
      return live.quotes;
    },
    async publishBuilder(builder, options) {
      counts.publish += 1;
      const blocks = client.lastBlock ? [client.lastBlock] : [];
      const quoteList = options?.quotes ?? live.quotes;
      const voteSource = opts.voteFees ?? quoteList;
      const votes = (Array.isArray(voteSource) ? voteSource : []).map((entry) => ({ fee: entry?.fee ?? entry }));
      const staple = { votes, blocks };
      client.lastFeeCall = { staple, options, blocksIsArray: Array.isArray(staple.blocks), votesIsArray: Array.isArray(staple.votes) };
      if (typeof options?.generateFeeBlock === "function") {
        await options.generateFeeBlock(staple, options);
      }
      if (opts.onPublish) return opts.onPublish(builder, options, { dir, live, blockHash, counts });
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(blockHash) }] } };
    },
    async send() { counts.send += 1; throw new Error("send"); },
    async recover() { counts.recover += 1; throw new Error("recover"); },
    initBuilder() {
      counts.init += 1;
      const sends = [];
      return {
        sends,
        send(to, amount, token, external) { sends.push({ to, amount, token, external }); },
        async computeBlocks() {
          counts.builds += 1;
          if (opts.computeBlocks) return opts.computeBlocks(sends, blockHash);
          const operations = sends.map((row) => ({
            type: 0,
            to: row.to,
            token: row.token,
            amount: row.amount,
            external: row.external,
          }));
          const block = { hash: hashOf(blockHash), account: INTAKE, operations };
          client.lastBlock = block;
          client.sends = sends;
          return { blocks: [block] };
        },
        async computeFeeBlock(voteStaple) {
          counts.feeBuilds += 1;
          if (opts.computeFeeBlock) return opts.computeFeeBlock(voteStaple);
          let kta = 0n;
          for (const vote of voteStaple?.votes ?? []) {
            const fee = vote?.fee ?? vote;
            if (typeof fee?.amount === "bigint") kta += fee.amount;
          }
          if (opts.feeOverride !== undefined) kta = opts.feeOverride;
          return { operations: [{ type: 0, token: opts.base ?? BASE, amount: kta }] };
        },
      };
    },
  };
  if (opts.useHistory) {
    client.history = async () => live.history;
  } else {
    client.getHistory = async () => {
      if (opts.getHistory) return opts.getHistory(live);
      return live.history;
    };
  }
  const fs = opts.fs ?? (opts.trackReads ? {
    readFileSync: (path, ...args) => {
      opened.push(String(path));
      return readFileSync(path, ...args);
    },
  } : undefined);
  const baseDeps = {
    dir,
    now: opts.now ?? NOW,
    systemctl: opts.systemctl ?? (() => "inactive"),
    processes: opts.processes ?? (() => []),
    loadWallet: (walletDir) => {
      counts.seed += 1;
      if (opts.loadWallet) return opts.loadWallet(walletDir);
      return { publicKeyString: INTAKE };
    },
    accountFrom: opts.accountFrom ?? ((id) => ({ publicKeyString: id })),
    base: opts.base ?? BASE,
    baseText: opts.baseText ?? BASE_TEXT,
    client,
    fs,
    drainPath: opts.drainPath,
    uid: opts.uid !== undefined ? opts.uid : 0,
  };
  if (opts.useProc) {
    delete baseDeps.processes;
    baseDeps.procRoot = opts.procRoot;
  }
  if (typeof opts.procRootDir === "string") baseDeps.procRootDir = opts.procRootDir;
  if (opts.drainSha !== undefined) baseDeps.drainSha = opts.drainSha;
  if (opts.plannerFault) baseDeps.plannerFault = opts.plannerFault;
  async function go(argv, extra = {}) {
    const lines = [];
    mainCalls += 1;
    const callLabel = callerOfGo();
    const stopPath = join(dir, "STOP");
    let before = null;
    if (existsSync(stopPath)) {
      const st = statSync(stopPath);
      before = { bytes: readFileSync(stopPath), mtimeMs: st.mtimeMs, mode: st.mode, ino: st.ino };
    }
    plantSlot.current = null;
    let created = false;
    const testFs = Object.prototype.hasOwnProperty.call(extra, "fs") ? extra.fs : baseDeps.fs;
    const inner = testFs && typeof testFs === "object" ? testFs : {};
    const innerOpen = typeof inner.openSync === "function" ? inner.openSync.bind(inner) : openSync;
    const wrapped = {
      ...inner,
      openSync(path, flags, mode) {
        const exclusive = typeof flags === "string" ? flags.includes("x") : typeof flags === "number" && (flags & constants.O_EXCL) !== 0;
        const fd = innerOpen(path, flags, mode);
        if (exclusive && String(path) === stopPath) created = true;
        return fd;
      },
    };
    const code = await main({
      ...baseDeps,
      ...extra,
      argv,
      output: (line) => lines.push(line),
      fs: wrapped,
    });
    if (created) stopCreated += 1;
    const problems = [];
    const planted = plantSlot.current;
    function currentStop() {
      const st = statSync(stopPath);
      return { bytes: readFileSync(stopPath), mtimeMs: st.mtimeMs, mode: st.mode, ino: st.ino };
    }
    function sameStop(left, right) {
      return left.bytes.equals(right.bytes) && left.mtimeMs === right.mtimeMs && left.mode === right.mode && left.ino === right.ino;
    }
    if (before) {
      if (!existsSync(stopPath)) problems.push("STOP existed before and is missing");
      else if (!sameStop(before, currentStop())) problems.push("STOP existed before and changed");
    } else if (planted) {
      if (!existsSync(stopPath)) problems.push("planted STOP is missing");
      else if (!sameStop(planted, currentStop())) problems.push("planted STOP changed");
    }
    if (created) {
      if (!existsSync(stopPath)) problems.push("created STOP is missing");
      else {
        const now = currentStop();
        if (!now.bytes.equals(Buffer.from("refund in progress\n"))) problems.push("created STOP bytes differ");
        if ((now.mode & 0o777) !== 0o600) problems.push("created STOP mode is not 0600");
      }
    }
    if (problems.length) stopViolations.push({ label: callLabel, detail: problems.join("; ") });
    if (counts.send || counts.recover) throw new Error("client.send or client.recover was called");
    return { code, lines, dir, counts, opened, live, client, booksPath, booksBefore: readFileSync(booksPath), stopKept: problems.length === 0 };
  }
  const first = await go(opts.argv ?? []);
  first.again = go;
  first.booksAtStart = readFileSync(booksPath);
  return first;
}

function reason(lines) {
  const line = lines.find((item) => item.startsWith("REFUND_REFUSED:"));
  return line ?? "";
}

let planCache;
async function plan() {
  if (planCache) return planCache;
  const dry = await run({ argv: ["--no-quote"] });
  planCache = {
    total: grab(dry.lines, "TOTAL "),
    n: grab(dry.lines, "N "),
    plan: grab(dry.lines, "PLAN "),
    lines: dry.lines,
  };
  return planCache;
}

function sendArgv(info, patch = {}) {
  return [
    "--send",
    "--confirm-total", patch.total ?? info.total,
    "--confirm-count", patch.n ?? info.n,
    "--confirm-plan", patch.plan ?? info.plan,
  ];
}

function land(info) {
  const total = BigInt(info.lines.find((line) => line.startsWith("TOTAL ")).slice(6).replace(".", "") );
  // TOTAL is 18 dp, so removing the dot is the raw integer only when there are exactly 18 dp.
  const raw = BigInt(grab(info.lines, "TOTAL ").replace(".", ""));
  return { raw, fee: FEE };
}

check("drain file sha matches the pin", createHash("sha256").update(readFileSync(DRAIN)).digest("hex") === DRAIN_SHA256);

const t1 = await run({ argv: ["--no-quote"] });
const rows = parseRows(t1.lines);
check("T1 fourteen rows", rows.length === 14 && t1.code === 0);
for (const [prefix, total] of Object.entries(EXPECT)) {
  const row = rows.find((item) => item.key.includes(prefix));
  check(`T1 ${prefix} total`, row?.total === total);
}
check("T1 pool", grab(t1.lines, "POOL ") === "1722.950000000000000000");
check("T1 addbacks", grab(t1.lines, "ADDBACKS ") === "1722.949999999999999994");
check("T1 dust", grab(t1.lines, "DUST ") === "6");
check("T1 raw total", grab(t1.lines, "TOTAL ") === "16211.826599999999999994");
check("T1 count", grab(t1.lines, "N ") === "14");
check("T1 excluded absent from sends", rows.every((row) => !EXCLUDED.has(row.key)));

const quoted = await run({ argv: [] });
check("T2 pool is excluded stake minus the fee budget", grab(quoted.lines, "POOL ") === "1722.950000000000000000");
const sentTo = (quoted.client.sends ?? []).map((row) => row.to.publicKeyString);
check("T2 excluded keys are not recipients", sentTo.length === 14 && sentTo.every((key) => !EXCLUDED.has(key)));
{
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const extra = (10n * RAW).toString();
  raw.stake[TREY_A] = (BigInt(raw.stake[TREY_A]) + 10n * RAW).toString();
  raw.lots.find((lot) => lot.from === TREY_A).remaining = raw.stake[TREY_A];
  const varied = await run({ argv: [], booksText: JSON.stringify(raw) });
  check("T2 pool follows Trey stake", grab(varied.lines, "POOL ") === "1732.950000000000000000");
  check("T2 changed Trey stake is still excluded", !(varied.client.sends ?? []).some((row) => row.to.publicKeyString === TREY_A));
}

const capOk = await run({ argv: [], quotes: [{ fee: { amount: REFUND_FEE_CAP, token: BASE } }] });
check("T3 exact fee cap passes", capOk.code === 0 && has(capOk.lines, "REFUND_DRY_RUN_OK") && capOk.counts.publish === 0);
const capOver = await run({
  argv: [],
  quotes: [{ fee: { amount: REFUND_FEE_CAP + 1n, token: BASE } }],
});
check("T3 one raw unit over the cap is refused", capOver.code === 2 && capOver.counts.publish === 0 && capOver.counts.feeBuilds === 0 && has(capOver.lines, "quote is over the refund fee cap"));
const infoT3 = await plan();
const voteOver = await run({
  argv: sendArgv(infoT3),
  quotes: [{ fee: { amount: 1000n, token: BASE } }],
  voteFees: [{ fee: { amount: REFUND_FEE_CAP + 1n, token: BASE } }],
});
check("T3 vote-time cap is inside publishBuilder", voteOver.code === 3 && voteOver.counts.feeBuilds === 0 && voteOver.counts.publish === 1 && has(voteOver.lines, "REFUND_HOLD: publish error FeeOverCap") && existsSync(join(voteOver.dir, "STOP")) && existsSync(join(voteOver.dir, "refund", "intent.json")) && voteOver.client.lastFeeCall?.votesIsArray === true && voteOver.client.lastFeeCall?.blocksIsArray === true && typeof voteOver.client.lastFeeCall?.options?.generateFeeBlock === "function" && Array.isArray(voteOver.client.lastFeeCall?.options?.quotes));
const builtBad = await run({ argv: sendArgv(infoT3), feeOverride: 1n });
check("T3 built fee block must match the vote", builtBad.code === 3 && builtBad.counts.feeBuilds === 1 && builtBad.counts.publish === 1 && has(builtBad.lines, "REFUND_HOLD: publish error FeeBuilt") && existsSync(join(builtBad.dir, "STOP")) && existsSync(join(builtBad.dir, "refund", "intent.json")));
const foreign = await run({
  argv: sendArgv(infoT3),
  quotes: defaultQuotes(),
  voteFees: [{ fee: { amount: 1n, token: "keeta_notkta" } }],
});
check("T3 a non-KTA vote fee is refused", foreign.code === 3 && foreign.counts.feeBuilds === 0 && foreign.counts.publish === 1 && has(foreign.lines, "REFUND_HOLD: publish error FeeForeign") && existsSync(join(foreign.dir, "STOP")) && existsSync(join(foreign.dir, "refund", "intent.json")));

const dry = await run({ argv: [] });
check("T4 dry run does not publish", dry.code === 0 && dry.counts.publish === 0 && dry.counts.send === 0 && dry.counts.recover === 0);
check("T4 dry run leaves no stop or intent", !existsSync(join(dry.dir, "STOP")) && !existsSync(join(dry.dir, "refund", "intent.json")));
check("T4 books stay byte identical", readFileSync(dry.booksPath).equals(dry.booksAtStart));
check("T4 dry run marker", has(dry.lines, "REFUND_DRY_RUN_OK") && !has(dry.lines, "REFUND_DRY_RUN_OK (no quote)"));

{
  const info = await plan();
  const withIntent = await run({ argv: ["--no-quote"] });
  writeFileSync(join(withIntent.dir, "refund", "intent.json"), `${JSON.stringify({ block: "H", total: "1.000000000000000000" })}\n`);
  const againIntent = await withIntent.again([]);
  check("T5 intent refuses before a quote", againIntent.code === 2 && withIntent.counts.quotes === 0 && has(againIntent.lines, "prior refund intent"));
  const withDone = await run({ argv: ["--no-quote"] });
  writeFileSync(join(withDone.dir, "refund", "done.json"), `${JSON.stringify({ block: "H", total: "1.000000000000000000" })}\n`);
  const quotesBefore = withDone.counts.quotes;
  const againDone = await withDone.again([]);
  check("T5 done refuses before a quote", againDone.code === 2 && withDone.counts.quotes === quotesBefore && has(againDone.lines, "prior refund done"));
  const landed = await run({
    argv: sendArgv(info),
    onPublish: (_builder, _options, ctx) => {
      ctx.live.history = [staple(ctx.blockHash, FEE), ...oldHistory()];
      ctx.live.balance -= land(info).raw + FEE;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  check("T5 first send lands", landed.code === 0 && landed.counts.publish === 1 && has(landed.lines, "REFUND_SENT_OK"));
  const second = await landed.again(sendArgv(info));
  check("T5 second send does not publish again", second.code === 2 && landed.counts.publish === 1);
}

check("T6 active runner is refused", (await run({ argv: [], systemctl: () => "active" })).code === 2);
check("T6 activating runner is refused", (await run({ argv: [], systemctl: () => "activating" })).code === 2 && (await run({ argv: ["--no-quote"], systemctl: () => "activating" })).counts.quotes === 0);

for (const name of ["STOP", "HALT", "PAYHOLD", "FEEHOLD"]) {
  const held = await run({ argv: ["--no-quote"] });
  writeFileSync(join(held.dir, name), "held\n");
  const refused = await held.again(["--no-quote"]);
  check(`T7 ${name} is refused`, refused.code === 2 && has(refused.lines, `${name} is present`) && held.counts.quotes === 0);
}
{
  const held = await run({ argv: ["--no-quote"] });
  writeFileSync(join(held.dir, "payout-intent.json"), "{}\n");
  const refused = await held.again(["--no-quote"]);
  check("T7 payout-intent is refused", refused.code === 2 && has(refused.lines, "payout-intent.json is present"));
}

{
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  raw.operator = (-1n * RAW).toString();
  const text = JSON.stringify(raw);
  const short = await run({ argv: [], booksText: text });
  const floor = BigInt(grab(await plan().then((info) => info.lines), "TOTAL ").replace(".", "")) + FEE + 2n * RAW;
  const have = accounted(booksFromJson(JSON.parse(text)));
  check("T8 setup is below the floor and still booked", have < floor && have === short.live.balance);
  check("T8 a short balance is refused", short.code === 2 && short.counts.publish === 0 && has(short.lines, "balance is short of the refund"));
}

check("T9 balance one raw above is refused", (await run({ argv: ["--no-quote"], balance: accounted(booksFromJson(JSON.parse(readFileSync(FIXTURE, "utf8")))) + 1n })).code === 2);
{
  const above = await run({ argv: ["--no-quote"], balance: accounted(booksFromJson(JSON.parse(readFileSync(FIXTURE, "utf8")))) + 1n });
  const below = await run({ argv: ["--no-quote"], balance: accounted(booksFromJson(JSON.parse(readFileSync(FIXTURE, "utf8")))) - 1n });
  check("T9 both directions name the difference", above.code === 2 && below.code === 2 && has(above.lines, "difference 1.") && has(below.lines, "difference -1.") && has(above.lines, "Do not edit books. Unbooked deposits need a reviewed booking step first."));
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  raw.pendingDrops = ["1"];
  const drops = await run({ argv: ["--no-quote"], booksText: JSON.stringify(raw) });
  check("T9 pending drops are refused", drops.code === 2 && has(drops.lines, "pending drops are not empty") && has(drops.lines, "Do not edit books. Unbooked deposits need a reviewed booking step first."));
}

{
  const info = await plan();
  const missingTotal = await run({ argv: ["--send", "--confirm-count", info.n, "--confirm-plan", info.plan] });
  const missingCount = await run({ argv: ["--send", "--confirm-total", info.total, "--confirm-plan", info.plan] });
  const missingPlan = await run({ argv: ["--send", "--confirm-total", info.total, "--confirm-count", info.n] });
  const wrongTotal = await run({ argv: sendArgv(info, { total: "16211.826599999999999995" }) });
  const wrongCount = await run({ argv: sendArgv(info, { n: "13" }) });
  const wrongPlan = await run({ argv: sendArgv(info, { plan: `${info.plan.slice(0, -1)}0` }) });
  for (const [name, result] of [["total flag", missingTotal], ["count flag", missingCount], ["plan flag", missingPlan], ["total", wrongTotal], ["count", wrongCount], ["plan", wrongPlan]]) {
    check(`T10 ${name} is refused`, result.code === 2 && result.counts.publish === 0 && result.counts.quotes === 0 && result.counts.builds === 0 && result.counts.init === 0 && result.counts.seed === 0 && has(result.lines, "REFUND_REFUSED:"));
  }
}

{
  const info = await plan();
  const rawTotal = BigInt(info.total.replace(".", ""));
  const landed = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.history = [staple(ctx.blockHash, FEE), ...oldHistory()];
      ctx.live.balance -= rawTotal + FEE;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  const afterBooks = booksFromJson(JSON.parse(readFileSync(landed.booksPath, "utf8")));
  check("T11 landed finishes", landed.code === 0 && has(landed.lines, "REFUND_SENT_OK") && has(landed.lines, "BOOKS_OK"));
  check("T11 receipt and done exist", existsSync(join(landed.dir, "refund", "done.json")) && readdirSync(join(landed.dir, "refund")).some((name) => name.startsWith("receipt-")));
  check("T11 books backup exists", readdirSync(landed.dir).some((name) => name.startsWith("books.json.pre-refund-")));
  const backupName = readdirSync(landed.dir).find((name) => name.startsWith("books.json.pre-refund-"));
  check("T11 books backup is mode 0600", (statSync(join(landed.dir, backupName)).mode & 0o777) === 0o600);
  check("T11 accounted matches the chain", accounted(afterBooks) === landed.live.balance);
  check("T11 refunded and excluded stake is gone", [...EXCLUDED, ...Object.keys(EXPECT)].every((key) => {
    const full = [...afterBooks.share.stake.keys()].find((item) => item.includes(key)) ?? [...EXCLUDED].find((item) => item.includes(key));
    const id = [...afterBooks.share.stake.keys(), ...EXCLUDED].find((item) => String(item).includes(key));
    return (afterBooks.share.stake.get(id) ?? 0n) === 0n && !afterBooks.share.lots.some((lot) => lot.from === id || lot.from.includes(key));
  }));
  const missed = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => ({ from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } }),
  });
  check("T11 not landed keeps the books", missed.code === 3 && has(missed.lines, "REFUND_NOT_LANDED:") && existsSync(join(missed.dir, "refund", "intent.json")) && readFileSync(missed.booksPath).equals(missed.booksAtStart));
  const boom = await run({
    argv: sendArgv(info),
    onPublish: () => {
      const err = new Error("nope");
      err.name = "PublishBoom";
      throw err;
    },
  });
  check("T11 a publish error holds", boom.code === 3 && boom.counts.recover === 0 && existsSync(join(boom.dir, "STOP")) && existsSync(join(boom.dir, "refund", "intent.json")) && has(boom.lines, "REFUND_HOLD: publish error PublishBoom"));
}

{
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  raw.stake["base:0xfeed"] = RAW.toString();
  const bad = await run({ argv: ["--no-quote"], booksText: JSON.stringify(raw) });
  check("T12 a base key with stake is refused", bad.code === 2 && has(bad.lines, "unpayable stake"));
  const decode = await run({
    argv: ["--no-quote"],
    accountFrom: (id) => {
      if (id.includes("aabd7qpx")) throw new Error("decode");
      return { publicKeyString: id };
    },
  });
  check("T12 an undecodable address is refused", decode.code === 2 && decode.counts.init === 0 && has(decode.lines, "address does not decode"));
}

{
  const pending = await run({ argv: ["--no-quote"], pending: { hash: hashOf("PEND") } });
  check("T13 a pending block is refused", pending.code === 2 && pending.counts.quotes === 0 && has(pending.lines, "a block is already pending"));
}

{
  const info = await plan();
  const rawTotal = BigInt(info.total.replace(".", ""));
  process.env.REFUND_ENV_CANARY = "ENV-CANARY-3K";
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  let leaked;
  try {
    const landed = await run({
      argv: sendArgv(info),
      trackReads: true,
      loadWallet: (dir) => {
        writeFileSync(join(dir, "seed.txt"), "SEED-CANARY-9P\n");
        const text = readFileSync(join(dir, "seed.txt"), "utf8");
        if (!text.includes("SEED-CANARY-9P")) throw new Error("missing seed canary");
        return { publicKeyString: INTAKE };
      },
      onPublish: (_b, _o, ctx) => {
        ctx.live.history = [staple(ctx.blockHash, FEE), ...oldHistory()];
        ctx.live.balance -= rawTotal + FEE;
        return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
      },
    });
    writeFileSync(join(landed.dir, "seed.txt"), "SEED-CANARY-9P\n");
    const dryAfter = await landed.again([]);
    const verified = await landed.again(["--verify"]);
    const blob = [landed.lines.join("\n"), dryAfter.lines.join("\n"), verified.lines.join("\n"), errors.join("\n")];
    const refundDir = join(landed.dir, "refund");
    for (const name of readdirSync(refundDir)) {
      const full = join(refundDir, name);
      blob.push(readFileSync(full, "utf8"));
      check(`T14 ${name} is mode 0600`, (statSync(full).mode & 0o777) === 0o600);
    }
    check("T14 refund dir is mode 0700", (statSync(refundDir).mode & 0o777) === 0o700);
    const text = blob.join("\n");
    leaked = text;
    check("T14 canaries stay out of output and refund files", !text.includes("SEED-CANARY-9P") && !text.includes("ENV-CANARY-3K") && !text.includes("BOOKS-CANARY-7Q"));
  } finally {
    console.error = originalError;
    delete process.env.REFUND_ENV_CANARY;
  }
  const wrong = await run({ argv: [], loadWallet: () => ({ publicKeyString: "keeta_not_the_intake" }) });
  check("T14 a key that is not the intake is refused", wrong.code === 2 && wrong.counts.publish === 0 && has(wrong.lines, "seed is not the intake wallet"));
  void leaked;
}

{
  let sdk = null;
  let sdkVersion = "";
  try {
    const loaded = await import("@keetanetwork/keetanet-client");
    sdk = loaded.default ?? loaded;
    sdkVersion = createRequire(import.meta.url)("@keetanetwork/keetanet-client/package.json").version;
  } catch { sdk = null; }
  if (!sdk) {
    console.log("T15 skipped: @keetanetwork/keetanet-client 0.18.7 could not be imported");
  } else {
    check("T15 sdk is 0.18.7", sdkVersion === "0.18.7");
    const Account = sdk.lib.Account;
    const Block = sdk.lib.Block;
    const base = Account.generateBaseAddresses(0x5382n).baseToken;
    const baseText = base.publicKeyString.toString();
    const info = await plan();
    const planned = parseRows(info.lines);
    async function seal(mutator) {
      const wallet = Account.fromSeed(Account.generateRandomSeed({ asString: true }), 0);
      const builder = new Block.Builder({
        version: 2,
        network: 0x5382n,
        previous: Block.getAccountOpeningHash(wallet),
        account: wallet,
        signer: wallet,
      });
      const ops = planned.map((row) => ({ key: row.key, amount: BigInt(row.raw) }));
      mutator(ops);
      for (const op of ops) {
        builder.addOperation({
          type: 0,
          to: Account.fromPublicKeyString(op.key),
          amount: op.amount,
          token: base,
          external: MEMO,
        });
      }
      return builder.seal();
    }
    const good = await seal(() => {});
    const accepted = await run({
      argv: [],
      base,
      baseText,
      computeBlocks: () => ({ blocks: [good] }),
    });
    check("T15 a real sealed batch is accepted", accepted.code === 0 && has(accepted.lines, "REFUND_DRY_RUN_OK"));
    const changed = await seal((ops) => { ops[0].amount += 1n; });
    const rejectedAmount = await run({ argv: [], base, baseText, computeBlocks: () => ({ blocks: [changed] }) });
    check("T15 a raw unit change is refused", rejectedAmount.code === 2 && has(rejectedAmount.lines, "batch shape is wrong"));
    const swapped = await seal((ops) => {
      const key = ops[0].key;
      ops[0].key = ops[1].key;
      ops[1].key = key;
    });
    const rejectedSwap = await run({ argv: [], base, baseText, computeBlocks: () => ({ blocks: [swapped] }) });
    check("T15 a swapped recipient is refused", rejectedSwap.code === 2 && has(rejectedSwap.lines, "batch shape is wrong"));
    const pending = await run({ argv: ["--no-quote"], pending: good });
    check("T15 a real pending block is refused", pending.code === 2 && has(pending.lines, "a block is already pending"));
    const recorded = await run({
      argv: sendArgv(info),
      base,
      baseText,
      computeBlocks: () => ({ blocks: [good] }),
      onPublish: () => ({ from: "direct", voteStaple: { blocks: [{ hash: good.hash }] } }),
    });
    const intent = JSON.parse(readFileSync(join(recorded.dir, "refund", "intent.json"), "utf8"));
    check("T15 intent stores BlockHash toString", intent.block === good.hash.toString());
    const payer = Account.fromSeed(Account.generateRandomSeed({ asString: true }), 0);
    const feeBuilder = new sdk.Client.Builder({ account: payer, signer: payer });
    const feeBlock = await feeBuilder.computeFeeBlock(
      { blocks: [good], votes: [{ fee: { amount: 1000n, token: base }, issuer: payer }] },
      {},
      { network: 0x5382n, getPrevious: async () => good.hash.toString() },
    );
    const feeSend = feeBlock.operations.find((op) => op.type === 0 && op.amount === 1000n);
    check("T15 a real fee block is sealed offline", Boolean(feeSend) && feeSend.token.comparePublicKey(base) === true);
    const through = await run({
      argv: sendArgv(info),
      base,
      baseText,
      computeBlocks: () => ({ blocks: [good] }),
      computeFeeBlock: async (staple) => feeBuilder.computeFeeBlock(
        {
          votes: (staple.votes ?? []).map((vote) => ({ ...vote, issuer: vote.issuer ?? payer })),
          blocks: staple.blocks?.length ? staple.blocks : [good],
        },
        {},
        { network: 0x5382n, getPrevious: async () => good.hash.toString() },
      ),
      onPublish: () => ({ from: "direct", voteStaple: { blocks: [{ hash: good.hash }] } }),
    });
    check("T15 publishBuilder runs the real fee block", through.counts.feeBuilds === 1 && through.counts.publish === 1 && !has(through.lines, "publish error") && !has(through.lines, "built fee block does not match"));
  }
}

{
  async function memo(external, argv) {
    return run({
      argv,
      history: [staple("MEMOHASH", 1n, external), ...oldHistory()],
    });
  }
  const info = await plan();
  for (const argv of [[], ["--no-quote"], sendArgv(info)]) {
    const asText = await memo(MEMO, argv);
    const asBytes = await memo(Buffer.from(MEMO), argv);
    check(`T16 memo string refuses ${argv.join(" ") || "dry-run"}`, asText.code === 2 && asText.counts.quotes === 0 && asText.counts.publish === 0 && has(asText.lines, "MEMOHASH"));
    check(`T16 memo bytes refuses ${argv.join(" ") || "dry-run"}`, asBytes.code === 2 && asBytes.counts.quotes === 0 && asBytes.counts.publish === 0 && has(asBytes.lines, "MEMOHASH"));
  }
  let page = 0;
  const capped = await run({
    argv: [],
    getHistory: async () => {
      page += 1;
      return Array.from({ length: 100 }, (_, index) => ({
        voteStaple: {
          timestamp: () => new Date("2026-10-20T00:00:00.000Z"),
          blocksHash: { toString: () => `P${page}-${index}` },
          blocks: [],
        },
      }));
    },
  });
  check("T16 the page cap refuses", capped.code === 2 && page === 300 && capped.counts.quotes === 0 && has(capped.lines, "history page cap hit before cutoff"));
  const thrown = await run({ argv: [], getHistory: async () => { throw new Error("down"); } });
  check("T16 a history error refuses", thrown.code === 2 && has(thrown.lines, "history read failed"));
  let later = 0;
  const partial = await run({
    argv: ["--no-quote"],
    getHistory: async () => {
      later += 1;
      if (later > 1) throw new Error("later");
      return Array.from({ length: 100 }, (_, index) => ({
        voteStaple: {
          timestamp: () => new Date("2026-10-20T00:00:00.000Z"),
          blocksHash: { toString: () => `L${index}` },
          blocks: [],
        },
      }));
    },
  });
  check("T16 an error on a later page refuses", partial.code === 2 && later === 2 && has(partial.lines, "history read failed"));
  const viaHistory = await run({
    argv: ["--no-quote"],
    useHistory: true,
    history: [staple("HISTHASH", 1n), ...oldHistory()],
  });
  check("T16 history() fallback sees the memo", viaHistory.code === 2 && has(viaHistory.lines, "HISTHASH"));
}

{
  const info = await plan();
  const rawTotal = BigInt(info.total.replace(".", ""));
  const missingHash = await run({
    argv: sendArgv(info),
    onPublish: () => ({ from: "direct", voteStaple: { blocks: [{ hash: hashOf("OTHER") }] } }),
  });
  check("T17 a staple without the hash holds", missingHash.code === 3 && has(missingHash.lines, "REFUND_HOLD: published staple does not contain the block") && readFileSync(missingHash.booksPath).equals(missingHash.booksAtStart));
  const balanceOnly = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.balance -= rawTotal;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  check("T17 a matching balance without the hash does not land", balanceOnly.code === 3 && !has(balanceOnly.lines, "REFUND_SENT_OK") && !has(balanceOnly.lines, "BOOKS_OK") && readFileSync(balanceOnly.booksPath).equals(balanceOnly.booksAtStart));
  const deposit = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.history = [staple(ctx.blockHash, FEE), ...oldHistory()];
      ctx.live.balance = ctx.live.balance - rawTotal - FEE + 1n;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  check("T17 a deposit after publish holds", deposit.code === 3 && has(deposit.lines, "REFUND_HOLD:") && !has(deposit.lines, "REFUND_NOT_LANDED:") && readFileSync(deposit.booksPath).equals(deposit.booksAtStart));
  const drifted = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.balance += 1n;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  check("T17 a balance change without the hash holds", drifted.code === 3 && has(drifted.lines, "REFUND_HOLD:") && !has(drifted.lines, "REFUND_NOT_LANDED:"));
  const pending = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.pending = { hash: hashOf("STILL") };
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  check("T17 a missing hash with a pending block is pending", pending.code === 3 && has(pending.lines, "REFUND_PENDING:") && has(pending.lines, "hash found no"));
  const fatFee = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.history = [staple(ctx.blockHash, REFUND_FEE_CAP + 1n), ...oldHistory()];
      ctx.live.balance -= rawTotal + REFUND_FEE_CAP + 1n;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  check("T17 a fee over the cap holds", fatFee.code === 3 && has(fatFee.lines, "REFUND_HOLD:") && !has(fatFee.lines, "BOOKS_OK"));
  const otherFee = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.history = [staple(ctx.blockHash, 1n), ...oldHistory()];
      ctx.live.balance -= rawTotal + 1n;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  check("T17 a fee that differs from the vote holds", otherFee.code === 3 && has(otherFee.lines, "REFUND_HOLD:") && readFileSync(otherFee.booksPath).equals(otherFee.booksAtStart));
}

{
  const info = await plan();
  const rawTotal = BigInt(info.total.replace(".", ""));
  const landed = await run({
    argv: sendArgv(info),
    trackReads: true,
    onPublish: (_b, _o, ctx) => {
      ctx.live.history = [staple(ctx.blockHash, FEE), ...oldHistory()];
      ctx.live.balance -= rawTotal + FEE;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  const backup = readdirSync(landed.dir).find((name) => name.startsWith("books.json.pre-refund-"));
  rmSync(join(landed.dir, "refund", "done.json"));
  removeReceipts(landed.dir);
  copyFileSync(join(landed.dir, backup), landed.booksPath);
  const seeds = landed.counts.seed;
  const quotes = landed.counts.quotes;
  const inits = landed.counts.init;
  const publishes = landed.counts.publish;
  const first = await landed.again(["--verify"]);
  check("T18 verify finishes a landed refund once", first.code === 0 && has(first.lines, "REFUND_VERIFY: LANDED (finished now)") && has(first.lines, "BOOKS_OK"));
  const shot = snapshot(landed.dir);
  const second = await landed.again(["--verify"]);
  check("T18 a second verify is a no-op", second.code === 0 && has(second.lines, "REFUND_VERIFY: LANDED (already finished)") && snapshot(landed.dir) === shot);
  check("T18 verify does not build quote or publish", landed.counts.seed === seeds && landed.counts.quotes === quotes && landed.counts.init === inits && landed.counts.publish === publishes && !landed.opened.some((path) => path.endsWith("seed.txt")));

  const missed = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => ({ from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } }),
  });
  const beforeMiss = snapshot(missed.dir);
  const verifyMiss = await missed.again(["--verify"]);
  check("T18 verify of not landed writes nothing", verifyMiss.code === 3 && has(verifyMiss.lines, "REFUND_VERIFY: NOT_LANDED") && snapshot(missed.dir) === beforeMiss);

  const still = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.pending = { hash: hashOf("STILL") };
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  const beforeStill = snapshot(still.dir);
  const verifyStill = await still.again(["--verify"]);
  check("T18 verify of pending writes nothing", verifyStill.code === 3 && has(verifyStill.lines, "REFUND_VERIFY: PENDING") && snapshot(still.dir) === beforeStill);
}

{
  const info = await plan();
  const stopped = await run({
    argv: sendArgv(info),
    onQuote: (dir) => plantStop(dir, "already\n"),
  });
  check("T19 an exclusive STOP failure publishes nothing", stopped.code === 2 && stopped.counts.publish === 0 && has(stopped.lines, "STOP already exists"));
  let sys = 0;
  const active = await run({
    argv: sendArgv(info),
    systemctl: () => {
      sys += 1;
      return sys === 1 ? "inactive" : "active";
    },
  });
  check("T19 a runner that starts after the first check is refused", active.code === 2 && active.counts.publish === 0 && existsSync(join(active.dir, "STOP")) && !existsSync(join(active.dir, "refund", "intent.json")));
  let procs = 0;
  const running = await run({
    argv: sendArgv(info),
    processes: () => {
      procs += 1;
      return procs === 1 ? [] : [{ argv: ["node", "run.mjs"], cwd: "/opt/koreminer" }];
    },
  });
  check("T19 a runner process that appears is refused", running.code === 2 && running.counts.publish === 0 && existsSync(join(running.dir, "STOP")) && !existsSync(join(running.dir, "refund", "intent.json")));
  const pend = await run({
    argv: sendArgv(info),
    onPending: (n, live) => (n === 1 ? null : { hash: hashOf("LATE") }),
  });
  check("T19 a pending block on the recheck is refused", pend.code === 2 && pend.counts.publish === 0 && !existsSync(join(pend.dir, "refund", "intent.json")) && existsSync(join(pend.dir, "STOP")));
  const moved = await run({
    argv: sendArgv(info),
    onBalance: (n, live) => (n === 1 ? live.balance : live.balance + 1n),
  });
  check("T19 a balance move on the recheck is refused", moved.code === 2 && moved.counts.publish === 0 && !existsSync(join(moved.dir, "refund", "intent.json")));
  let seen = false;
  const ordered = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      const body = JSON.parse(readFileSync(join(ctx.dir, "refund", "intent.json"), "utf8"));
      seen = body.block === ctx.blockHash;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  check("T19 the intent is sealed before publish", seen && ordered.counts.publish === 1);
}

{
  const info = await plan();
  const rawTotal = BigInt(info.total.replace(".", ""));
  const landed = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.history = [staple(ctx.blockHash, FEE), ...oldHistory()];
      ctx.live.balance -= rawTotal + FEE;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  const backup = readdirSync(landed.dir).find((name) => name.startsWith("books.json.pre-refund-"));
  const original = JSON.parse(readFileSync(join(landed.dir, backup), "utf8"));
  original.operator = (BigInt(original.operator) + 1n).toString();
  rmSync(join(landed.dir, "refund", "done.json"));
  removeReceipts(landed.dir);
  rmSync(join(landed.dir, backup));
  const tampered = `${JSON.stringify(original)}\n`;
  writeFileSync(landed.booksPath, tampered);
  const verified = await landed.again(["--verify"]);
  check("T20 a books mismatch is not written", verified.code === 3 && has(verified.lines, "BOOKS_MISMATCH") && readFileSync(landed.booksPath, "utf8") === tampered);
  check("T20 no pre-refund backup is written", !readdirSync(landed.dir).some((name) => name.startsWith("books.json.pre-refund-")));
  const fresh = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.history = [staple(ctx.blockHash, FEE), ...oldHistory()];
      ctx.live.balance -= rawTotal + FEE;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  const adjusted = booksFromJson(JSON.parse(readFileSync(fresh.booksPath, "utf8")));
  const lots = new Map();
  for (const lot of adjusted.share.lots) lots.set(lot.from, (lots.get(lot.from) ?? 0n) + BigInt(lot.remaining));
  let lotsOk = true;
  for (const [key, amount] of adjusted.share.stake) if (amount !== (lots.get(key) ?? 0n)) lotsOk = false;
  for (const key of lots.keys()) if ((adjusted.share.stake.get(key) ?? 0n) !== lots.get(key)) lotsOk = false;
  const kept = [...adjusted.share.stake.keys(), ...adjusted.share.lots.map((lot) => lot.from)];
  check("T20 remaining lots match stake and refunded keys are gone", lotsOk && accounted(adjusted) === fresh.live.balance && kept.every((key) => !EXCLUDED.has(key) && !Object.keys(EXPECT).some((prefix) => key.includes(prefix))));
}

function writeDrain(mutator) {
  const body = JSON.parse(readFileSync(DRAIN, "utf8"));
  mutator(body);
  const path = join(mkdtempSync(join(SUITE, "kore-drain-")), "refund-drain.json");
  writeFileSync(path, JSON.stringify(body));
  return { path, sha: createHash("sha256").update(readFileSync(path)).digest("hex") };
}
{
  const spaced = readFileSync(DRAIN, "utf8") + " ";
  const shaPath = join(mkdtempSync(join(SUITE, "kore-drain-")), "refund-drain.json");
  writeFileSync(shaPath, spaced);
  const shaBad = await run({ argv: ["--no-quote"], drainPath: shaPath });
  check("T21 a changed sha is refused", shaBad.code === 2 && has(shaBad.lines, "drain file hash does not match"));
  const cases = [
    ["extra key", (body) => body.weights.push({ key: "keeta_aab6z3pj5ywg75f725a3kdyiawwvsupsgcjzukjmjy2ybpqriqdt4a5sks4ocuq", weight: "1" }), "drain weights are not the pinned set"],
    ["missing key", (body) => body.weights.pop(), "drain weights are not the pinned set"],
    ["duplicate key", (body) => { body.weights[1].key = body.weights[0].key; }, "drain weights are not the pinned set"],
    ["zero weight", (body) => { body.weights[9].weight = "0"; }, "drain weight is invalid"],
    ["negative weight", (body) => { body.weights[9].weight = "-1"; }, "drain weight is invalid"],
    ["19 dp", (body) => { body.weights[9].weight = "1.0000000000000000001"; }, "drain weight is invalid"],
    ["sum differs", (body) => { body.weights[9].weight = "2"; }, "drain total does not match"],
    ["total differs", (body) => { body.total = "4716"; }, "drain total does not match"],
    ["excluded key", (body) => { body.weights[9].key = TREY_A; }, "drain key is excluded"],
  ];
  for (const [name, mutator, message] of cases) {
    const file = writeDrain(mutator);
    const result = await run({ argv: ["--no-quote"], drainPath: file.path, drainSha: file.sha });
    check(`T21 ${name} is refused`, result.code === 2 && has(result.lines, message));
  }
}

for (const fault of ["excluded", "zero", "total"]) {
  const result = await run({ argv: ["--no-quote"], plannerFault: fault });
  check(`T22 ${fault} is refused before building`, result.code === 2 && result.counts.init === 0 && has(result.lines, "plan assertion failed"));
}

{
  const quiet = await run({ argv: ["--no-quote"], trackReads: true });
  check("T23 no-quote does not build sign or quote", quiet.code === 0 && quiet.counts.init === 0 && quiet.counts.builds === 0 && quiet.counts.quotes === 0 && quiet.counts.seed === 0);
  check("T23 no-quote never opens the seed", !quiet.opened.some((path) => path.endsWith("seed.txt")));
  check("T23 no-quote prints the plan", has(quiet.lines, "PLAN ") && has(quiet.lines, "REFUND_DRY_RUN_OK (no quote)") && rowsOf(quiet));
}

function rowsOf(result) {
  return parseRows(result.lines).length === 14;
}

{
  const none = await run({ argv: [] });
  check("T24 pending after quote is none", none.code === 0 && has(none.lines, "Pending block after quote: none"));
  const late = await run({
    argv: [],
    onPending: (n) => (n === 1 ? null : { hash: hashOf("AFTER") }),
  });
  check("T24 a pending block after the quote is reported", late.code === 0 && has(late.lines, "Pending block after quote: AFTER") && has(late.lines, "REFUND_CHECK: pending block after quote"));
}

{
  const first = await run({ argv: ["--no-quote"] });
  const second = await run({ argv: ["--no-quote"] });
  const digest = grab(first.lines, "PLAN ");
  check("T25 the plan digest is stable", digest === grab(second.lines, "PLAN ") && /^[0-9a-f]{64}$/.test(digest));
  const local = parseRows(first.lines).map((row) => `${row.key}:${row.raw}`).sort();
  const own = createHash("sha256").update(local.join("\n")).digest("hex");
  check("T25 the digest is the sorted raw lines", own === digest);
  local[0] = `${local[0].slice(0, local[0].lastIndexOf(":") + 1)}${BigInt(local[0].split(":")[1]) + 1n}`;
  const changed = createHash("sha256").update(local.sort().join("\n")).digest("hex");
  check("T25 one raw unit changes the digest", changed !== digest);
  const info = await plan();
  const refused = await run({ argv: sendArgv(info, { plan: changed }) });
  check("T25 an old digest is refused", refused.code === 2 && refused.counts.publish === 0 && has(refused.lines, "confirm plan does not match"));
}

{
  const cases = [
    [["node", "run.mjs"], "/opt/koreminer", true],
    [["/usr/bin/node", "/opt/koreminer/run.mjs"], "/", true],
    [["node", "./run.mjs"], "/opt/koreminer", true],
    [["node", "refund.mjs"], "/opt/koreminer", false],
  ];
  const outsideRoot = mkdtempSync(join(SUITE, "kore-outside-"));
  mkdirSync(outsideRoot, { recursive: true });
  writeFileSync(join(outsideRoot, "run.mjs"), "// outside\n");
  const realRoot = mkdtempSync(join(SUITE, "kore-real-root-"));
  writeFileSync(join(realRoot, "run.mjs"), "// root\n");
  for (const [argv, cwd, refuse] of cases) {
    const result = await run({ argv: ["--no-quote"], processes: () => [{ argv, cwd }] });
    check(`T26 ${argv.join(" ")} cwd ${cwd}`, refuse ? result.code === 2 && has(result.lines, "run.mjs is running") : result.code === 0);
  }
  const outside = await run({
    argv: ["--no-quote"],
    procRootDir: realRoot,
    processes: () => [{ argv: ["node", join(outsideRoot, "run.mjs")], cwd: outsideRoot }],
  });
  check("T26 a run.mjs outside the root is not the runner", outside.code === 0 && !has(outside.lines, "run.mjs is running"));
}

const none = await run({ argv: ["--verify"] });
check("verify with no intent exits quietly", none.code === 0 && has(none.lines, "REFUND_VERIFY: no intent") && none.counts.seed === 0);

{
  const unknownMemo = await run({
    argv: ["--no-quote"],
    history: [{
      voteStaple: {
        timestamp: () => new Date("2026-10-20T12:00:00.000Z"),
        blocksHash: { toString: () => "STAPLE" },
        blocks: [{
          account: INTAKE,
          hash: {},
          operations: [{ type: 0, external: MEMO, amount: 1n, token: BASE, to: "x" }],
        }],
      },
    }, ...oldHistory()],
  });
  check("S2 an unreadable memo hash refuses", unknownMemo.code === 2 && has(unknownMemo.lines, "refund memo already on chain in block unknown"));
}

{
  const early = await run({
    argv: ["--no-quote"],
    processes: () => {
      const err = new Error("SECRET-BEFORE");
      err.name = "BoomBefore";
      throw err;
    },
  });
  check("S3 an unexpected error before STOP is refused", early.code === 2 && has(early.lines, "REFUND_REFUSED: unexpected BoomBefore") && !has(early.lines, "SECRET-BEFORE") && !existsSync(join(early.dir, "STOP")));
  let seen = 0;
  const info = await plan();
  const late = await run({
    argv: sendArgv(info),
    processes: () => {
      seen += 1;
      if (seen === 1) return [];
      const err = new Error("SECRET-AFTER");
      err.name = "BoomAfter";
      throw err;
    },
  });
  check("S3 an unexpected error after STOP holds", late.code === 3 && has(late.lines, "REFUND_HOLD: unexpected BoomAfter") && !has(late.lines, "SECRET-AFTER") && existsSync(join(late.dir, "STOP")) && !existsSync(join(late.dir, "refund", "intent.json")));
}

{
  const unknownPending = await run({
    argv: [],
    onPending: (n) => {
      if (n === 1) return null;
      throw new Error("late pending");
    },
  });
  check("S5 a pending read that throws is unknown", unknownPending.code === 0 && has(unknownPending.lines, "Pending block after quote: unknown") && has(unknownPending.lines, "REFUND_CHECK: pending block after quote") && !has(unknownPending.lines, "Pending block after quote: none"));
}

{
  const emptyHash = await run({
    argv: [],
    computeBlocks: (sends) => ({
      blocks: [{
        hash: "",
        account: INTAKE,
        operations: sends.map((row) => ({
          type: 0,
          to: row.to,
          token: row.token,
          amount: row.amount,
          external: row.external,
        })),
      }],
    }),
  });
  check("S6 an empty block hash is refused", emptyHash.code === 2 && emptyHash.counts.quotes === 0 && emptyHash.counts.builds === 1 && emptyHash.counts.publish === 0 && !existsSync(join(emptyHash.dir, "STOP")) && !existsSync(join(emptyHash.dir, "refund", "intent.json")) && has(emptyHash.lines, "batch shape is wrong"));
}

{
  const missingRoot = join(SUITE, "proc-missing");
  const missing = await run({ argv: ["--no-quote"], useProc: true, procRoot: missingRoot });
  check("N3 an unreadable process list is refused", missing.code === 2 && missing.counts.quotes === 0 && has(missing.lines, "REFUND_REFUSED: process list unreadable"));
  const zombieRoot = mkdtempSync(join(SUITE, "kore-proc-"));
  mkdirSync(join(zombieRoot, "3"));
  writeFileSync(join(zombieRoot, "3", "cmdline"), "");
  writeFileSync(join(zombieRoot, "3", "cwd"), "not-a-link");
  const zombie = await run({ argv: ["--no-quote"], useProc: true, procRoot: zombieRoot });
  check("F1 a zombie with an empty cmdline is skipped", zombie.code === 0 && !has(zombie.lines, "process list unreadable"));
  const goneRoot = mkdtempSync(join(SUITE, "kore-proc-"));
  mkdirSync(join(goneRoot, "4"));
  const gone = await run({ argv: ["--no-quote"], useProc: true, procRoot: goneRoot });
  check("F1 a pid that vanishes is skipped", gone.code === 0 && !has(gone.lines, "process list unreadable"));
  const quietRoot = mkdtempSync(join(SUITE, "kore-proc-"));
  mkdirSync(join(quietRoot, "8"));
  writeFileSync(join(quietRoot, "8", "cmdline"), "bash\0");
  writeFileSync(join(quietRoot, "8", "cwd"), "not-a-link");
  const quiet = await run({ argv: ["--no-quote"], useProc: true, procRoot: quietRoot });
  check("F1 a non-node process with an unreadable cwd is not refused", quiet.code === 0 && !has(quiet.lines, "process list unreadable"));
  const nodeRoot = mkdtempSync(join(SUITE, "kore-proc-"));
  mkdirSync(join(nodeRoot, "7"));
  writeFileSync(join(nodeRoot, "7", "cmdline"), "node\0run.mjs\0");
  writeFileSync(join(nodeRoot, "7", "cwd"), "not-a-link");
  const nodeProc = await run({ argv: ["--no-quote"], useProc: true, procRoot: nodeRoot });
  check("F1 a run.mjs process with an unreadable cwd is refused", nodeProc.code === 2 && has(nodeProc.lines, "process list unreadable"));
  const denyRoot = mkdtempSync(join(SUITE, "kore-proc-"));
  mkdirSync(join(denyRoot, "9"));
  symlinkSync("/proc/1/mem", join(denyRoot, "9", "cmdline"));
  const denied = await run({ argv: ["--no-quote"], useProc: true, procRoot: denyRoot });
  check("F1 an EACCES cmdline is refused", denied.code === 2 && has(denied.lines, "REFUND_REFUSED: process list unreadable") && !denied.lines.some((line) => line.includes("permission") || line.includes("/proc/1")));
  const otherRoot = mkdtempSync(join(SUITE, "kore-proc-"));
  mkdirSync(join(otherRoot, "8"));
  writeFileSync(join(otherRoot, "8", "cmdline"), "bash\0");
  symlinkSync("/tmp", join(otherRoot, "8", "cwd"));
  const other = await run({ argv: ["--no-quote"], useProc: true, procRoot: otherRoot });
  check("N3 a readable other process is not the runner", other.code === 0 && !has(other.lines, "process list unreadable"));
  const secret = await run({
    argv: ["--no-quote"],
    processes: () => {
      const err = new Error("SECRET-PROC");
      err.name = "ProcessListUnreadable";
      throw err;
    },
  });
  check("N3 the refusal does not print the error text", secret.code === 2 && has(secret.lines, "REFUND_REFUSED: process list unreadable") && !has(secret.lines, "SECRET-PROC"));
}

{
  const info = await plan();
  let seen = 0;
  const late = await run({
    argv: sendArgv(info),
    processes: () => {
      seen += 1;
      if (seen === 1) return [];
      const err = new Error("SECRET-RECHECK");
      err.name = "ProcessListUnreadable";
      throw err;
    },
  });
  check("F2 an unreadable process list on the recheck is refused", late.code === 2 && has(late.lines, "REFUND_REFUSED: process list unreadable") && !has(late.lines, "SECRET-RECHECK") && !has(late.lines, "REFUND_HOLD:") && existsSync(join(late.dir, "STOP")) && !existsSync(join(late.dir, "refund", "intent.json")));
}

{
  const info = await plan();
  const rawTotal = BigInt(info.total.replace(".", ""));
  const landed = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.history = [staple(ctx.blockHash, FEE), ...oldHistory()];
      ctx.live.balance -= rawTotal + FEE;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  const backup = readdirSync(landed.dir).find((name) => name.startsWith("books.json.pre-refund-"));
  rmSync(join(landed.dir, "refund", "done.json"));
  for (const name of readdirSync(join(landed.dir, "refund"))) {
    if (name.startsWith("receipt-")) rmSync(join(landed.dir, "refund", name));
  }
  copyFileSync(join(landed.dir, backup), landed.booksPath);
  const mid = await landed.again(["--verify"], {
    fs: {
      copyFileSync() {
        const err = new Error("SECRET-VERIFY");
        err.name = "BoomVerify";
        throw err;
      },
    },
  });
  const started = readdirSync(join(landed.dir, "refund")).some((name) => name.startsWith("receipt-") || name === "done.json");
  const doneBody = JSON.parse(readFileSync(join(landed.dir, "refund", "done.json"), "utf8"));
  check("F3 a backup failure during verify seals a mismatch", mid.code === 3 && has(mid.lines, "BOOKS_MISMATCH") && doneBody.books === "mismatch" && !has(mid.lines, "SECRET-VERIFY") && !has(mid.lines, "BoomVerify") && !has(mid.lines, "REFUND_REFUSED:") && !has(mid.lines, "unexpected") && started);
}

{
  const objectBalance = await run({ argv: ["--no-quote"], onBalance: () => ({ amount: 1n }) });
  check("N5 an object balance is refused", objectBalance.code === 2 && has(objectBalance.lines, "balance read failed"));
  const numberBalance = await run({ argv: ["--no-quote"], onBalance: () => 1 });
  check("N5 a number balance is refused", numberBalance.code === 2 && has(numberBalance.lines, "balance read failed"));
  const text = accounted(booksFromJson(JSON.parse(readFileSync(FIXTURE, "utf8")))).toString();
  const stringBalance = await run({ argv: ["--no-quote"], onBalance: () => text });
  check("N5 a base-10 integer string is accepted", stringBalance.code === 0 && has(stringBalance.lines, "REFUND_DRY_RUN_OK (no quote)"));
}

{
  const info = await plan();
  const missed = await run({
    argv: sendArgv(info),
    onPublish: () => ({ from: "direct", voteStaple: { blocks: [{ hash: hashOf("OTHER") }] } }),
  });
  missed.client.getHistory = async () => { throw new Error("SECRET-HIST"); };
  const hist = await missed.again(["--verify"]);
  check("H1 a history failure says hash found unknown", hist.code === 3 && has(hist.lines, "REFUND_VERIFY: UNKNOWN history read failed hash found unknown") && !has(hist.lines, "hash found no") && !has(hist.lines, "SECRET-HIST"));
  const missedBal = await run({
    argv: sendArgv(info),
    onPublish: () => ({ from: "direct", voteStaple: { blocks: [{ hash: hashOf("OTHER") }] } }),
  });
  missedBal.client.pendingBlock = async () => { throw new Error("SECRET-BAL"); };
  const bal = await missedBal.again(["--verify"]);
  check("H1 a balance failure says hash found unknown", bal.code === 3 && has(bal.lines, "REFUND_VERIFY: UNKNOWN history read failed hash found unknown") && !has(bal.lines, "hash found no") && !has(bal.lines, "SECRET-BAL"));
  const read = await run({
    argv: sendArgv(info),
    onPublish: () => ({ from: "direct", voteStaple: { blocks: [{ hash: hashOf("OTHER") }] } }),
  });
  const facts = await read.again(["--verify"]);
  check("H1 a successful read still says hash found no", facts.code === 3 && has(facts.lines, "hash found no") && !has(facts.lines, "hash found unknown"));
}

{
  const info = await plan();
  const rawTotal = BigInt(info.total.replace(".", ""));
  const land = (ctx) => {
    ctx.live.history = [staple(ctx.blockHash, FEE), ...oldHistory()];
    ctx.live.balance -= rawTotal + FEE;
    return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
  };
  const landed = await run({ argv: sendArgv(info), onPublish: (_b, _o, ctx) => land(ctx) });
  const done = JSON.parse(readFileSync(join(landed.dir, "refund", "done.json"), "utf8"));
  check("H2 a landed send prints REFUND_LANDED and marks the books adjusted", landed.code === 0 && has(landed.lines, "REFUND_LANDED REFUNDHASH") && done.books === "adjusted" && has(landed.lines, "BOOKS_OK") && has(landed.lines, "REFUND_SENT_OK"));
  done.books = "mismatch";
  writeFileSync(join(landed.dir, "refund", "done.json"), `${JSON.stringify(done, null, 2)}\n`);
  const shot = snapshot(landed.dir);
  const held = await landed.again(["--verify"]);
  check("H2 verify of a books mismatch makes no writes", held.code === 3 && has(held.lines, "REFUND_VERIFY: LANDED books not adjusted") && !has(held.lines, "BOOKS_OK") && !has(held.lines, "REFUND_LANDED") && snapshot(landed.dir) === shot);
  const resume = await run({ argv: sendArgv(info), onPublish: (_b, _o, ctx) => land(ctx) });
  const backup = readdirSync(resume.dir).find((name) => name.startsWith("books.json.pre-refund-"));
  rmSync(join(resume.dir, "refund", "done.json"));
  removeReceipts(resume.dir);
  copyFileSync(join(resume.dir, backup), resume.booksPath);
  const finished = await resume.again(["--verify"]);
  const finishedDone = JSON.parse(readFileSync(join(resume.dir, "refund", "done.json"), "utf8"));
  check("H2 verify finish prints REFUND_LANDED and marks the books adjusted", finished.code === 0 && has(finished.lines, "REFUND_LANDED REFUNDHASH") && has(finished.lines, "REFUND_VERIFY: LANDED (finished now)") && finishedDone.books === "adjusted");
  const again = await resume.again(["--verify"]);
  check("H2 verify of adjusted books is already finished", again.code === 0 && has(again.lines, "REFUND_VERIFY: LANDED (already finished)") && !has(again.lines, "books not adjusted"));
}

{
  const outsider = await run({ argv: ["--no-quote"], uid: 1 });
  check("H3 a non-root run is refused", outsider.code === 2 && has(outsider.lines, "REFUND_REFUSED: must run as root") && !existsSync(join(outsider.dir, "refund")));
  const verify = await run({ argv: ["--verify"], uid: 1 });
  check("H3 verify as non-root is refused", verify.code === 2 && has(verify.lines, "REFUND_REFUSED: must run as root") && !existsSync(join(verify.dir, "refund")) && verify.counts.seed === 0);
  const info = await plan();
  const send = await run({ argv: sendArgv(info), uid: 4 });
  check("H3 send as non-root is refused before any write", send.code === 2 && has(send.lines, "REFUND_REFUSED: must run as root") && !existsSync(join(send.dir, "refund")) && send.counts.publish === 0 && send.counts.seed === 0);
  const linkReal = mkdtempSync(join(SUITE, "kore-runner-real-"));
  writeFileSync(join(linkReal, "run.mjs"), "// runner\n");
  const linkDir = mkdtempSync(join(SUITE, "kore-runner-link-"));
  symlinkSync(join(linkReal, "run.mjs"), join(linkDir, "run.mjs"));
  const linked = await run({
    argv: ["--no-quote"],
    procRootDir: linkReal,
    processes: () => [{ argv: ["node", join(linkDir, "run.mjs")], cwd: "/" }],
  });
  check("H3 a symlink whose realpath is the runner is refused", linked.code === 2 && has(linked.lines, "run.mjs is running"));
  const presentRoot = mkdtempSync(join(SUITE, "kore-runner-present-"));
  writeFileSync(join(presentRoot, "run.mjs"), "// runner\n");
  const missing = await run({
    argv: ["--no-quote"],
    procRootDir: presentRoot,
    processes: () => [{ argv: ["node", "/no/such/run.mjs"], cwd: "/" }],
  });
  check("H3 an unresolvable run.mjs path is unreadable", missing.code === 2 && has(missing.lines, "REFUND_REFUSED: process list unreadable") && !has(missing.lines, "/no/such") && !has(missing.lines, "ENOENT") && !has(missing.lines, "unexpected"));
}

{
  const info = await plan();
  const rawTotal = BigInt(info.total.replace(".", ""));
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const shift = BigInt(raw.operator) + RAW;
  raw.operator = (-RAW).toString();
  raw.parked = (BigInt(raw.parked ?? "0") + shift).toString();
  const text = JSON.stringify(raw);
  const operator = await run({
    argv: sendArgv(info),
    booksText: text,
    onPublish: (_b, _o, ctx) => {
      ctx.live.history = [staple(ctx.blockHash, FEE), ...oldHistory()];
      ctx.live.balance -= rawTotal + FEE;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  const operatorDone = JSON.parse(readFileSync(join(operator.dir, "refund", "done.json"), "utf8"));
  const operatorReceipt = readdirSync(join(operator.dir, "refund")).some((name) => name.startsWith("receipt-"));
  check("H4 a negative operator is a books mismatch", operator.code === 3 && has(operator.lines, "BOOKS_MISMATCH") && has(operator.lines, "REFUND_LANDED REFUNDHASH") && !has(operator.lines, "BOOKS_OK") && operatorDone.books === "mismatch" && operatorReceipt && readFileSync(operator.booksPath, "utf8") === text && !readdirSync(operator.dir).some((name) => name.startsWith("books.json.pre-refund-")));
  let tampered = "";
  const reserve = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.history = [staple(ctx.blockHash, FEE), ...oldHistory()];
      ctx.live.balance -= rawTotal + FEE;
      const body = JSON.parse(readFileSync(join(ctx.dir, "books.json"), "utf8"));
      body.reserve = (BigInt(body.reserve) + 1n).toString();
      body.operator = (BigInt(body.operator) - 1n).toString();
      tampered = JSON.stringify(body);
      writeFileSync(join(ctx.dir, "books.json"), tampered);
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  const reserveDone = JSON.parse(readFileSync(join(reserve.dir, "refund", "done.json"), "utf8"));
  const reserveReceipt = readdirSync(join(reserve.dir, "refund")).some((name) => name.startsWith("receipt-"));
  check("H4 a changed reserve is a books mismatch", reserve.code === 3 && has(reserve.lines, "BOOKS_MISMATCH") && !has(reserve.lines, "BOOKS_OK") && reserveDone.books === "mismatch" && reserveReceipt && readFileSync(reserve.booksPath, "utf8") === tampered && !readdirSync(reserve.dir).some((name) => name.startsWith("books.json.pre-refund-")));
}

{
  const info = await plan();
  const wrong = await run({
    argv: sendArgv(info, { plan: "0".repeat(64) }),
    trackReads: true,
    loadWallet: (walletDir) => {
      readFileSync(join(walletDir, "seed.txt"), "utf8");
      return { publicKeyString: INTAKE };
    },
  });
  check("H5 a wrong confirm never opens the seed", wrong.code === 2 && wrong.counts.seed === 0 && wrong.counts.init === 0 && wrong.counts.quotes === 0 && wrong.counts.publish === 0 && !wrong.opened.some((path) => path.endsWith("seed.txt")) && has(wrong.lines, "confirm plan does not match"));
}

{
  const info = await plan();
  const total = BigInt(info.total.replace(".", ""));
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const have = accounted(booksFromJson(JSON.parse(readFileSync(FIXTURE, "utf8"))));
  const target = total + FEE + RESERVE;
  const capLine = total + REFUND_FEE_CAP + RESERVE;
  const drop = have - target;
  const op = BigInt(raw.operator);
  const park = BigInt(raw.parked ?? "0");
  const fromOp = op > drop ? drop : op;
  raw.operator = (op - fromOp).toString();
  raw.parked = (park - (drop - fromOp)).toString();
  const text = JSON.stringify(raw);
  const next = accounted(booksFromJson(JSON.parse(text)));
  const short = await run({ argv: [], booksText: text });
  check("H6 setup covers the quote but not the fee cap", next === target && next < capLine && short.live.balance === next);
  check("H6 the worst-case fee is refused", short.code === 2 && short.counts.publish === 0 && has(short.lines, "balance is short of the refund"));
}

function trackIo(order) {
  return {
    openSync(path, flags, mode) {
      const fd = openSync(path, flags, mode);
      order.push({ op: "open", path: String(path), fd, mode });
      return fd;
    },
    writeFileSync(target, body, ...rest) {
      order.push({
        op: "write",
        target: typeof target === "number" ? target : String(target),
        body: typeof body === "string" ? body : "",
      });
      return writeFileSync(target, body, ...rest);
    },
    fchownSync(fd, uid, gid) {
      order.push({ op: "fchown", fd, uid, gid });
      return fchownSync(fd, uid, gid);
    },
    fchmodSync(fd, mode) {
      order.push({ op: "fchmod", fd, mode });
      return fchmodSync(fd, mode);
    },
    fsyncSync(fd) {
      order.push({ op: "fsync", fd });
      return fsyncSync(fd);
    },
    closeSync(fd) {
      order.push({ op: "close", fd });
      return closeSync(fd);
    },
    renameSync(from, to) {
      order.push({ op: "rename", from: String(from), to: String(to) });
      return renameSync(from, to);
    },
    chmodSync(path, mode) {
      order.push({ op: "chmod", path: String(path), mode });
      return chmodSync(path, mode);
    },
  };
}

function eventsAfterOpen(order, index) {
  const fd = order[index].fd;
  const events = [];
  for (let i = index; i < order.length; i += 1) {
    const event = order[i];
    if (i !== index && event.op === "open" && event.fd === fd) break;
    if (event.fd === fd || (event.op === "write" && event.target === fd)) events.push(event);
    if (event.op === "close" && event.fd === fd) break;
  }
  return events;
}

{
  const info = await plan();
  const rawTotal = BigInt(info.total.replace(".", ""));
  const order = [];
  const landed = await run({
    argv: sendArgv(info),
    fs: trackIo(order),
    onPublish: (_b, _o, ctx) => {
      chmodSync(join(ctx.dir, "books.json"), 0o640);
      ctx.live.history = [staple(ctx.blockHash, FEE), ...oldHistory()];
      ctx.live.balance -= rawTotal + FEE;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  const tmpOpens = [];
  order.forEach((event, index) => {
    if (event.op === "open" && event.path.endsWith(".tmp")) tmpOpens.push(index);
  });
  let ownedBeforeSync = tmpOpens.length > 0;
  for (const index of tmpOpens) {
    const ops = eventsAfterOpen(order, index).map((event) => event.op);
    const syncAt = ops.indexOf("fsync");
    const chownAt = ops.indexOf("fchown");
    const chmodAt = ops.indexOf("fchmod");
    if (chownAt < 0 || chmodAt < 0 || syncAt < 0 || chownAt > syncAt || chmodAt > syncAt) ownedBeforeSync = false;
  }
  const booksIndex = order.findIndex((event) => event.op === "open" && event.path.endsWith("/books.json.tmp"));
  const booksEvents = booksIndex < 0 ? [] : eventsAfterOpen(order, booksIndex);
  const booksMode = booksEvents.find((event) => event.op === "fchmod");
  const doneIndex = order.findIndex((event) => event.op === "open" && event.path.endsWith("/done.json.tmp"));
  const doneEvents = doneIndex < 0 ? [] : eventsAfterOpen(order, doneIndex);
  const doneOpens = order.filter((event) => event.op === "open" && event.path.endsWith("/done.json.tmp"));
  const booksRename = order.findIndex((event) => event.op === "rename" && event.to.endsWith("/books.json"));
  const doneWrite = doneEvents.find((event) => event.op === "write");
  const finalMode = statSync(join(landed.dir, "books.json")).mode & 0o777;
  const chmodBooks = order.some((event) => event.op === "chmod" && event.path.endsWith("/books.json") && (event.mode & 0o777) === 0o600);
  check("H7i fd chown and chmod precede the tmp fsync", landed.code === 0 && ownedBeforeSync);
  check("H7i books.json keeps mode 0640", booksMode?.mode === 0o640 && finalMode === 0o640 && !chmodBooks);
  check("H7ii done.json is written once with the final books value", doneOpens.length === 1 && doneIndex > booksRename && doneWrite?.body.includes('"books": "adjusted"'));

  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const shift = BigInt(raw.operator) + RAW;
  raw.operator = (-RAW).toString();
  raw.parked = (BigInt(raw.parked ?? "0") + shift).toString();
  const text = JSON.stringify(raw);
  const mismatchOrder = [];
  const mismatch = await run({
    argv: sendArgv(info),
    booksText: text,
    fs: trackIo(mismatchOrder),
    onPublish: (_b, _o, ctx) => {
      chmodSync(join(ctx.dir, "books.json"), 0o640);
      ctx.live.history = [staple(ctx.blockHash, FEE), ...oldHistory()];
      ctx.live.balance -= rawTotal + FEE;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  const mismatchIndexes = [];
  mismatchOrder.forEach((event, index) => {
    if (event.op === "open" && event.path.endsWith("/done.json.tmp")) mismatchIndexes.push(index);
  });
  const mismatchEvents = mismatchIndexes.length === 1 ? eventsAfterOpen(mismatchOrder, mismatchIndexes[0]) : [];
  const mismatchWrite = mismatchEvents.find((event) => event.op === "write");
  const mismatchBooks = mismatchOrder.some((event) => event.op === "open" && event.path.endsWith("/books.json.tmp"));
  check("H7ii a mismatch writes done.json once and does not rewrite books.json", mismatch.code === 3 && mismatchIndexes.length === 1 && mismatchWrite?.body.includes('"books": "mismatch"') && !mismatchBooks && (statSync(mismatch.booksPath).mode & 0o777) === 0o640 && readFileSync(mismatch.booksPath, "utf8") === text);
}

{
  const nodeModule = await import("node:module");
  if (typeof nodeModule.registerHooks !== "function") {
    console.log("skip T27 (registerHooks needs Node 22.15+)");
  } else {
  let sdkEntry = "";
  let sdkVersion = "";
  try {
    const req = createRequire(import.meta.url);
    sdkEntry = req.resolve("@keetanetwork/keetanet-client");
    sdkVersion = req("@keetanetwork/keetanet-client/package.json").version;
  } catch {
    console.log("T27 skipped: @keetanetwork/keetanet-client 0.18.7 could not be imported");
    sdkEntry = "";
  }
  if (sdkEntry) {
  const { registerHooks } = nodeModule;
  const { pathToFileURL } = await import("node:url");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@keetanetwork/keetanet-client") {
        return {
          url: pathToFileURL(sdkEntry).href,
          shortCircuit: true,
        };
      }
      return nextResolve(specifier, context);
    },
  });
  const loaded = await import("@keetanetwork/keetanet-client");
  const sdk = loaded.default ?? loaded;
  check("T27 sdk module is 0.18.7", sdkVersion === "0.18.7");
  const calls = [];
  const realFrom = sdk.UserClient.fromNetwork;
  sdk.UserClient.fromNetwork = function fromNetwork(network, signer, options) {
    calls.push({ network, readOnly: signer === null, hasKey: Boolean(signer?.hasPrivateKey) });
    return realFrom.call(this, network, signer, options);
  };
  const previousFetch = globalThis.fetch;
  let unstubbed = 0;
  const balanceText = accounted(booksFromJson(JSON.parse(readFileSync(FIXTURE, "utf8")))).toString();
  globalThis.fetch = async (url) => {
    const text = String(url);
    const body = (() => {
      if (text.includes("/representatives")) return { representatives: [] };
      if (text.includes("/history")) return { history: [], nextKey: null };
      if (text.includes("/balance/")) return { balance: balanceText };
      if (text.includes("/pending")) return { account: INTAKE, block: null };
      unstubbed += 1;
      throw new Error(`unstubbed ${text}`);
    })();
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  async function production(argv, extra = {}) {
    const dir = mkdtempSync(join(SUITE, "kore-live-"));
    writeFileSync(join(dir, "books.json"), readFileSync(FIXTURE));
    const lines = [];
    const code = await main({
      argv,
      dir,
      now: NOW,
      uid: 0,
      output: (line) => lines.push(line),
      systemctl: () => "inactive",
      processes: () => [],
      ...extra,
    });
    return { code, lines, dir };
  }
  try {
    calls.length = 0;
    const noQuote = await production(["--no-quote"]);
    check("T27 no-quote uses one read-only client", noQuote.code === 0 && has(noQuote.lines, "REFUND_DRY_RUN_OK (no quote)") && has(noQuote.lines, "PLAN 578bd699c51acaa7c37699c7a8d679902dc41d52e8b85f875d8ef2a980ee6ea2") && calls.length === 1 && calls[0].readOnly === true && calls[0].hasKey === false && calls[0].network === "main");
    calls.length = 0;
    const verifyDir = mkdtempSync(join(SUITE, "kore-live-"));
    writeFileSync(join(verifyDir, "books.json"), readFileSync(FIXTURE));
    mkdirSync(join(verifyDir, "refund"), { mode: 0o700 });
    writeFileSync(join(verifyDir, "refund", "intent.json"), `${JSON.stringify({
      block: "NOTHERE",
      balanceBefore: balanceText,
      rawTotal: "1",
      total: "0.000000000000000001",
      plan: "0",
      published: "2026-10-20T12:00:00.000Z",
    })}\n`);
    const lines = [];
    const verifiedCode = await main({
      argv: ["--verify"],
      dir: verifyDir,
      now: NOW,
      uid: 0,
      output: (line) => lines.push(line),
      systemctl: () => "inactive",
      processes: () => [],
    });
    check("T27 verify reads through the read-only client", verifiedCode === 3 && lines.some((line) => line.startsWith("REFUND_VERIFY: NOT_LANDED")) && calls.length === 1 && calls[0].readOnly === true && calls[0].hasKey === false);
    calls.length = 0;
    const quoteDir = mkdtempSync(join(SUITE, "kore-live-"));
    writeFileSync(join(quoteDir, "books.json"), readFileSync(FIXTURE));
    writeFileSync(join(quoteDir, "seed.txt"), "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about\n");
    const quotedLines = [];
    const quotedCode = await main({
      argv: [],
      dir: quoteDir,
      now: NOW,
      uid: 0,
      output: (line) => quotedLines.push(line),
      systemctl: () => "inactive",
      processes: () => [],
    });
    check("T27 quoted dry run reads before any signing client", quotedCode === 2 && quotedLines.some((line) => line.startsWith("REFUND dry-run")) && !quotedLines.some((line) => line.includes("history read failed")) && !quotedLines.some((line) => line.includes("balance read failed")) && quotedLines.some((line) => line.includes("seed is not the intake wallet")) && calls.length === 1 && calls[0].readOnly === true && calls[0].hasKey === false);
    const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
    raw.stake["keeta_not_a_real_key"] = (10n ** 18n).toString();
    raw.operator = (BigInt(raw.operator) - 10n ** 18n).toString();
    const badDir = mkdtempSync(join(SUITE, "kore-live-"));
    writeFileSync(join(badDir, "books.json"), JSON.stringify(raw));
    calls.length = 0;
    const badLines = [];
    const badCode = await main({
      argv: ["--no-quote"],
      dir: badDir,
      now: NOW,
      uid: 0,
      output: (line) => badLines.push(line),
      systemctl: () => "inactive",
      processes: () => [],
    });
    check("T27 the real decoder refuses a bad address", badCode === 2 && badLines.some((line) => line.includes("address does not decode")) && calls.every((row) => row.readOnly === true && row.hasKey === false));
    check("T27 the network stub saw no unstubbed fetch", unstubbed === 0);
  } finally {
    sdk.UserClient.fromNetwork = realFrom;
    globalThis.fetch = previousFetch;
  }
  }
  }
}

function publishLanded(rawTotal) {
  return (_b, _o, ctx) => {
    ctx.live.history = [staple(ctx.blockHash, FEE), ...oldHistory()];
    ctx.live.balance -= rawTotal + FEE;
    return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
  };
}

function namedFault(name) {
  const err = new Error(`SECRET-${name}-/var/tmp/books.json`);
  err.name = name;
  return err;
}

function quiet(lines) {
  return !lines.some((line) => line.includes("SECRET-") || line.includes("/var/tmp/books.json") || line.includes("/no/such") || line.includes("ENOENT"));
}

function faultFs(point) {
  const booksTmp = new Set();
  const backupFds = new Set();
  const dirFds = new Set();
  let renamed = false;
  let fired = false;
  function once(name) {
    if (fired) return;
    fired = true;
    throw namedFault(name);
  }
  return {
    openSync(path, flags, mode) {
      const text = String(path);
      if (point === "open" && text.endsWith("/books.json.tmp")) once("BooksOpen");
      if (point === "done" && text.endsWith("/done.json.tmp")) throw namedFault("DoneOpen");
      const fd = openSync(path, flags, mode);
      if (text.endsWith("/books.json.tmp")) booksTmp.add(fd);
      if (text.includes("books.json.pre-refund-")) backupFds.add(fd);
      if (flags === "r") dirFds.add(fd);
      return fd;
    },
    writeFileSync(target, body, ...rest) {
      if (point === "write" && booksTmp.has(target)) once("BooksWrite");
      return writeFileSync(target, body, ...rest);
    },
    fchownSync(fd, uid, gid) {
      if (point === "fchown" && booksTmp.has(fd)) once("BooksChown");
      return fchownSync(fd, uid, gid);
    },
    fchmodSync(fd, mode) {
      if (point === "fchmod" && booksTmp.has(fd)) once("BooksChmod");
      return fchmodSync(fd, mode);
    },
    fsyncSync(fd) {
      if (point === "backup-fsync" && backupFds.has(fd)) once("BackupFsync");
      if (point === "fsync" && booksTmp.has(fd)) once("BooksFsync");
      if (point === "dir-fsync" && renamed && dirFds.has(fd)) once("DirFsync");
      return fsyncSync(fd);
    },
    closeSync(fd) {
      if (point === "close" && booksTmp.has(fd)) once("BooksClose");
      booksTmp.delete(fd);
      backupFds.delete(fd);
      dirFds.delete(fd);
      return closeSync(fd);
    },
    renameSync(from, to) {
      if (point === "rename" && String(to).endsWith("/books.json")) throw namedFault("BooksRename");
      const result = renameSync(from, to);
      if (String(to).endsWith("/books.json")) renamed = true;
      return result;
    },
    copyFileSync(from, to) {
      if (point === "copy" && String(to).includes("books.json.pre-refund-")) throw namedFault("BackupCopy");
      return copyFileSync(from, to);
    },
    chmodSync(path, mode) {
      if (point === "chmod" && String(path).includes("books.json.pre-refund-")) throw namedFault("BackupChmod");
      return chmodSync(path, mode);
    },
    statSync(path, ...args) {
      const text = String(path);
      if (point === "stat" && text.endsWith("/books.json")) throw namedFault("BooksStat");
      const st = statSync(path, ...args);
      if (point === "confirm-stat" && renamed && text.endsWith("/books.json")) throw namedFault("ConfirmStat");
      if (point === "confirm-mode" && renamed && text.endsWith("/books.json")) return { uid: st.uid, gid: st.gid, mode: 0o100600 };
      if (point === "sticky" && text.endsWith("/books.json")) return { uid: st.uid, gid: st.gid, mode: renamed ? 0o101640 : 0o100640 };
      return st;
    },
  };
}

{
  const dir = mkdtempSync(join(SUITE, "kore-uid-"));
  writeFileSync(join(dir, "books.json"), readFileSync(FIXTURE));
  const books = booksFromJson(JSON.parse(readFileSync(join(dir, "books.json"), "utf8")));
  const lines = [];
  const code = await main({
    argv: ["--no-quote"],
    dir,
    now: NOW,
    output: (line) => lines.push(line),
    systemctl: () => "inactive",
    processes: () => [],
    accountFrom: (id) => ({ publicKeyString: id }),
    base: BASE,
    baseText: BASE_TEXT,
    client: {
      async balance() { return accounted(books); },
      async pendingBlock() { return null; },
      async getHistory() { return oldHistory(); },
      async send() { throw new Error("send"); },
      async recover() { throw new Error("recover"); },
    },
  });
  const rootUser = process.getuid() === 0;
  check("N1 a missing uid hook follows the real user", rootUser
    ? code === 0 && !has(lines, "must run as root") && has(lines, "REFUND_DRY_RUN_OK (no quote)")
    : code === 2 && has(lines, "REFUND_REFUSED: must run as root") && !existsSync(join(dir, "refund")));
}

{
  const info = await plan();
  const parent = mkdtempSync(join(SUITE, "n2-"));
  const root = join(parent, "root");
  mkdirSync(root);
  writeFileSync(join(root, "run.mjs"), "// root\n");
  const linkParent = join(parent, "link");
  mkdirSync(linkParent);
  const link = join(linkParent, "root");
  symlinkSync(root, link);
  const elsewhere = join(parent, "else");
  mkdirSync(elsewhere);
  unlinkSync(join(root, "run.mjs"));
  const cwdLink = await run({
    argv: ["--no-quote"],
    procRootDir: link,
    processes: () => [{ argv: ["node", "run.mjs"], cwd: root }],
  });
  check("N2 a cwd through a symlink is the runner", cwdLink.code === 2 && has(cwdLink.lines, "REFUND_REFUSED: run.mjs is running"));
  writeFileSync(join(root, "run.mjs"), "// root\n");
  const argvLink = await run({
    argv: ["--no-quote"],
    procRootDir: root,
    processes: () => [{ argv: ["node", join(link, "run.mjs")], cwd: elsewhere }],
  });
  check("N2 an argv path through a symlink is the runner", argvLink.code === 2 && has(argvLink.lines, "REFUND_REFUSED: run.mjs is running"));
  const sibling = join(parent, "root2");
  mkdirSync(sibling);
  writeFileSync(join(sibling, "run.mjs"), "// sibling\n");
  const beside = await run({
    argv: ["--no-quote"],
    procRootDir: root,
    processes: () => [{ argv: ["node", join(sibling, "run.mjs")], cwd: "/" }],
  });
  check("N2 a sibling root is not the runner", beside.code === 0 && !has(beside.lines, "run.mjs is running") && !has(beside.lines, "process list unreadable"));
  const outsideDir = join(parent, "out");
  mkdirSync(outsideDir);
  writeFileSync(join(outsideDir, "run.mjs"), "// out\n");
  const outside = await run({
    argv: ["--no-quote"],
    procRootDir: root,
    processes: () => [{ argv: ["node", join(outsideDir, "run.mjs")], cwd: outsideDir }],
  });
  check("N2 a run.mjs outside the real root is not the runner", outside.code === 0 && !has(outside.lines, "run.mjs is running"));
  const missing = join(parent, "missing");
  const literal = await run({
    argv: ["--no-quote"],
    procRootDir: missing,
    processes: () => [{ argv: ["node", join(outsideDir, "run.mjs")], cwd: missing }],
  });
  check("N2 a literal cwd match is the runner even when argv is outside", literal.code === 2 && has(literal.lines, "REFUND_REFUSED: run.mjs is running"));
  const literalMissing = await run({
    argv: ["--no-quote"],
    procRootDir: missing,
    processes: () => [{ argv: ["node", "run.mjs"], cwd: missing }],
  });
  check("N2 a literal match still counts when realpath of the root throws", literalMissing.code === 2 && has(literalMissing.lines, "REFUND_REFUSED: run.mjs is running") && !has(literalMissing.lines, "process list unreadable"));
  const unresolved = await run({
    argv: ["--no-quote"],
    procRootDir: root,
    processes: () => [{ argv: ["node", "/no/such/run.mjs"], cwd: "/" }],
  });
  check("N2 an unresolvable argv is refused without the path", unresolved.code === 2 && has(unresolved.lines, "REFUND_REFUSED: process list unreadable") && quiet(unresolved.lines) && unresolved.counts.quotes === 0);
  const missingRun = await run({
    argv: ["--no-quote"],
    procRootDir: missing,
    processes: () => [{ argv: ["node", join(outsideDir, "run.mjs")], cwd: outsideDir }],
  });
  check("F-D a missing root with a non-matching run.mjs is not refused", missingRun.code === 0 && !has(missingRun.lines, "process list unreadable") && !has(missingRun.lines, "run.mjs is running"));
  let seen = 0;
  let quoteDir = "";
  let stopRec = null;
  const late = await run({
    argv: sendArgv(info),
    procRootDir: root,
    onQuote: (found) => { quoteDir = found; },
    processes: () => {
      seen += 1;
      if (seen === 1) return [];
      const stopPath = join(quoteDir, "STOP");
      const st = statSync(stopPath);
      stopRec = { bytes: readFileSync(stopPath), mtimeMs: st.mtimeMs, mode: st.mode, ino: st.ino };
      return [{ argv: ["node", "/no/such/run.mjs"], cwd: "/" }];
    },
  });
  const lateStop = statSync(join(late.dir, "STOP"));
  check("N2 an unresolvable argv on the recheck keeps STOP", late.code === 2 && has(late.lines, "REFUND_REFUSED: process list unreadable") && quiet(late.lines) && existsSync(join(late.dir, "STOP")) && readFileSync(join(late.dir, "STOP")).equals(stopRec.bytes) && stopRec.bytes.equals(Buffer.from("refund in progress\n")) && lateStop.mtimeMs === stopRec.mtimeMs && lateStop.ino === stopRec.ino && (lateStop.mode & 0o777) === 0o600 && !existsSync(join(late.dir, "refund", "intent.json")) && late.counts.publish === 0);
}

{
  const info = await plan();
  const rawTotal = BigInt(info.total.replace(".", ""));
  async function landed() {
    return run({ argv: sendArgv(info), onPublish: publishLanded(rawTotal) });
  }
  async function sealed(body, label, line) {
    const ran = await landed();
    writeFileSync(join(ran.dir, "refund", "done.json"), body);
    const shot = snapshot(ran.dir);
    const verified = await ran.again(["--verify"]);
    check(label, verified.code === 3 && verified.lines.includes(line) && snapshot(ran.dir) === shot && quiet(verified.lines));
  }
  await sealed(`${JSON.stringify({ block: "REFUNDHASH", total: "1", plan: "p", books: "unconfirmed" })}\n`, "N3 unconfirmed done.json is not finished", "REFUND_VERIFY: LANDED books written, not confirmed");
  await sealed(`${JSON.stringify({ block: "REFUNDHASH", total: "1", plan: "p" })}\n`, "N3 a missing books field is invalid", "REFUND_VERIFY: UNKNOWN done.json books field missing or invalid");
  await sealed(`${JSON.stringify({ block: "REFUNDHASH", books: "later" })}\n`, "N3 any other books value is invalid", "REFUND_VERIFY: UNKNOWN done.json books field missing or invalid");
  await sealed("{\n", "N3 invalid done.json is unreadable", "REFUND_VERIFY: UNKNOWN done.json unreadable");
  await sealed("[]\n", "N3 a non-object done.json is unreadable", "REFUND_VERIFY: UNKNOWN done.json unreadable");
  const ran = await landed();
  const shot = snapshot(ran.dir);
  const denied = await ran.again(["--verify"], {
    fs: {
      readFileSync(path, ...args) {
        if (String(path).endsWith("/done.json")) throw namedFault("DoneRead");
        return readFileSync(path, ...args);
      },
    },
  });
  check("N3 an unreadable done.json makes no writes", denied.code === 3 && denied.lines.includes("REFUND_VERIFY: UNKNOWN done.json unreadable") && snapshot(ran.dir) === shot && quiet(denied.lines));
}

{
  const info = await plan();
  const rawTotal = BigInt(info.total.replace(".", ""));
  const reference = await run({ argv: sendArgv(info), onPublish: publishLanded(rawTotal) });
  const adjustedBytes = readFileSync(reference.booksPath);
  const before = [
    ["stat", "BOOKS_MISMATCH", "mismatch", false],
    ["copy", "BOOKS_MISMATCH", "mismatch", false],
    ["chmod", "BOOKS_MISMATCH", "mismatch", false],
    ["backup-fsync", "BOOKS_MISMATCH", "mismatch", false],
    ["open", "BOOKS_MISMATCH", "mismatch", false],
    ["write", "BOOKS_MISMATCH", "mismatch", false],
    ["fchown", "BOOKS_MISMATCH", "mismatch", false],
    ["fchmod", "BOOKS_MISMATCH", "mismatch", false],
    ["fsync", "BOOKS_MISMATCH", "mismatch", false],
    ["close", "BOOKS_MISMATCH", "mismatch", false],
    ["rename", "BOOKS_MISMATCH", "mismatch", false],
    ["dir-fsync", "BOOKS_UNCONFIRMED", "unconfirmed", true],
    ["confirm-stat", "BOOKS_UNCONFIRMED", "unconfirmed", true],
    ["confirm-mode", "BOOKS_UNCONFIRMED", "unconfirmed", true],
    ["sticky", "BOOKS_UNCONFIRMED", "unconfirmed", true],
  ];
  for (const [point, line, books, adjusted] of before) {
    const ran = await run({ argv: sendArgv(info), fs: faultFs(point), onPublish: publishLanded(rawTotal) });
    const done = JSON.parse(readFileSync(join(ran.dir, "refund", "done.json"), "utf8"));
    const verifyLine = books === "mismatch"
      ? "REFUND_VERIFY: LANDED books not adjusted"
      : "REFUND_VERIFY: LANDED books written, not confirmed";
    const shot = snapshot(ran.dir);
    const verified = await ran.again(["--verify"]);
    const booksNow = readFileSync(ran.booksPath);
    const expectBooks = adjusted ? adjustedBytes : ran.booksAtStart;
    check(`N4 ${point} seals ${books}`, ran.code === 3 && ran.lines.includes(line) && !ran.lines.includes(books === "mismatch" ? "BOOKS_UNCONFIRMED" : "BOOKS_MISMATCH") && done.books === books && booksNow.equals(expectBooks) && !existsSync(join(ran.dir, "books.json.tmp")) && readdirSync(join(ran.dir, "refund")).some((name) => name.startsWith("receipt-")) && quiet(ran.lines) && verified.code === 3 && verified.lines.includes(verifyLine) && snapshot(ran.dir) === shot);
  }
  const dropped = await run({ argv: sendArgv(info), fs: faultFs("done"), onPublish: publishLanded(rawTotal) });
  const afterSend = readFileSync(dropped.booksPath);
  const doneAfterSend = existsSync(join(dropped.dir, "refund", "done.json"));
  const stopped = await twoVerifies(dropped, "unknown");
  check("F-E a receipt with no done.json stops verify without writes", dropped.code === 3 && has(dropped.lines, "REFUND_HOLD: unexpected DoneOpen") && !doneAfterSend && afterSend.equals(adjustedBytes) && quiet(dropped.lines) && stopped && readFileSync(dropped.booksPath).equals(afterSend));
}

{
  const info = await plan();
  const rawTotal = BigInt(info.total.replace(".", ""));
  function ownerFs(order, mode) {
    let booksFd = -1;
    return {
      openSync(path, flags, modeArg) {
        const fd = openSync(path, flags, modeArg);
        if (String(path).endsWith("/books.json.tmp")) booksFd = fd;
        order.push({ op: "open", path: String(path), fd });
        return fd;
      },
      statSync(path, ...args) {
        const st = statSync(path, ...args);
        if (String(path).endsWith("/books.json")) return { uid: 1001, gid: 1001, mode };
        return st;
      },
      fchownSync(fd, uid, gid) {
        order.push({ op: "fchown", fd, uid, gid });
      },
      fchmodSync(fd, modeArg) {
        order.push({ op: "fchmod", fd, mode: modeArg });
      },
      fsyncSync(fd) {
        order.push({ op: "fsync", fd });
        return fsyncSync(fd);
      },
      renameSync(from, to) {
        order.push({ op: "rename", from: String(from), to: String(to) });
        return renameSync(from, to);
      },
      booksFd: () => booksFd,
    };
  }
  for (const [mode, expectMode, label] of [[0o100640, 0o640, "0640"], [0o104640, 0o4640, "setuid"]]) {
    const order = [];
    const fs = ownerFs(order, mode);
    const ran = await run({ argv: sendArgv(info), fs, onPublish: publishLanded(rawTotal) });
    const booksIndex = order.findIndex((event) => event.op === "open" && event.path.endsWith("/books.json.tmp"));
    const booksEvents = booksIndex < 0 ? [] : eventsAfterOpen(order, booksIndex);
    const chown = booksEvents.find((event) => event.op === "fchown");
    const chmod = booksEvents.find((event) => event.op === "fchmod");
    const sync = booksEvents.find((event) => event.op === "fsync");
    const chownAt = booksEvents.indexOf(chown);
    const chmodAt = booksEvents.indexOf(chmod);
    const syncAt = booksEvents.indexOf(sync);
    const renameAt = order.findIndex((event) => event.op === "rename" && event.to.endsWith("/books.json"));
    const syncInOrder = order.indexOf(sync);
    check(`N5 fchown and fchmod ${label} precede fsync`, ran.code === 0 && has(ran.lines, "BOOKS_OK") && chown?.uid === 1001 && chown?.gid === 1001 && chmod?.mode === expectMode && chownAt >= 0 && chownAt < chmodAt && chmodAt < syncAt && syncInOrder >= 0 && syncInOrder < renameAt);
  }
  const kept = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      chmodSync(join(ctx.dir, "books.json"), 0o644);
      return publishLanded(rawTotal)(_b, _o, ctx);
    },
  });
  const keptStat = statSync(kept.booksPath);
  check("N5 mode 0644 stays 0644 for this user", kept.code === 0 && (keptStat.mode & 0o777) === 0o644 && keptStat.uid === process.getuid() && keptStat.gid === process.getgid());
  const modes = [];
  for (const name of readdirSync(join(kept.dir, "refund"))) modes.push([name, statSync(join(kept.dir, "refund", name)).mode & 0o777]);
  const backup = readdirSync(kept.dir).find((name) => name.startsWith("books.json.pre-refund-"));
  modes.push([backup, statSync(join(kept.dir, backup)).mode & 0o777]);
  check("N5 done receipt intent log and backup are mode 0600", modes.every(([, mode]) => mode === 0o600) && modes.some(([name]) => name === "done.json") && modes.some(([name]) => name === "intent.json") && modes.some(([name]) => name.startsWith("receipt-")) && modes.some(([name]) => name.startsWith("refund-")) && modes.some(([name]) => name.startsWith("books.json.pre-refund-")));
}

{
  const info = await plan();
  const rawTotal = BigInt(info.total.replace(".", ""));
  const capLine = rawTotal + REFUND_FEE_CAP + RESERVE;
  const quoteLine = rawTotal + FEE + RESERVE;
  let dir = "";
  let stopRec = null;
  const ran = await run({
    argv: sendArgv(info),
    onQuote: (found) => { dir = found; },
    onBalance: (n, live) => {
      if (n < 2) return live.balance;
      if (!stopRec) {
        const st = statSync(join(dir, "STOP"));
        stopRec = { bytes: readFileSync(join(dir, "STOP")), mtimeMs: st.mtimeMs, mode: st.mode, ino: st.ino };
      }
      const take = (live.balance - capLine) + 1n;
      const body = JSON.parse(readFileSync(join(dir, "books.json"), "utf8"));
      const operator = BigInt(body.operator);
      const fromOperator = operator < take ? operator : take;
      body.operator = (operator - fromOperator).toString();
      body.reserve = (BigInt(body.reserve) - (take - fromOperator)).toString();
      writeFileSync(join(dir, "books.json"), JSON.stringify(body));
      return live.balance - take;
    },
  });
  const next = ran.live.balance - ((ran.live.balance - capLine) + 1n);
  const kept = statSync(join(ran.dir, "STOP"));
  check("N6 the recheck uses the fee cap not the quote", next >= quoteLine && next < capLine && ran.code === 2 && ran.lines.includes("REFUND_REFUSED: balance is short of the refund") && existsSync(join(ran.dir, "STOP")) && readFileSync(join(ran.dir, "STOP")).equals(stopRec.bytes) && stopRec.bytes.equals(Buffer.from("refund in progress\n")) && kept.mtimeMs === stopRec.mtimeMs && kept.ino === stopRec.ino && (kept.mode & 0o777) === 0o600 && !existsSync(join(ran.dir, "refund", "intent.json")) && ran.counts.publish === 0 && ran.counts.quotes === 1);
}

{
  const info = await plan();
  const rawTotal = BigInt(info.total.replace(".", ""));
  const order = [];
  let original;
  const sent = await run({
    argv: sendArgv(info),
    fs: trackIo(order),
    onPublish: (_b, _o, ctx) => {
      original = statSync(join(ctx.dir, "books.json"));
      return publishLanded(rawTotal)(_b, _o, ctx);
    },
  });
  const once = readFileSync(sent.booksPath);
  const first = await sent.again(["--verify"]);
  const second = await sent.again(["--verify"]);
  function sameOwner(path) {
    const st = statSync(path);
    return st.uid === original.uid && st.gid === original.gid && (st.mode & 0o7777) === (original.mode & 0o7777);
  }
  const writes = order.filter((event) => event.op === "rename" && event.to.endsWith("/books.json")).length;
  const started = readFileSync(FIXTURE);
  check("N multi-tick landed verifies are finished and the books are written once", sent.code === 0 && has(sent.lines, "REFUND_LANDED") && has(sent.lines, "BOOKS_OK") && first.code === 0 && first.lines.includes("REFUND_VERIFY: LANDED (already finished)") && second.code === 0 && second.lines.includes("REFUND_VERIFY: LANDED (already finished)") && writes === 1 && readFileSync(sent.booksPath).equals(once) && !once.equals(started) && sameOwner(sent.booksPath));
  const quotesAfter = sent.counts.quotes;
  const publishAfter = sent.counts.publish;
  const stopPath = join(sent.dir, "STOP");
  const stopBefore = statSync(stopPath);
  const stopBytes = readFileSync(stopPath);
  const blocked = await sent.again(sendArgv(info));
  const stopAfter = statSync(stopPath);
  check("N multi-tick a kept STOP blocks a second send", blocked.code === 2 && blocked.lines.includes("REFUND_REFUSED: STOP is present") && sent.counts.quotes === quotesAfter && sent.counts.publish === publishAfter && stopBytes.equals(readFileSync(stopPath)) && stopBytes.equals(Buffer.from("refund in progress\n")) && stopAfter.mtimeMs === stopBefore.mtimeMs && stopAfter.ino === stopBefore.ino && (stopAfter.mode & 0o777) === 0o600);

  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const shift = BigInt(raw.operator) + RAW;
  raw.operator = (-RAW).toString();
  raw.parked = (BigInt(raw.parked ?? "0") + shift).toString();
  const text = JSON.stringify(raw);
  const mismatch = await run({ argv: sendArgv(info), booksText: text, onPublish: publishLanded(rawTotal) });
  const mismatchVerify = await mismatch.again(["--verify"]);
  const mismatchAgain = await mismatch.again(["--verify"]);
  check("N multi-tick books mismatch stays unadjusted", mismatch.code === 3 && has(mismatch.lines, "BOOKS_MISMATCH") && mismatchVerify.code === 3 && mismatchVerify.lines.includes("REFUND_VERIFY: LANDED books not adjusted") && mismatchAgain.code === 3 && mismatchAgain.lines.includes("REFUND_VERIFY: LANDED books not adjusted") && readFileSync(mismatch.booksPath, "utf8") === text);

  const faulted = await run({ argv: sendArgv(info), fs: faultFs("fchown"), onPublish: publishLanded(rawTotal) });
  const faultVerify = await faulted.again(["--verify"]);
  const faultAgain = await faulted.again(["--verify"]);
  check("N multi-tick a before-rename fault stays a mismatch", faulted.code === 3 && has(faulted.lines, "BOOKS_MISMATCH") && faultVerify.code === 3 && faultVerify.lines.includes("REFUND_VERIFY: LANDED books not adjusted") && faultAgain.code === 3 && faultAgain.lines.includes("REFUND_VERIFY: LANDED books not adjusted") && readFileSync(faulted.booksPath).equals(faulted.booksAtStart) && !existsSync(join(faulted.dir, "books.json.tmp")));

  const late = await run({ argv: sendArgv(info), fs: faultFs("confirm-mode"), onPublish: publishLanded(rawTotal) });
  const lateBytes = readFileSync(late.booksPath);
  const lateVerify = await late.again(["--verify"]);
  const lateAgain = await late.again(["--verify"]);
  check("N multi-tick an after-rename fault stays unconfirmed", late.code === 3 && has(late.lines, "BOOKS_UNCONFIRMED") && lateVerify.code === 3 && lateVerify.lines.includes("REFUND_VERIFY: LANDED books written, not confirmed") && lateAgain.code === 3 && lateAgain.lines.includes("REFUND_VERIFY: LANDED books written, not confirmed") && readFileSync(late.booksPath).equals(lateBytes));

  const old = await run({ argv: sendArgv(info), onPublish: publishLanded(rawTotal) });
  const oldDone = JSON.parse(readFileSync(join(old.dir, "refund", "done.json"), "utf8"));
  delete oldDone.books;
  writeFileSync(join(old.dir, "refund", "done.json"), `${JSON.stringify(oldDone)}\n`);
  const oldShot = snapshot(old.dir);
  const oldVerify = await old.again(["--verify"]);
  const oldAgain = await old.again(["--verify"]);
  check("N multi-tick old done.json stays invalid", oldVerify.code === 3 && oldVerify.lines.includes("REFUND_VERIFY: UNKNOWN done.json books field missing or invalid") && oldAgain.code === 3 && oldAgain.lines.includes("REFUND_VERIFY: UNKNOWN done.json books field missing or invalid") && snapshot(old.dir) === oldShot);

  const broken = await run({ argv: sendArgv(info), onPublish: publishLanded(rawTotal) });
  writeFileSync(join(broken.dir, "refund", "done.json"), "{\n");
  const brokenShot = snapshot(broken.dir);
  const brokenVerify = await broken.again(["--verify"]);
  const brokenAgain = await broken.again(["--verify"]);
  check("N multi-tick unreadable done.json stays unreadable", brokenVerify.code === 3 && brokenVerify.lines.includes("REFUND_VERIFY: UNKNOWN done.json unreadable") && brokenAgain.code === 3 && brokenAgain.lines.includes("REFUND_VERIFY: UNKNOWN done.json unreadable") && snapshot(broken.dir) === brokenShot);
}

{
  const info = await plan();
  const rawTotal = BigInt(info.total.replace(".", ""));
  const sent = await run({ argv: sendArgv(info), onPublish: publishLanded(rawTotal) });
  const adjusted = readFileSync(sent.booksPath);
  const backup = readdirSync(sent.dir).find((name) => name.startsWith("books.json.pre-refund-"));
  rmSync(join(sent.dir, "refund", "done.json"));
  removeReceipts(sent.dir);
  copyFileSync(join(sent.dir, backup), sent.booksPath);
  let renames = 0;
  const fault = faultFs("done");
  const fs = {
    ...fault,
    renameSync(from, to) {
      if (String(to).endsWith("/books.json")) renames += 1;
      return fault.renameSync(from, to);
    },
  };
  const mid = await sent.again(["--verify"], { fs });
  const receiptNow = readdirSync(join(sent.dir, "refund")).some((name) => name.startsWith("receipt-"));
  const booksAfter = readFileSync(sent.booksPath);
  const stopped = await twoVerifies(sent, "unknown");
  check("F-B a done.json write error in verify is UNKNOWN exit 3", sent.code === 0 && has(sent.lines, "BOOKS_OK") && mid.code === 3 && has(mid.lines, "REFUND_VERIFY: UNKNOWN unexpected DoneOpen") && !has(mid.lines, "REFUND_REFUSED:") && !has(mid.lines, "BOOKS_OK") && quiet(mid.lines) && !existsSync(join(sent.dir, "refund", "done.json")) && receiptNow && !existsSync(join(sent.dir, "books.json.tmp")) && booksAfter.equals(adjusted) && renames === 1 && stopped);
}

{
  const info = await plan();
  const rawTotal = BigInt(info.total.replace(".", ""));
  async function crashed(blockHash) {
    return run({ argv: sendArgv(info), blockHash, fs: faultFs("done"), onPublish: publishLanded(rawTotal) });
  }
  function receiptPath(dir) {
    const refundDir = join(dir, "refund");
    const name = readdirSync(refundDir).find((item) => item.startsWith("receipt-") && item.endsWith(".json"));
    return name ? join(refundDir, name) : "";
  }
  const other = await crashed();
  const otherPath = receiptPath(other.dir);
  const otherBody = JSON.parse(readFileSync(otherPath, "utf8"));
  otherBody.block = "B".repeat(64);
  writeFileSync(otherPath, `${JSON.stringify(otherBody, null, 2)}\n`);
  check("F-E a receipt for another block also stops", other.code === 3 && !existsSync(join(other.dir, "refund", "done.json")) && await twoVerifies(other, "unknown"));
  const leftover = await crashed();
  const leftPath = receiptPath(leftover.dir);
  const leftName = basename(leftPath);
  const when = leftName.slice("receipt-".length, -".json".length);
  renameSync(leftPath, join(leftover.dir, "refund", `receipt-${when}.json.tmp`));
  check("F-E a receipt tmp leftover also stops", leftover.code === 3 && await twoVerifies(leftover, "unknown"));
  const junk = await crashed();
  writeFileSync(receiptPath(junk.dir), "not json");
  check("F-E an unreadable receipt also stops", junk.code === 3 && await twoVerifies(junk, "unknown"));
  const modeRun = await crashed();
  chmodSync(join(modeRun.dir, "refund"), 0o755);
  check("F-E a refund folder left at 0755 is not chmodded", modeRun.code === 3 && await twoVerifies(modeRun, "unknown") && (statSync(join(modeRun.dir, "refund")).mode & 0o777) === 0o755);
  const listed = await crashed();
  check("F-E a refund listing error stops verify", listed.code === 3 && await twoVerifies(listed, "unknown", () => ({
    readdirSync(path, ...args) {
      if (String(path).endsWith("/refund")) throw new Error("list");
      return readdirSync(path, ...args);
    },
  })));
  const upper = "AB".repeat(32);
  const upperRun = await crashed(upper);
  check("F-E a 64 uppercase block hash is printed", upperRun.code === 3 && await twoVerifies(upperRun, upper));
  const lower = "ab".repeat(32);
  const lowerRun = await crashed(lower);
  check("F-E a 64 lowercase block hash prints unknown", lowerRun.code === 3 && await twoVerifies(lowerRun, "unknown"));
  const secret = await crashed("SECRET-HASH/../x");
  check("F-E a block that is not 64 uppercase hex prints unknown", secret.code === 3 && await twoVerifies(secret, "unknown"));
}

{
  const extra = readdirSync(tmpdir()).filter((name) => !tmpBefore.has(name));
  check("F-C the suite leaves nothing in tmpdir outside its parent", extra.length === 1 && extra[0] === basename(SUITE));
  check("F-C the suite parent is safe to remove", suiteParentIsSafe(SUITE) && !suiteParentIsSafe(join(tmpdir(), "not-a-suite")) && !suiteParentIsSafe(join("/etc", "kore-refund-suite-nope")));
  check("F-A STOP is unchanged after every main() run", stopViolations.length === 0);
  check("F-A refund.mjs STOP and remove allowlist", allow.ok);
}

console.log(`refund checks ${passed}`);
