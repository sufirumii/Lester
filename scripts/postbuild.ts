/**
 * Cross-platform post-build step: Next standalone needs .next/static and
 * public/ copied next to server.js (B1 — the old `cp -r` broke on Windows).
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..");
const standalone = path.join(ROOT, ".next", "standalone");

mkdirSync(standalone, { recursive: true });
cpSync(path.join(ROOT, ".next", "static"), path.join(standalone, ".next", "static"), { recursive: true });
if (existsSync(path.join(ROOT, "public"))) {
  cpSync(path.join(ROOT, "public"), path.join(standalone, "public"), { recursive: true });
}
console.log("[lester] standalone assets copied");
