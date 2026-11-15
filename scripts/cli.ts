/**
 * Lester CLI — every operational subcommand in one file.
 *
 *   bun scripts/cli.ts <command> [args…]
 *
 * Commands (all also wired as `bun run …` scripts in package.json — same
 * arguments, same output as the v1.0.1 per-file scripts):
 *
 *   backup          consistent integrity-checked database snapshot
 *   restore         safe restore (checksum + integrity + pre-restore snapshot)
 *   verify-proof    offline verification of a signed Proof export
 *   admin-recover   offline admin password reset (server stopped)
 *   export-keys     key bundle for off-machine disaster recovery
 *   issue-license   vendor-side: issue an offline team license key
 *   devkey          contributor dev license keypair → .env override
 *   licenses        write THIRD_PARTY_LICENSES.md from installed packages
 *   rotate-proof-key  rotate the Proof signing key (old key archived)
 *   migrate         safe schema upgrades (auto-backup, never destructive)
 *   icons           regenerate the favicon/PWA raster set from brand/mark.svg
 *   test            run the bun test suite (per-file process isolation)
 *   vendor-offline  build an air-gap installation bundle (needs network once)
 *
 * v1.0.2 repository consolidation: merged from scripts/{backup,restore,
 * verify-proof,admin-recover,export-keys,issue-license,devkey,licenses,
 * rotate-proof-key,migrate,gen-icons,run-tests}.ts and vendor-offline.sh —
 * logic unchanged; argument parsing reads ARGS (everything after the command).
 */
import "./_defaults"; // DATABASE_URL / LESTER_DATA_DIR defaults — must run before any src/lib import
import { createCipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, scryptSync, sign as edSign, verify as edVerify } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { db, initDurability } from "../src/lib/db";
import { hashPassword, masterKeyFilePath, proofSigningKeyPath, rotateProofSigningKey } from "../src/lib/auth";
import { appendProof, createCheckpoint, rehashLegacyChain, verifyChain } from "../src/lib/proof";
import { runMigrations } from "../src/lib/storage";
import { LESTER, dataPaths } from "../src/lib/env";

const COMMAND = process.argv[2];
const ARGS = process.argv.slice(3);
const ROOT = path.join(import.meta.dir, "..");

function arg(name: string, fallback?: string): string | undefined {
  const i = ARGS.indexOf(`--${name}`);
  return i >= 0 ? ARGS[i + 1] : fallback;
}

// ═══ backup (from scripts/backup.ts) ══════════════════════════════════════════

async function cmdBackup(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "file:./db/lester.db";
  const m = url.match(/^file:(.*?)(\?.*)?$/);
  const dbFile = m?.[1] ?? "./db/lester.db";
  const dataDir = process.env.LESTER_DATA_DIR ?? path.join(process.cwd(), "db");
  const backupsDir = process.env.LESTER_BACKUP_DIR?.trim() || path.join(dataDir, "backups");

  if (!existsSync(dbFile)) {
    console.error(`\u2718 Database not found at ${dbFile}. Start Lester first.`);
    process.exit(1);
  }
  mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const finalPath = path.join(backupsDir, `lester-backup-${stamp}.db`);

  // consistent snapshot (online backup API — not a file copy)
  const db = new PrismaClient({ datasources: { db: { url: `file:${dbFile}?connection_limit=1` } } });
  try {
    await db.$executeRawUnsafe("VACUUM INTO ?", finalPath);
  } finally {
    await db.$disconnect();
  }

  // integrity check on the snapshot
  const check = new PrismaClient({ datasources: { db: { url: `file:${finalPath}?connection_limit=1` } } });
  let integrity = "error";
  try {
    const rows = await check.$queryRawUnsafe<Array<{ integrity_check: string }>>("PRAGMA integrity_check");
    integrity = rows[0]?.integrity_check ?? "no-result";
  } finally {
    await check.$disconnect();
  }
  if (integrity !== "ok") {
    unlinkSync(finalPath);
    console.error(`\u2718 Snapshot failed integrity_check (${integrity}) — deleted. Refusing to ship a bad backup.`);
    process.exit(1);
  }

  const size = statSync(finalPath).size;
  const sha = createHash("sha256").update(readFileSync(finalPath)).digest("hex");
  console.log(`\u2714 Backup written: ${finalPath}`);
  console.log(`  size: ${(size / 1024).toFixed(1)} KB \u00b7 sha256: ${sha}`);
  console.log(`  integrity_check: ok`);
  console.log("  Note: this file contains the Proof ledger. Key material (needed to");
  console.log("  decrypt encrypted content after a restore on other hardware) is NOT");
  console.log("  included — run `bun run keys:export` separately. See docs/guide.md → Backups.");
}

