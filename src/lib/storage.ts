/**
 * Durability & lifecycle: always-on backups (VACUUM INTO + integrity + chain checks), the safe migration runner, and the boot sequence.
 *
 * Merged module (v1.0.2 repository consolidation — zero behavior change).
 * Sections:
 *   1. Backups & scheduler
 *   2. Migration runner
 *   3. Boot sequence
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { default as path } from "node:path";
import { db, initDurability } from "@/lib/db";
import { LESTER } from "@/lib/env";
import { getSettings } from "./env";
import { appendProof, ChainVerification, createCheckpoint, rehashLegacyChain, verifyChain } from "@/lib/proof";
import { integrityCheckFile, quickCheckFile, sha256File, tablesInFile, vacuumIntoFile } from "./db";
import { execFileSync } from "node:child_process";
import { hashApiToken, proofSigningKey } from "./auth";
import { licensePublicKeyHex } from "@/lib/license";
import { randomBytes } from "node:crypto";
// Shared module-level handles on globalThis (backups scheduler + boot state).
const g = globalThis as unknown as {
  lesterBooted?: Promise<BootInfo>;
  lesterChainCheck?: ChainVerification;
  lesterBackupTimer?: NodeJS.Timeout;
  lesterCheckpointTimer?: NodeJS.Timeout;
  lesterLastAuto?: string;
};


// ═══ Backups & scheduler ═════════════════════════════════════════════════════════
// merged from src/lib/backups.ts

export interface BackupMeta {
  id: string;
  path: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  kind: "manual" | "auto" | "pre-restore" | "pre-upgrade";
  entries: number;
  createdAt: string;
}

let backupCounter = 0;
function uniqueBackupName(prefix: string): string {
  // millisecond stamp + counter: VACUUM INTO refuses to overwrite existing files
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
  return `${prefix}-${stamp}-${(backupCounter++).toString(36)}.db`;
}

export function dbFilePath(): string {
  const url = process.env.DATABASE_URL ?? "";
  const m = url.match(/^file:(.*?)(\?.*)?$/);
  return m?.[1] ?? path.join(LESTER.dataDir, "lester.db");
}

async function snapshotIntegrityOk(p: string): Promise<boolean> {
  return (await integrityCheckFile(p)) === "ok";
}

export interface CreateBackupResult extends BackupMeta {
  integrityCheck: "ok" | "failed";
  chainValid: boolean;
}

export async function createBackup(
  kind: "manual" | "auto" | "pre-restore" | "pre-upgrade",
  actor?: { id: string; username: string }
): Promise<CreateBackupResult> {
  mkdirSync(LESTER.backupsDir, { recursive: true });
  const fileName = uniqueBackupName("lester-backup");
  const finalPath = path.join(LESTER.backupsDir, fileName);

  // 1 — verify the live Proof chain first (every backup records the result)
  const chain = await verifyChain();

  // 2 — consistent snapshot via SQLite online backup (not a file copy)
  await vacuumIntoFile(dbFilePath(), finalPath);

  // 3 — integrity-check the snapshot itself
  const integrityCheck = (await snapshotIntegrityOk(finalPath)) ? "ok" : "failed";
  const hash = sha256File(finalPath);
  const entries = await db.proofEntry.count();
  const size = statSync(finalPath).size;
  const row = await db.backup.create({
    data: { path: finalPath, sizeBytes: size, sha256: hash, kind, entries },
  });
  if (actor) {
    await appendProof({
      userId: actor.id,
      username: actor.username,
      action: "backup.create",
      status: integrityCheck === "ok" && chain.valid ? "ok" : "error",
      detail: { fileName, sizeBytes: size, kind, entries, integrityCheck, chainValid: chain.valid, dir: LESTER.backupsDir },
    });
  }
  await pruneOldBackups();
  return {
    id: row.id,
    path: finalPath,
    fileName,
    sizeBytes: size,
    sha256: hash,
    kind,
    entries,
    createdAt: row.createdAt.toISOString(),
    integrityCheck,
    chainValid: chain.valid,
  };
}

async function pruneOldBackups(): Promise<void> {
  const { backup } = await getSettings();
  const rows = await db.backup.findMany({ orderBy: { createdAt: "desc" } });
  const excess = rows.slice(backup.keep);
  for (const b of excess) {
    if (existsSync(b.path)) unlinkSync(b.path);
    await db.backup.delete({ where: { id: b.id } });
  }
}

export async function listBackups(): Promise<Array<BackupMeta & { integrityCheck?: "ok" | "failed" }>> {
  const rows = await db.backup.findMany({ orderBy: { createdAt: "desc" } });
  return rows.map((b) => ({
    id: b.id,
    path: b.path,
    fileName: path.basename(b.path),
    sizeBytes: b.sizeBytes,
    sha256: b.sha256,
    kind: b.kind as BackupMeta["kind"],
    entries: b.entries,
    createdAt: b.createdAt.toISOString(),
  }));
}

/** D2: warn when the only backups live on the same filesystem as the database. */
export function backupsOnSameVolume(): boolean {
  try {
    const dbDev = statSync(/*turbopackIgnore: true*/ dbFilePath()).dev;
    const bakDev = statSync(/*turbopackIgnore: true*/ LESTER.backupsDir).dev;
    return dbDev === bakDev;
  } catch {
    return false;
  }
}

