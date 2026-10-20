import { existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  console.log("ok", name);
}

if (existsSync("/opt/koreminer")) throw new Error("refusing to start the runner while /opt/koreminer exists");

const run = fileURLToPath(new URL("./run.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "kore-main-"));
const link = join(dir, "koreminer");
symlinkSync(run, link);

function start(path) {
  return spawnSync(process.execPath, [path], { encoding: "utf8", timeout: 20000 });
}

function text(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

const linked = start(link);
const linkedOut = text(linked);
check("a symlink starts the runner", linked.status !== 0 && linked.status !== null, String(linked.status));
check("a symlink start stops on the missing seed", /ENOENT|seed\.txt/.test(linkedOut));
check("a symlink start prints no secret", !/mnemonic|seed phrase/i.test(linkedOut));

const direct = start(run);
const directOut = text(direct);
check("a direct start still starts", direct.status !== 0 && direct.status !== null, String(direct.status));
check("a direct start stops on the missing seed", /ENOENT|seed\.txt/.test(directOut));
console.log("fee-main checks", passed);