// ═══ restore (from scripts/restore.ts) ════════════════════════════════════════

async function cmdRestore(): Promise<void> {
  const args = ARGS;
  const file = args.find((a) => !a.startsWith("--"));
  const shaArgIdx = args.indexOf("--sha");
  const expectedSha = shaArgIdx >= 0 ? args[shaArgIdx + 1] : null;

  if (!file || !existsSync(file)) {
    console.error("Usage: bun run restore <backup-file.db> [--sha <expected-sha256>]");
    process.exit(1);
  }

  const url = process.env.DATABASE_URL ?? "file:./db/lester.db";
  const m = url.match(/^file:(.*?)(\?.*)?$/);
  const dbFile = m?.[1] ?? "./db/lester.db";
  const dataDir = process.env.LESTER_DATA_DIR ?? path.join(process.cwd(), "db");
  const backupsDir = process.env.LESTER_BACKUP_DIR?.trim() || path.join(dataDir, "backups");

  async function vacuumInto(src: string, target: string) {
    const c = new PrismaClient({ datasources: { db: { url: `file:${src}?connection_limit=1` } } });
    try {
      await c.$executeRawUnsafe("VACUUM INTO ?", target);
    } finally {
      await c.$disconnect();
    }
  }

  // 1 — checksum (when provided)
  const buf = readFileSync(file);
  if (buf.length === 0) {
    console.error("\u2718 Backup file is empty — refusing.");
    process.exit(1);
  }
  const sha = createHash("sha256").update(buf).digest("hex");
  if (expectedSha && expectedSha.toLowerCase() !== sha) {
    console.error(`\u2718 sha256 mismatch: expected ${expectedSha}, found ${sha}. Refusing.`);
    process.exit(1);
  }

  // 2 — integrity check
  const probe = new PrismaClient({ datasources: { db: { url: `file:${file}?connection_limit=1` } } });
  let integrity = "error";
  try {
    const rows = await probe.$queryRawUnsafe<Array<{ integrity_check: string }>>("PRAGMA integrity_check");
    integrity = rows[0]?.integrity_check ?? "no-result";
  } finally {
    await probe.$disconnect();
  }
  if (integrity !== "ok") {
    console.error(`\u2718 Backup failed integrity_check (${integrity}) — refusing.`);
    process.exit(1);
  }

  // 3 — pre-restore snapshot of the current database
  if (existsSync(dbFile) && statSync(dbFile).size > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safetyPath = path.join(backupsDir, `lester-pre-restore-${stamp}.db`);
    await vacuumInto(dbFile, safetyPath);
    console.log(`\u2714 Pre-restore safety snapshot: ${safetyPath}`);
  }

  // 4 — atomic swap
  for (const ext of ["-wal", "-shm"]) {
    if (existsSync(dbFile + ext)) unlinkSync(dbFile + ext);
  }
  const tmp = `${dbFile}.restore.tmp`;
  await vacuumInto(file, tmp);
  renameSync(tmp, dbFile);
  console.log(`\u2714 Restored ${path.basename(file)} \u2192 ${dbFile}`);
  console.log(`  sha256: ${sha}`);
  console.log("  Start Lester and check Health \u2192 Ledger to re-verify the chain.");
}

// ═══ verify-proof (from scripts/verify-proof.ts) ══════════════════════════════