export async function restoreBackup(id: string, actor: { id: string; username: string }): Promise<{ ok: true; entries: number; chainValid: boolean }> {
  const meta = await db.backup.findUnique({ where: { id } });
  if (!meta || !existsSync(meta.path)) throw new Error("Backup not found on disk.");
  const currentHash = sha256File(meta.path);
  if (currentHash !== meta.sha256) {
    throw new Error(`Backup integrity check failed: sha256 changed on disk. Expected ${meta.sha256.slice(0, 12)}…, found ${currentHash.slice(0, 12)}…. Refusing to restore.`);
  }
  if (!(await snapshotIntegrityOk(meta.path))) {
    throw new Error("Backup failed PRAGMA integrity_check — the file is corrupt. Refusing to restore.");
  }

  const target = dbFilePath();

  // D3 — pre-restore safety snapshot of the CURRENT database
  try {
    await createBackup("pre-restore", actor);
  } catch (e) {
    throw new Error(`Pre-restore snapshot failed — restore aborted. (${e instanceof Error ? e.message : String(e)})`);
  }

  await db.$disconnect();
  try {
    for (const ext of ["-wal", "-shm"]) {
      const side = target + ext;
      if (existsSync(side)) unlinkSync(side);
    }
    const tmp = target + ".restore.tmp";
    await vacuumIntoFile(meta.path, tmp);
    renameSync(tmp, target);
  } finally {
    await db.$connect();
    await initDurability().catch(() => undefined);
  }
  const chain = await verifyChain();
  await appendProof({
    userId: actor.id,
    username: actor.username,
    action: "backup.restore",
    status: chain.valid ? "ok" : "error",
    detail: { fileName: path.basename(meta.path), chainValid: chain.valid },
  });
  return { ok: true, entries: chain.checked, chainValid: chain.valid };
}

// ─── Scheduler (auto backups + periodic Proof checkpoints) ───────────────────


export function startBackupScheduler(): void {
  if (g.lesterBackupTimer) return;
  g.lesterBackupTimer = setInterval(
    () => {
      void (async () => {
        try {
          const { backup } = await getSettings();
          if (!backup.enabled) return;
          const now = new Date();
          const today = now.toISOString().slice(0, 10);
          if (g.lesterLastAuto === today) return;
          if (now.getHours() < backup.hour) return;
          g.lesterLastAuto = today;
          await createBackup("auto");
        } catch (e) {
          console.error("[lester] auto-backup failed:", e);
        }
      })();
    },
    5 * 60_000
  );
  g.lesterBackupTimer.unref?.();

  // Signed checkpoints: every 6h, and on every boot (bootstrap.ts).
  if (g.lesterCheckpointTimer) return;
  g.lesterCheckpointTimer = setInterval(
    () => {
      void createCheckpoint().catch((e) => console.error("[lester] checkpoint failed:", e));
    },
    6 * 3600_000
  );
  g.lesterCheckpointTimer.unref?.();
}

export function backupStatus() {
  return {
    schedulerRunning: Boolean(g.lesterBackupTimer),
    lastAuto: g.lesterLastAuto ?? null,
    dir: LESTER.backupsDir,
    sameVolumeAsDb: backupsOnSameVolume(),
  };
}

export function dbPath(): string {
  return dbFilePath();
}

// ═══ Migration runner ════════════════════════════════════════════════════════════
// merged from src/lib/migrate.ts


export interface MigrationResult {
  freshInstall: boolean;
  baselineApplied: boolean;
  appliedMigrations: string[];
  preUpgradeBackup?: { path: string; sha256: string; sizeBytes: number };
  integrityCheck: "ok" | "failed";
  error?: string;
}

/**
 * Project root = the directory containing prisma/migrations. The standalone
 * server runs with cwd = .next/standalone, so we walk upward (Docker layout:
 * /app/.next/standalone → /app). LESTER_PROJECT_ROOT overrides for exotic setups.
 */
