import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function assertWriteDir(dir) {
  if (typeof dir !== "string" || dir.trim() === "") throw new Error("path refused");
  const resolved = resolve(dir);
  if (resolved === "/opt/koreminer" || resolved.startsWith("/opt/koreminer/")) {
    throw new Error("path refused");
  }
  const base = resolved.slice(resolved.lastIndexOf("/") + 1);
  if (base === "books.json" || base === "lookup.json") throw new Error("path refused");
  return resolved;
}

export function writeAtomic(dir, relativeName, text) {
  if (typeof relativeName !== "string" || relativeName === "" || relativeName.includes("..") || relativeName.startsWith("/")) {
    throw new Error("path refused");
  }
  const resolved = assertWriteDir(dir);
  const dest = join(resolved, relativeName);
  if (!dest.startsWith(`${resolved}/`)) throw new Error("path refused");
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = join(dirname(dest), `.${dest.slice(dest.lastIndexOf("/") + 1)}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, dest);
}