function cmdVerifyProof(): void {
  const file = ARGS[0];
  if (!file) {
    console.error("Usage: bun run proof:verify -- <report.json>");
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(file, "utf-8"));

  function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }

  // 1 — Ed25519 signature over the canonical payload
  let sigOk = false;
  try {
    sigOk = edVerify(
      null,
      Buffer.from(report.signatureInput, "utf-8"),
      createPublicKey(report.publicKeyPem),
      Buffer.from(report.signature, "base64")
    );
  } catch {
    sigOk = false;
  }
  console.log(`1. Ed25519 signature : ${sigOk ? "VALID" : "INVALID"}`);

  // 2 — recompute the entry hash chain exactly as the node does
  let prevHash: string | null = null;
  let chainOk = true;
  let brokenAt: number | null = null;
  let brokenWhy = "";
  let legacySeen = 0;
  for (const e of report.entries) {
    const isV1 = e.hashVersion === "v1";
    if (isV1) legacySeen++;
    const record = {
      userId: e.userId ?? null,
      username: e.username ?? null,
      workspaceId: e.workspaceId ?? null,
      workspaceName: e.workspaceName ?? null,
      action: e.action,
      status: e.status,
      modelKey: e.modelKey ?? null,
      provider: e.provider ?? null,
      providerLabel: e.providerLabel ?? null,
      endpointHost: e.endpointHost ?? null,
      endpointIp: e.endpointIp ?? null,
      egress: e.egress ?? null,
      latencyMs: e.latencyMs ?? null,
      tokensIn: e.tokensIn ?? null,
      tokensOut: e.tokensOut ?? null,
      redactions: e.redactions ?? null,
      detail: e.detail ?? "{}",
      content: e.content ?? null,
      prevHash,
    };
    if ((e.prevHash ?? null) !== prevHash) {
      chainOk = false;
      brokenAt = e.seq;
      brokenWhy = "prevHash link mismatch — an entry was inserted or removed.";
      break;
    }
    const expected = isV1
      ? createHash("sha256").update((prevHash ?? "") + canonicalJson(record)).digest("hex")
      : createHash("sha256").update(`${prevHash ?? ""}|${e.seq}|${e.ts}|${canonicalJson(record)}`).digest("hex");
    if (expected !== e.selfHash) {
      chainOk = false;
      brokenAt = e.seq;
      brokenWhy = isV1
        ? "selfHash mismatch (v1 form) — an entry was modified after the fact."
        : "selfHash mismatch — an entry, its sequence number or its timestamp was modified.";
      break;
    }
    prevHash = e.selfHash;
  }
  console.log(`2. Hash chain        : ${chainOk ? `VALID (${report.entries.length} entries${legacySeen ? `, ${legacySeen} legacy v1` : ""})` : `BROKEN at seq ${brokenAt} — ${brokenWhy}`}`);
  console.log(`   Head hash         : ${prevHash ?? "(empty ledger)"}`);
  console.log(`   Report period     : ${report.period?.from ?? "beginning"} → ${report.period?.to ?? "now"}`);
  console.log(`   Entries           : ${report.counts?.total}`);
  console.log(`   Egress breakdown  : ${JSON.stringify(report.counts?.byEgress)}`);
  console.log(`   Blocked/redacted  : ${report.counts?.blocked} / ${report.counts?.redacted}`);

  // 3 — signed checkpoints (P2): verify signatures against the embedded key.
  let cpInfo = "none embedded";
  if (Array.isArray(report.checkpoints) && report.checkpoints.length > 0) {
    let cpOk = 0;
    for (const cp of report.checkpoints) {
      const payload = `lester-checkpoint:${report.node?.nodeId ?? "?"}:${cp.seq}:${cp.headHash}:${cp.ts}`;
      try {
        if (edVerify(null, Buffer.from(payload), createPublicKey(report.publicKeyPem), Buffer.from(cp.signature, "base64"))) cpOk++;
      } catch {
        // signature unreadable
      }
    }
    cpInfo = `${cpOk}/${report.checkpoints.length} verify against the report key — anchor at least one outside the host for tamper evidence against disk-level attackers`;
  }
  console.log(`3. Checkpoints       : ${cpInfo}`);

  if (sigOk && chainOk) {
    console.log("\n✔ PROOF VERIFIED — signature and chain both check out.");
    process.exit(0);
  } else {
    console.error("\n✘ VERIFICATION FAILED.");
    process.exit(1);
  }
}

