/**
 * Database plumbing: the Prisma singleton with durability PRAGMAs, plus file-level SQLite operations (online backup, integrity checks).
 *
 * Merged module (v1.0.2 repository consolidation — zero behavior change).
 * Sections:
 *   1. Prisma client + durability
 *   2. File-level SQLite operations
 */

import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";


// ═══ Prisma client + durability ══════════════════════════════════════════════════
// merged from src/lib/db.ts

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  dbReady: Promise<void> | undefined;
};

/**
 * Single connection (connection_limit=1 in DATABASE_URL) — SQLite writes are
 * serialized anyway, and it lets our durability PRAGMAs apply to every query.
 */
export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

/**
 * Durability: WAL journal (crash-safe, survives process kill), FULL sync
 * (committed transactions survive power loss), foreign keys on.
 * Idempotent — runs once per process.
 */
export function initDurability(): Promise<void> {
  if (!globalForPrisma.dbReady) {
    globalForPrisma.dbReady = (async () => {
      await db.$queryRawUnsafe("PRAGMA journal_mode=WAL");
      await db.$executeRawUnsafe("PRAGMA synchronous=FULL");
      await db.$executeRawUnsafe("PRAGMA foreign_keys=ON");
    })().catch((e) => {
      // allow a later request to retry (e.g. transient lock during hot reload)
      globalForPrisma.dbReady = undefined;
      throw e;
    });
  }
  return globalForPrisma.dbReady;
}

/** Fold the WAL back into the main db file (used before backups). */
export async function checkpointWal(): Promise<void> {
  await db.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)");
}

// ═══ File-level SQLite operations ════════════════════════════════════════════════
// merged from src/lib/sqlite-file.ts

function clientFor(url: string): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url } },
    log: ["error"],
  });
}

export function fileUrl(p: string): string {
  return `file:${p}?connection_limit=1`;
}

/** SQLite online backup: transactionally consistent snapshot, safe while the
 *  server keeps writing (not a file copy). */
export async function vacuumIntoFile(sourceDbPath: string, targetPath: string): Promise<void> {
  const c = clientFor(fileUrl(sourceDbPath));
  try {
    await c.$executeRawUnsafe("VACUUM INTO ?", targetPath);
  } finally {
    await c.$disconnect().catch(() => undefined);
  }
}

/** PRAGMA integrity_check against a specific database file. */
export async function integrityCheckFile(p: string): Promise<"ok" | string> {
  const c = clientFor(fileUrl(p));
  try {
    const rows = await c.$queryRawUnsafe<Array<{ integrity_check: string }>>("PRAGMA integrity_check");
    return rows[0]?.integrity_check ?? "no-result";
  } catch (e) {
    return e instanceof Error ? `error: ${e.message}` : "error";
  } finally {
    await c.$disconnect().catch(() => undefined);
  }
}

/** Quick check (cheaper than integrity_check) — used before migrations. */
export async function quickCheckFile(p: string): Promise<boolean> {
  const c = clientFor(fileUrl(p));
  try {
    const rows = await c.$queryRawUnsafe<Array<{ quick_check: string }>>("PRAGMA quick_check");
    return rows[0]?.quick_check === "ok";
  } catch {
    return false;
  } finally {
    await c.$disconnect().catch(() => undefined);
  }
}

/** Table names in a database file (empty list if unreadable). */
export async function tablesInFile(p: string): Promise<Set<string>> {
  const c = clientFor(fileUrl(p));
  try {
    const rows = await c.$queryRawUnsafe<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type='table'"
    );
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set();
  } finally {
    await c.$disconnect().catch(() => undefined);
  }
}

export function sha256File(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}