export function projectRoot(): string | null {
  const explicit = (process.env.LESTER_PROJECT_ROOT ?? "").trim();
  if (explicit && existsSync(path.join(explicit, "prisma", "migrations"))) return explicit;
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(dir, "prisma", "migrations"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function runPrisma(args: string[]): string {
  const bunx = process.execPath.includes("bun") ? process.execPath : "bun";
  // Use the local prisma CLI (resolved from node_modules upward from cwd);
  // engines are already installed — never downloaded at runtime.
  return execFileSync(bunx, ["x", "prisma", ...args], {
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    encoding: "utf-8",
    timeout: 120_000,
  });
}

function migrationDirs(): string[] {
  const root = projectRoot();
  if (!root) return [];
  const migrationsDir = path.join(root, "prisma", "migrations");
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

async function appliedMigrationsIn(dbPath: string): Promise<Set<string>> {
  const { PrismaClient } = await import("@prisma/client");
  const c = new PrismaClient({ datasources: { db: { url: `file:${dbPath}?connection_limit=1` } }, log: ["error"] });
  try {
    const rows = await c.$queryRawUnsafe<Array<{ migration_name: string }>>(
      "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL"
    );
    return new Set(rows.map((r) => r.migration_name));
  } catch {
    return new Set();
  } finally {
    await c.$disconnect().catch(() => undefined);
  }
}

export async function runMigrations(): Promise<MigrationResult> {
  const dbPath = dbFilePath();
  const freshInstall = !existsSync(/*turbopackIgnore: true*/ dbPath) || statSync(/*turbopackIgnore: true*/ dbPath).size === 0;
  const result: MigrationResult = { freshInstall, baselineApplied: false, appliedMigrations: [], integrityCheck: "ok" };

  // No project root reachable (bare standalone without source): verify-only.
  // The operator should start via `bun run start:prod` or Docker (which run
  // migrations from the full project) — here we only check health, never
  // touch the schema blind.
  if (!projectRoot()) {
    if (!freshInstall) {
      result.integrityCheck = (await quickCheckFile(dbPath)) ? "ok" : "failed";
      if (result.integrityCheck !== "ok") {
        result.error = "Database failed quick_check and migrations cannot run from this context (no prisma/ directory). Start via `bun run start:prod` or Docker.";
      }
    }
    return result;
  }

  if (!freshInstall) {
    if (!(await quickCheckFile(dbPath))) {
      result.integrityCheck = "failed";
      result.error = `Database at ${dbPath} failed PRAGMA quick_check. Refusing to migrate a corrupt file — restore a backup first.`;
      return result;
    }
    const tables = await tablesInFile(dbPath);
    const hasLesterTables = tables.has("User") && tables.has("ProofEntry");
    const hasMigrationTable = tables.has("_prisma_migrations");

    if (hasLesterTables && !hasMigrationTable) {
      // v1.0.0 database (created via `db push`): baseline it, then upgrade.
      result.baselineApplied = true;
      const backup = await takePreMigrationBackup(dbPath, "pre-upgrade");
      if (backup) result.preUpgradeBackup = backup;
      runPrisma(["migrate", "resolve", "--applied", "0_init"]);
    } else if (hasMigrationTable) {
      // Existing migrations — check whether anything is pending.
      const applied = await appliedMigrationsIn(dbPath);
      const pending = migrationDirs().filter((d) => !applied.has(d));
      if (pending.length > 0) {
        const backup = await takePreMigrationBackup(dbPath, "pre-upgrade");
        if (backup) result.preUpgradeBackup = backup;
      }
    }
  }

  mkdirSync(path.dirname(dbPath), { recursive: true });
  const out = runPrisma(["migrate", "deploy"]);
  result.appliedMigrations = [...out.matchAll(/Applying migration `([^`]+)`/g)].map((m) => m[1]);
  result.integrityCheck = (await quickCheckFile(dbPath)) ? "ok" : "failed";
  return result;
}

async function takePreMigrationBackup(dbPath: string, kind: string): Promise<{ path: string; sha256: string; sizeBytes: number } | undefined> {
  try {
    mkdirSync(LESTER.backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const target = path.join(LESTER.backupsDir, `lester-${kind}-${stamp}.db`);
    await vacuumIntoFile(dbPath, target);
    return { path: target, sha256: sha256File(target), sizeBytes: statSync(target).size };
  } catch (e) {
    // A failed snapshot must BLOCK the migration, not be swallowed.
    throw new Error(`Pre-migration backup failed — migration aborted. (${e instanceof Error ? e.message : String(e)})`);
  }
}

// ═══ Boot sequence ═══════════════════════════════════════════════════════════════
// merged from src/lib/bootstrap.ts


export interface BootInfo {
  startedAt: string;
  version: string;
  durability: { journal: string; synchronous: string };
  chain: ChainVerification;
  migrations: MigrationResult;
  engineHint: string;
  legacyTokensMigrated: number;
}

async function migrateLegacyApiTokens(): Promise<number> {
  // v1.0.0 stored User.apiToken in plaintext; the 1.0.1 migration parked those
  // values in ApiTokenLegacy. Hash them once, then drop the staging table.
  const tables = await db.$queryRawUnsafe<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='ApiTokenLegacy'"
  );
  if (tables.length === 0) return 0;
  const rows = await db.$queryRawUnsafe<{ userId: string; token: string; createdAt: Date }[]>(
    "SELECT userId, token, createdAt FROM ApiTokenLegacy WHERE token IS NOT NULL AND token != ''"
  );
  let migrated = 0;
  for (const row of rows) {
    const tokenHash = hashApiToken(row.token);
    const prefix = `${row.token.slice(0, 9)}…`;
    const exists = await db.apiToken.findUnique({ where: { tokenHash } });
    if (!exists) {
      await db.apiToken.create({
        data: {
          userId: row.userId,
          name: "migrated (v1.0.0)",
          tokenHash,
          prefix,
          createdAt: row.createdAt,
        },
      });
      migrated++;
    }
  }
  await db.$executeRawUnsafe("DROP TABLE IF EXISTS ApiTokenLegacy");
  return migrated;
}

async function boot(): Promise<BootInfo> {
  // 1 — schema first (fresh install or safe upgrade; never destructive)
  const migrations = await runMigrations();
  if (migrations.error) throw new Error(`[lester] migration failure: ${migrations.error}`);
  if (migrations.integrityCheck !== "ok") throw new Error("[lester] database failed integrity check after migration — restore a backup.");

  await initDurability();
  mkdirSync(LESTER.keysDir, { recursive: true });
  mkdirSync(LESTER.backupsDir, { recursive: true });
  proofSigningKey(); // generate on first boot if absent
  licensePublicKeyHex(); // pinned vendor key (or explicit override)

  // 2 — one-time data migrations
  const legacyTokensMigrated = await migrateLegacyApiTokens();
  if (legacyTokensMigrated > 0) {
    console.log(`[lester] migrated ${legacyTokensMigrated} legacy API token(s) to hashed storage.`);
  }

  // 3 — upgrade legacy v1 proof chain to the v2 hash form (seq+ts covered)
  const preCheck = await verifyChain();
  if (preCheck.valid && preCheck.legacyEntries > 0) {
    const res = await rehashLegacyChain();
    if (res.refused) console.error(`[lester] proof rehash refused: ${res.refused}`);
    else console.log(`[lester] upgraded ${res.upgraded} legacy ledger entries to hash v2.`);
  }

  startBackupScheduler();

  // 4 — signed checkpoint of the chain head on every boot (P2)
  await createCheckpoint().catch((e) => console.error("[lester] boot checkpoint failed:", e));

  // Crash-recovery check: verify the ledger chain on every start.
  const chain = await verifyChain();
  g.lesterChainCheck = chain;
  if (!chain.valid) {
    console.error(`[lester] PROOF CHAIN INVALID at seq ${chain.firstBrokenSeq}: ${chain.brokenReason}`);
  }
  const journal = await db.$queryRawUnsafe<{ journal_mode: string }[]>("PRAGMA journal_mode");
  const sync = await db.$queryRawUnsafe<{ synchronous: number }[]>("PRAGMA synchronous");
  return {
    startedAt: new Date().toISOString(),
    version: LESTER.version,
    durability: { journal: journal[0]?.journal_mode ?? "unknown", synchronous: String(sync[0]?.synchronous ?? "?") },
    chain,
    migrations,
    engineHint: LESTER.engineHint.kind,
    legacyTokensMigrated,
  };
}

export function ensureBooted(): Promise<BootInfo> {
  if (!g.lesterBooted) {
    g.lesterBooted = boot().catch((e) => {
      console.error("[lester] boot failed:", e);
      g.lesterBooted = undefined;
      throw e;
    });
  }
  return g.lesterBooted;
}

export function cachedChain(): ChainVerification | null {
  return g.lesterChainCheck ?? null;
}

export function schedulerInfo() {
  return backupStatus();
}

/** Random salt used only to invalidate caches in tests. */
export function bootNonce(): string {
  return randomBytes(4).toString("hex");
}