// ═══ admin-recover (from scripts/admin-recover.ts) ════════════════════════════

async function cmdAdminRecover(): Promise<void> {
  const username = (arg("user") ?? "").toLowerCase();
  const password = arg("new-password") ?? "";
  if (!username || !password) {
    console.error("Usage: bun run admin:recover -- --user <username> --new-password '<password>'");
    process.exit(1);
  }

  await initDurability();
  const user = await db.user.findUnique({ where: { username } });
  if (!user) {
    console.error(`✘ No user named "${username}".`);
    process.exit(1);
  }
  if (user.role !== "ADMIN") {
    console.error(`✘ "${username}" is a ${user.role}, not an ADMIN. This tool resets admin accounts.`);
    process.exit(1);
  }
  if (password.length < 10 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    console.error("✘ Password must be at least 10 characters with letters and numbers.");
    process.exit(1);
  }

  await db.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(password), disabled: false } });
  await db.session.deleteMany({ where: { userId: user.id } });
  await db.loginAttempt.deleteMany({ where: { key: { startsWith: `${username}|` } } });
  await appendProof({
    userId: user.id,
    username,
    action: "auth.admin_recover",
    status: "ok",
    detail: { method: "offline CLI", sessionsRevoked: true },
  });
  console.log(`✔ Admin "${username}" recovered: password reset, sessions revoked, throttle cleared.`);
  console.log("  The reset is recorded in the Proof ledger.");
  await db.$disconnect();
}

// ═══ export-keys (from scripts/export-keys.ts) ════════════════════════════════

function cmdExportKeys(): void {
  const out = arg("out") ?? path.join(process.cwd(), "lester-keys-bundle.txt");
  const passphrase = arg("passphrase");

  const masterPath = masterKeyFilePath();
  if (!existsSync(masterPath)) {
    console.error(`✘ Server key not found at ${masterPath}. Start Lester once first.`);
    process.exit(1);
  }
  const { priv, pub } = proofSigningKeyPath();

  const bundle = JSON.stringify(
    {
      product: "Lester",
      version: "1.0.3",
      exportedAt: new Date().toISOString(),
      note: "Guard this file. It decrypts API keys and (optionally) message content, and verifies/rotates Proof signatures.",
      dataDir: LESTER.dataDir,
      serverSecretHex: readFileSync(masterPath, "utf-8").trim(),
      proofSigningPrivatePem: existsSync(priv) ? readFileSync(priv, "utf-8") : null,
      proofSigningPublicPem: existsSync(pub) ? readFileSync(pub, "utf-8") : null,
    },
    null,
    2
  );

  if (passphrase) {
    const salt = randomBytes(16);
    const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(bundle, "utf-8"), cipher.final()]);
    const payload = Buffer.concat([salt, iv, cipher.getAuthTag(), ct]).toString("base64");
    writeFileSync(out, `LESTER-KEYS-1:${payload}\n`, { mode: 0o600 });
  } else {
    writeFileSync(out, bundle, { mode: 0o600 });
  }
  chmodSync(out, 0o600);
  console.log(`✔ Key bundle written: ${out} (mode 0600)`);
  console.log(passphrase ? "  Encrypted with the passphrase you provided." : "  PLAINTEXT — move it somewhere safe immediately.");
  console.log(`  Restores on other hardware need this bundle + the database backup. See docs/guide.md → Backups.`);
  console.log(`  Paths in use: ${JSON.stringify(dataPaths())}`);
}

// ═══ issue-license (from scripts/issue-license.ts) ════════════════════════════

