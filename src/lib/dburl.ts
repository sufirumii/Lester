/**
 * Database location defaults (v1.0.5).
 *
 * Lester documents `DATABASE_URL` as defaulting to `<project>/db/lester.db`, but
 * Prisma itself has no default: with no `.env` file the CLI stops with
 * "Environment variable not found: DATABASE_URL" (P1012). This module supplies
 * the documented default, and normalises the URL to an ABSOLUTE path so that
 * every process — the migrate CLI, `bun run start:prod`, the standalone server
 * (whose cwd is `.next/standalone`), backups and restores — agrees on the same
 * file. (A relative `file:./db/...` URL is resolved by Prisma against the
 * `prisma/` directory, but by Lester's own helpers against the cwd — two
 * different places.)
 *
 * Rules — values the operator sets are never overridden:
 *   - DATABASE_URL unset      → file:<DATA_DIR>/lester.db?connection_limit=1
 *   - DATABASE_URL relative   → resolved against the project root
 *   - DATABASE_URL absolute   → untouched
 *   - LESTER_DATA_DIR unset   → <project root>/db
 * Docker sets both explicitly, so nothing changes there.
 */
import { existsSync } from "node:fs";
import path from "node:path";

/** Walk up from `start` to the directory that contains prisma/migrations. */
export function findProjectRoot(start: string = process.cwd()): string | null {
  const explicit = (process.env.LESTER_PROJECT_ROOT ?? "").trim();
  if (explicit && existsSync(path.join(explicit, "prisma", "migrations"))) return explicit;
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "prisma", "migrations"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Prisma accepts forward slashes on every OS, and they survive URL parsing. */
function toUrlPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Absolute `file:` URLs: `file:/x`, `file:C:/x`, `file:C:\x`. */
function isAbsoluteFilePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

export function applyDatabaseDefaults(root?: string): void {
  const base = root ?? findProjectRoot() ?? process.cwd();

  if (!(process.env.LESTER_DATA_DIR ?? "").trim()) {
    process.env.LESTER_DATA_DIR = path.join(base, "db");
  }
  const dataDir = path.resolve(process.env.LESTER_DATA_DIR as string);

  const raw = (process.env.DATABASE_URL ?? "").trim();
  if (!raw) {
    process.env.DATABASE_URL = `file:${toUrlPath(path.join(dataDir, "lester.db"))}?connection_limit=1`;
    return;
  }
  const m = raw.match(/^file:(.*?)(\?.*)?$/);
  if (m && m[1] && !isAbsoluteFilePath(m[1])) {
    process.env.DATABASE_URL = `file:${toUrlPath(path.resolve(base, m[1]))}${m[2] ?? "?connection_limit=1"}`;
  }
}