function cmdIssueLicense(): void {
  function privateKey(): string {
    const envPriv = process.env.LESTER_LICENSE_PRIV;
    if (envPriv) return envPriv;
    const keyPath = arg("key");
    if (keyPath && existsSync(keyPath)) return readFileSync(keyPath, "utf-8");
    console.error("No signing key. Pass --key <path to the vendor private key PEM> (or set LESTER_LICENSE_PRIV).");
    console.error("The vendor private key never ships in the repository or release ZIP.");
    process.exit(1);
  }

  function b64url(buf: Buffer): string {
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  const node = arg("node");
  const customer = arg("customer", "Team");
  const users = parseInt(arg("users", "25")!, 10);
  const expires = arg("expires");
  if (!node) {
    console.error('Usage: bun run license:issue -- --key <private.pem> --node <nodeId> --customer "Acme Corp" [--users 25] [--expires 2027-01-01]');
    console.error("Find the node id in Lester Console → Settings → About.");
    process.exit(1);
  }
  const payload = {
    v: 1,
    tier: "team" as const,
    customer,
    nodes: 1,
    users,
    nodeId: node,
    issuedAt: new Date().toISOString(),
    expiresAt: expires ?? null,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  const sig = edSign(null, body, createPrivateKey(privateKey()));
  const key = `LST1.${b64url(body)}.${b64url(sig)}`;
  console.log("License key (activates offline in Lester Console → Settings → About):");
  console.log("\n" + key + "\n");
  console.log(`Payload: ${JSON.stringify(payload)}`);
}

// ═══ devkey (from scripts/devkey.ts) ══════════════════════════════════════════

function cmdDevKey(): void {
  const envPath = path.join(ROOT, ".env");
  const keyDir = path.join(ROOT, "db", "keys");

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pubHex = publicKey.export({ type: "spki", format: "der" }).toString("hex");
  const privPath = path.join(keyDir, "dev-license-signing.pem");
  writeFileSync(privPath, privPem, { mode: 0o600 });

  let env = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  env = env
    .split("\n")
    .filter((l) => !l.startsWith("LESTER_LICENSE_PUB=") && !l.startsWith("LESTER_LICENSE_PRIV="))
    .join("\n");
  if (!env.endsWith("\n")) env += "\n";
  env += `# dev license key generated by license:devkey (${new Date().toISOString()})\n`;
  env += `LESTER_LICENSE_PUB="${pubHex}"\n`;
  env += `LESTER_LICENSE_PRIV_PATH_NOTE="issue dev keys with: bun run license:issue -- --key ${privPath} --node <nodeId>"\n`;
  writeFileSync(envPath, env);

  console.log("✔ Development license keypair generated.");
  console.log(`  private : ${privPath} (never commit db/ — it is gitignored)`);
  console.log(`  public  : pinned into .env as LESTER_LICENSE_PUB (overrides the vendor key locally)`);
  console.log(`\nIssue a dev team key:`);
  console.log(`  bun run license:issue -- --key ${privPath} --node <nodeId> --customer "Dev"`);
  console.log(`\nRemove the override from .env to verify against the pinned vendor key again.`);
  void appendFileSync;
}

// ═══ licenses (from scripts/licenses.ts) ══════════════════════════════════════

type LicenseRow = { name: string; version: string; license: string; repo: string };

function readPkg(dir: string): LicenseRow | null {
  const p = path.join(dir, "package.json");
  if (!existsSync(p)) return null;
  try {
    const pkg = JSON.parse(readFileSync(p, "utf-8"));
    const license = Array.isArray(pkg.license) ? pkg.license.map(String).join(" OR ") : String(pkg.license ?? "UNKNOWN");
    const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? "";
    return { name: String(pkg.name ?? path.basename(dir)), version: String(pkg.version ?? "?"), license, repo: String(repo).replace(/^git\+/, "") };
  } catch {
    return null;
  }
}

/** Scans <root>/node_modules and returns the THIRD_PARTY_LICENSES.md content. */
export function buildLicenseReport(root: string): { content: string; rows: number; permissive: number; other: number; unknown: number } {
  const NM = path.join(root, "node_modules");
  if (!existsSync(NM)) {
    throw new Error("node_modules not found — run bun install first.");
  }
  const rows: LicenseRow[] = [];
  const scopeDirs = new Set<string>();
  for (const entry of readdirSync(NM, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      scopeDirs.add(entry.name);
      continue;
    }
    const row = readPkg(path.join(NM, entry.name));
    if (row && !row.name.startsWith("lester")) rows.push(row);
  }
  for (const scope of scopeDirs) {
    for (const entry of readdirSync(path.join(NM, scope), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const row = readPkg(path.join(NM, scope, entry.name));
      if (row) rows.push(row);
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  const permissive = rows.filter((r) => /^(MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|Unlicense|CC0-1\.0|Python-2\.0|PostgreSQL|BSD|Zlib|MPL-2\.0|CC-BY-4\.0|BlueOak-1\.0\.0)/i.test(r.license));
  const unknown = rows.filter((r) => r.license === "UNKNOWN");
  const other = rows.filter((r) => !permissive.includes(r) && !unknown.includes(r));

  const lines = [
    "# Third-party licenses",
    "",
    `Generated by \`bun run licenses:report\` on ${new Date().toISOString().slice(0, 10)} · ${rows.length} dependencies.`,
    "",
    "Lester itself is Apache-2.0. Dependency licenses at build time:",
    "",
    `| Category | Count | Notes |`,
    `|---|---|---|`,
    `| Permissive (MIT/ISC/BSD/Apache-2.0/…) | ${permissive.length} | Compatible with Apache-2.0 redistribution. |`,
    `| Copyleft / other | ${other.length} | ${other.map((r) => `${r.name} (${r.license})`).join(", ") || "—"} |`,
    `| Unknown (no license field) | ${unknown.length} | ${unknown.map((r) => r.name).join(", ") || "—"} |`,
    "",
    "> Review the 'other' and 'unknown' rows before commercial redistribution.",
    "Lester's runtime dependency set intentionally contains no GPL/AGPL components.",
    "",
    "| Package | Version | License | Repository |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.name} | ${r.version} | ${r.license} | ${r.repo} |`),
  ];
  return { content: lines.join("\n") + "\n", rows: rows.length, permissive: permissive.length, other: other.length, unknown: unknown.length };
}

function cmdLicenses(): void {
  const report = buildLicenseReport(ROOT);
  writeFileSync(path.join(ROOT, "THIRD_PARTY_LICENSES.md"), report.content);
  console.log(`✔ THIRD_PARTY_LICENSES.md written (${report.rows} dependencies: ${report.permissive} permissive, ${report.other} other, ${report.unknown} unknown).`);
  if (report.other) console.log("  Review: " + report.rows + " deps — see the 'other' rows in the file.");
}

// ═══ rotate-proof-key (from scripts/rotate-proof-key.ts) ══════════════════════

async function cmdRotateProofKey(): Promise<void> {
  await initDurability();
  const { oldPublicPem, newPublicPem } = rotateProofSigningKey();
  await appendProof({
    username: "system",
    action: "proof.key_rotation",
    status: "ok",
    detail: { oldKeyId: oldPublicPem.slice(0, 24) + "…", note: "old key archived under DATA/keys/retired/" },
  });
  const cp = await createCheckpoint();
  console.log("✔ Proof signing key rotated.");
  console.log(`  old key archived in DATA/keys/retired/ (keep it: existing exports verify with it)`);
  console.log(`  new checkpoint signed: seq ${cp.seq}, keyId ${cp.keyId}`);
  void newPublicPem;
  await db.$disconnect();
}

// ═══ migrate (from scripts/migrate.ts) ════════════════════════════════════════

async function cmdMigrate(): Promise<void> {
  const result = await runMigrations();
  console.log(`fresh install      : ${result.freshInstall}`);
  if (result.baselineApplied) console.log("v1.0.0 baseline    : marked 0_init as applied");
  if (result.preUpgradeBackup) {
    console.log(`pre-upgrade backup : ${result.preUpgradeBackup.path}`);
    console.log(`  sha256           : ${result.preUpgradeBackup.sha256}`);
  }
  for (const m of result.appliedMigrations) console.log(`applied            : ${m}`);
  console.log(`integrity check    : ${result.integrityCheck}`);
  if (result.error) {
    console.error(`ERROR              : ${result.error}`);
    process.exit(1);
  }

  // Data migrations (tokens) + proof chain upgrade — same guarantees as boot.
  await initDurability();
  const chain = await verifyChain();
  console.log(`proof chain        : ${chain.valid ? `valid (${chain.checked} entries)` : `BROKEN at seq ${chain.firstBrokenSeq} — ${chain.brokenReason}`}`);
  if (chain.valid && chain.legacyEntries > 0) {
    const res = await rehashLegacyChain();
    if (res.refused) {
      console.error(`proof rehash       : REFUSED — ${res.refused}`);
      process.exit(1);
    }
    console.log(`proof rehash       : ${res.upgraded} legacy entries upgraded to hash v2 (seq+ts now covered)`);
  }
  await db.$disconnect();
}

// ═══ icons (from scripts/gen-icons.ts, trimmed to the shipped set) ════════════

async function cmdIcons(): Promise<void> {
  const sharp = (await import("sharp")).default;
  const BRAND = path.join(ROOT, "brand");
  const PUBLIC = path.join(ROOT, "public");
  mkdirSync(path.join(PUBLIC, "icons"), { recursive: true });

  const markSvg = readFileSync(path.join(BRAND, "mark.svg"), "utf-8");

  /** Full-bleed tile: deep green background, white L, green node — for apple/maskable. */
  function tileSvg(bg: string, fg: string, scale = 1): string {
    const s = 64 * scale;
    const off = (512 - s) / 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${bg}"/>
  <g transform="translate(${off},${off}) scale(${scale})">
    <rect x="6" y="6" width="52" height="52" rx="13" fill="${fg}"/>
    <path d="M22 19 H33 V34 H48 V45 H22 Z" fill="${bg}"/>
    <rect x="36" y="21.5" width="9" height="9" rx="2.2" fill="${fg}"/>
  </g>
</svg>`;
  }

  async function png(svg: string, size: number, out: string) {
    const buf = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
    writeFileSync(out, buf);
    console.log(`✓ ${out} (${buf.length} bytes)`);
  }

  // Favicon (transparent background mark)
  await png(markSvg, 32, path.join(PUBLIC, "favicon-32.png"));
  // PWA icons (transparent, mark fills ~76% for safe display)
  const pwa = markSvg.replace('viewBox="0 0 64 64"', 'viewBox="-7 -7 78 78"');
  await png(pwa, 192, path.join(PUBLIC, "icons", "icon-192.png"));
  await png(pwa, 512, path.join(PUBLIC, "icons", "icon-512.png"));
  // Maskable: full-bleed green tile, mark in the 80% safe zone
  const maskable = tileSvg("#0E6B57", "#FFFFFF", 5.2); // 64*5.2 = 333px in 512 → 65%
  await png(maskable, 512, path.join(PUBLIC, "icons", "icon-maskable-512.png"));
  // Apple touch icon: full-bleed green tile (iOS rounds corners itself)
  await png(tileSvg("#0E6B57", "#FFFFFF", 5.6), 180, path.join(PUBLIC, "apple-touch-icon.png"));
  console.log("Brand raster set complete.");
}

// ═══ test (from scripts/run-tests.ts) ═════════════════════════════════════════

function cmdTest(): void {
  const dir = path.join(ROOT, "tests");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".test.ts"))
    .sort()
    .map((f) => path.join(dir, f));

  if (files.length === 0) {
    console.error("no test files found");
    process.exit(1);
  }

  let failed = 0;
  const results: { file: string; pass: number; fail: number; ms: number }[] = [];
  for (const f of files) {
    const t0 = Date.now();
    const res = spawnSync("bun", ["test", f], { stdio: ["ignore", "pipe", "pipe"], env: process.env, timeout: 300_000 });
    const out = (res.stdout ?? "").toString() + (res.stderr ?? "").toString();
    const pass = Number(/(\d+) pass/.exec(out)?.[1] ?? 0);
    const fail = Number(/(\d+) fail/.exec(out)?.[1] ?? 0);
    results.push({ file: path.basename(f), pass, fail, ms: Date.now() - t0 });
    if (res.status !== 0) {
      failed++;
      console.log(`✘ ${path.basename(f)}`);
      console.log(out.split("\n").filter((l) => l.trim()).slice(-30).join("\n"));
    } else {
      console.log(`✔ ${path.basename(f)} (${pass} pass, ${fail} fail, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
  }

  console.log("\n─── summary ───");
  for (const r of results) console.log(`${r.fail > 0 ? "✘" : "✔"} ${r.file}: ${r.pass} pass, ${r.fail} fail (${(r.ms / 1000).toFixed(1)}s)`);
  const totalPass = results.reduce((a, r) => a + r.pass, 0);
  const totalFail = results.reduce((a, r) => a + r.fail, 0);
  console.log(`\n${failed === 0 ? "ALL TESTS PASS" : `${failed} FILE(S) FAILED`}: ${totalPass} pass, ${totalFail} fail across ${results.length} files`);
  process.exit(failed === 0 ? 0 : 1);
}

// ═══ vendor-offline (from scripts/vendor-offline.sh) ══════════════════════════

function cmdVendorOffline(): void {
  const stamp = new Date().toISOString().replace(/[:T]/g, "").slice(0, 15).replace(/-/g, "");
  const out = `lester-offline-bundle-${stamp}.tar.gz`;

  if (!existsSync(path.join(ROOT, "node_modules"))) {
    console.log("· Installing dependencies first (needs network)…");
    const r = spawnSync("bun", ["install", "--frozen-lockfile"], { cwd: ROOT, stdio: "inherit" });
    if (r.status !== 0) process.exit(1);
  }
  // Make sure Prisma engines are present locally (they are, inside node_modules,
  // after any prisma generate — run generate to be certain):
  try {
    execFileSync("bunx", ["prisma", "generate"], { cwd: ROOT, stdio: "ignore", env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1" }, timeout: 120_000 });
  } catch {
    // non-fatal: engines are usually already present
  }

  console.log(`· Packing ${out} (node_modules + source; no db/, no logs, no .env)…`);
  const res = spawnSync(
    "tar",
    [
      "--exclude=./node_modules/.cache",
      "--exclude=./db", "--exclude=./*.log", "--exclude=./.env",
      "--exclude=./.next", "--exclude=./staging", "--exclude=./.git",
      `--exclude=./lester-offline-bundle-*.tar.gz`,
      "-czf", out, "node_modules", ".",
    ],
    { cwd: ROOT, stdio: "inherit" }
  );
  if (res.status !== 0) {
    console.error("✘ tar failed.");
    process.exit(1);
  }
  console.log(`✔ ${out} created.`);
  console.log("  Move it via removable media, verify its sha256 on both sides, then on the");
  console.log("  air-gapped host: tar xzf " + out + " && bun run start:prod");
}

// ═══ dispatch ═════════════════════════════════════════════════════════════════

const COMMANDS: Record<string, () => unknown> = {
  backup: cmdBackup,
  restore: cmdRestore,
  "verify-proof": cmdVerifyProof,
  "admin-recover": cmdAdminRecover,
  "export-keys": cmdExportKeys,
  "issue-license": cmdIssueLicense,
  devkey: cmdDevKey,
  licenses: cmdLicenses,
  "rotate-proof-key": cmdRotateProofKey,
  migrate: cmdMigrate,
  icons: cmdIcons,
  test: cmdTest,
  "vendor-offline": cmdVendorOffline,
};

function usage(): never {
  console.error("Usage: bun scripts/cli.ts <command> [args…]");
  console.error("Commands: " + Object.keys(COMMANDS).join(", "));
  process.exit(1);
}

if (import.meta.main) {
  const fn = COMMANDS[COMMAND ?? ""];
  if (!fn) usage();
  try {
    const r = fn();
    if (r instanceof Promise) {
      r.catch((e) => {
        console.error(e);
        process.exit(1);
      });
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
