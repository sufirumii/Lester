/**
 * Identity & cryptography: sessions, API tokens, login throttling, password policy, hashing, AES-256-GCM, Ed25519 Proof keys, node fingerprint.
 *
 * Merged module (v1.0.2 repository consolidation — zero behavior change).
 * Sections:
 *   1. Crypto primitives
 *   2. Auth, sessions, tokens, throttling
 */

import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, scryptSync, sign as edSign, timingSafeEqual, verify as edVerify } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { default as path } from "node:path";
import { default as os } from "node:os";
import { getSettings, LESTER } from "./env";
import { cookies } from "next/headers";
import { db } from "./db";
import { ApiFail } from "./http";


// ═══ Crypto primitives ═══════════════════════════════════════════════════════════
// merged from src/lib/crypto.ts

export function sha256hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// ─── Passwords (scrypt) ───────────────────────────────────────────────────────

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [saltHex, hashHex] = stored.split("$");
    const hash = scryptSync(password, Buffer.from(saltHex, "hex"), 64, { N: 16384, r: 8, p: 1 });
    return timingSafeEqual(hash, Buffer.from(hashHex, "hex"));
  } catch {
    return false;
  }
}

// ─── Server secret (key material on disk, 0600, never leaves the host) ───────
//
// LESTER_MASTER_KEY_FILE lets the operator keep the key on a different volume
// (e.g. a removable device or a separately-backed-up path). See SECURITY.md for
// what this does and does not protect against.

let serverSecretCache: Buffer | null = null;

export function masterKeyFilePath(): string {
  return (process.env.LESTER_MASTER_KEY_FILE ?? "").trim() || path.join(LESTER.keysDir, "server.key");
}

export function serverSecret(): Buffer {
  if (serverSecretCache) return serverSecretCache;
  const p = masterKeyFilePath();
  if (existsSync(/*turbopackIgnore: true*/ p)) {
    serverSecretCache = Buffer.from(readFileSync(/*turbopackIgnore: true*/ p, "utf-8").trim(), "hex");
  } else {
    mkdirSync(/*turbopackIgnore: true*/ path.dirname(p), { recursive: true });
    const secret = randomBytes(32);
    writeFileSync(p, secret.toString("hex"), { mode: 0o600 });
    chmodSync(p, 0o600);
    serverSecretCache = secret;
  }
  return serverSecretCache;
}

// ─── AES-256-GCM (API keys + optional message encryption at rest) ─────────────

export function aesEncrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", serverSecret(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${ct.toString("base64")}`;
}

export function aesDecrypt(payload: string): string {
  const [ivB64, tagB64, ctB64] = payload.split(".");
  const decipher = createDecipheriv("aes-256-gcm", serverSecret(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf-8");
}

// ─── Ed25519 keypair for Proof report signing / checkpoints ───────────────────
//
// This is the NODE's own signing identity (auto-generated per install is
// correct here: it lets an auditor verify exports came from this node).
// LESTER_PROOF_SIGNING_KEY_FILE points at an operator-managed key; rotation is
// supported via rotateProofSigningKey() — see scripts/rotate-proof-key.ts.

type EdPair = { privatePem: string; publicPem: string; publicHex: string; keyId: string };
let edCache: EdPair | null = null;

export function proofSigningKeyPath(): { priv: string; pub: string } {
  const custom = (process.env.LESTER_PROOF_SIGNING_KEY_FILE ?? "").trim();
  if (custom) return { priv: custom, pub: `${custom}.pub.pem` };
  return { priv: path.join(LESTER.keysDir, "proof-signing.pem"), pub: path.join(LESTER.keysDir, "proof-signing.pub.pem") };
}

export function proofSigningKey(): EdPair {
  if (edCache) return edCache;
  const { priv, pub } = proofSigningKeyPath();
  mkdirSync(path.dirname(priv), { recursive: true });
  if (existsSync(/*turbopackIgnore: true*/ priv)) {
    const privatePem = readFileSync(/*turbopackIgnore: true*/ priv, "utf-8");
    const publicPem = existsSync(/*turbopackIgnore: true*/ pub) ? readFileSync(/*turbopackIgnore: true*/ pub, "utf-8") : createPrivateKey(privatePem).export({ type: "spki", format: "pem" }).toString();
    edCache = {
      privatePem,
      publicPem,
      publicHex: createPublicKey(publicPem).export({ type: "spki", format: "der" }).toString("hex"),
      keyId: sha256hex(publicPem).slice(0, 16),
    };
    return edCache;
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  writeFileSync(priv, privatePem, { mode: 0o600 });
  chmodSync(priv, 0o600);
  writeFileSync(pub, publicPem, { mode: 0o644 });
  edCache = {
    privatePem,
    publicPem,
    publicHex: publicKey.export({ type: "spki", format: "der" }).toString("hex"),
    keyId: sha256hex(publicPem).slice(0, 16),
  };
  return edCache;
}

/** Rotate the Proof signing key: the old key keeps verifying existing exports
 *  (its public PEM is archived), new signatures use the new key. Checkpoints
 *  record which key signed them via keyId. */
export function rotateProofSigningKey(): { oldPublicPem: string; newPublicPem: string } {
  const { priv, pub } = proofSigningKeyPath();
  const current = proofSigningKey();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync(path.join(LESTER.keysDir, "retired"), { recursive: true });
  copyFileSync(priv, path.join(LESTER.keysDir, "retired", `proof-signing-${stamp}.pem`));
  copyFileSync(pub, path.join(LESTER.keysDir, "retired", `proof-signing-${stamp}.pub.pem`));
  // remove current so proofSigningKey() regenerates
  writeFileSync(priv, "", { mode: 0o600 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(priv, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
  chmodSync(priv, 0o600);
  writeFileSync(pub, publicKey.export({ type: "spki", format: "pem" }).toString(), { mode: 0o644 });
  edCache = null;
  const next = proofSigningKey();
  return { oldPublicPem: current.publicPem, newPublicPem: next.publicPem };
}

export function signBytes(data: string | Buffer, pemOverride?: string): string {
  const { privatePem } = pemOverride ? { privatePem: pemOverride } : proofSigningKey();
  return edSign(null, Buffer.isBuffer(data) ? data : Buffer.from(data), createPrivateKey(privatePem)).toString("base64");
}

export function verifyBytes(data: string | Buffer, sigB64: string, publicPem: string): boolean {
  try {
    return edVerify(null, Buffer.isBuffer(data) ? data : Buffer.from(data), createPublicKey(publicPem), Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}

// ─── API tokens (shown once, stored hashed) ───────────────────────────────────

export function generateApiToken(): { raw: string; hash: string; prefix: string } {
  const raw = `lst_${randomBytes(24).toString("base64url")}`;
  return { raw, hash: sha256hex(raw), prefix: `${raw.slice(0, 9)}…` };
}

export function hashApiToken(raw: string): string {
  return sha256hex(raw.trim());
}

// ─── Stable node fingerprint (no PII: host + MACs + CPU model + RAM) ─────────

let nodeIdCache: string | null = null;
export function nodeId(): string {
  if (nodeIdCache) return nodeIdCache;
  const nets = os.networkInterfaces();
  const macs = Object.values(nets)
    .flat()
    .filter((n) => n && n.mac !== "00:00:00:00:00:00")
    .map((n) => n!.mac)
    .sort()
    .join(",");
  const fingerprint = [os.hostname(), macs, os.cpus()[0]?.model ?? "", String(os.totalmem())].join("|");
  nodeIdCache = sha256hex(fingerprint).slice(0, 16);
  return nodeIdCache;
}

// ═══ Auth, sessions, tokens, throttling ══════════════════════════════════════════
// merged from src/lib/auth.ts

export type Role = "ADMIN" | "MEMBER" | "AUDITOR";
export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const { sessionTtlHours } = await getSettings();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionTtlHours * 3600_000);
  await db.session.create({ data: { id: sha256hex(token), userId, expiresAt } });
  return { token, expiresAt };
}

export async function destroySession(token: string): Promise<void> {
  await db.session.deleteMany({ where: { id: sha256hex(token) } });
}

export async function listSessions(userId: string) {
  const rows = await db.session.findMany({ where: { userId, expiresAt: { gt: new Date() } }, orderBy: { lastSeenAt: "desc" } });
  return rows.map((s) => ({
    id: s.id.slice(0, 12),
    createdAt: s.createdAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
  }));
}

export async function revokeAllSessions(userId: string): Promise<number> {
  const r = await db.session.deleteMany({ where: { userId } });
  return r.count;
}

export async function revokeSessionById(id: string, userId: string): Promise<boolean> {
  // id is a 12-char prefix of the hashed id — find the full row first
  const rows = await db.session.findMany({ where: { userId } });
  const target = rows.find((r) => r.id.startsWith(id));
  if (!target) return false;
  await db.session.delete({ where: { id: target.id } });
  return true;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(LESTER.sessionCookie)?.value;
  if (!token) return null;
  const session = await db.session.findUnique({ where: { id: sha256hex(token) } });
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  const user = await db.user.findUnique({ where: { id: session.userId } });
  if (!user || user.disabled) return null;
  await db.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  return { id: user.id, username: user.username, displayName: user.displayName, role: user.role as Role };
}

/** Route guard: throws ApiFail(401/403). AUDITOR is read-only for Proof/Health/license info. */
export async function requireUser(roles?: Role[]): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new ApiFail(401, "auth_required", "Sign in to continue.");
  if (roles && !roles.includes(user.role)) {
    throw new ApiFail(403, "forbidden", `This action requires one of: ${roles.join(", ")}.`);
  }
  return user;
}

export async function requireAnyUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new ApiFail(401, "auth_required", "Sign in to continue.");
  return user;
}

// ─── API tokens (hashed at rest; multiple named tokens per user) ─────────────

export async function authUserFromApiToken(raw: string | null): Promise<SessionUser | null> {
  if (!raw?.startsWith("lst_")) return null;
  const tokenHash = hashApiToken(raw);
  const row = await db.apiToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
  if (!row || row.revokedAt || row.user.disabled) return null;
  await db.apiToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return { id: row.user.id, username: row.user.username, displayName: row.user.displayName, role: row.user.role as Role };
}

// ─── Password policy (S4) ─────────────────────────────────────────────────────

const COMMON_PASSWORDS = new Set([
  "password", "password1", "password12", "password123", "password1234", "passw0rd",
  "12345678", "123456789", "1234567890", "12345678910", "qwerty123", "qwertyuiop",
  "letmein123", "welcome123", "welcome1", "admin123", "admin1234", "administrator1",
  "iloveyou123", "sunshine123", "princess123", "football123", "baseball123",
  "superman123", "batman123", "trustno123", "master123", "monkey123", "dragon123",
  "lester1234", "lester2024", "lester2025", "lester2026", "changeme123", "changeme1",
  "secret123", "hello12345", "abcd123456", "qazwsx12345", "zaq12wsx", "1q2w3e4r5t",
  "qwerty12345", "asdfgh12345", "zxcvbn12345", "password12345", "passphrase1",
  "letmein1234", "welcome2024", "welcome2025", "admin@12345", "p@ssw0rd123",
  "password123!", "p@ssword123", "pass@12345", "abcd@1234", "test123456", "test1234",
  "hunter12345", "summer12345", "winter12345", "spring12345", "autumn12345",
]);

export function checkPasswordStrength(pw: string, username?: string): string | null {
  if (pw.length < 10) return "Password must be at least 10 characters.";
  if (pw.length > 200) return "Password must be at most 200 characters.";
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return "Password needs both letters and numbers.";
  const lower = pw.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return "That password is too common — choose something unique.";
  if (username && lower.includes(username.toLowerCase())) return "Password must not contain your username.";
  return null;
}

// ─── Login throttling (S2): persisted, username+IP keyed, progressive delays ──

const WINDOW_MS = 15 * 60_000; // failures age out after 15 quiet minutes
const FREE_FAILURES = 5;

export function throttleKey(username: string, ip: string): string {
  return `${username.toLowerCase()}|${ip}`;
}

/** Required cool-down before the next attempt, from persisted state. */
export async function throttleState(username: string, ip: string): Promise<{ failures: number; delayMs: number }> {
  const key = throttleKey(username, ip);
  const row = await db.loginAttempt.findUnique({ where: { key } });
  if (!row) return { failures: 0, delayMs: 0 };
  const age = Date.now() - row.lastFailedAt.getTime();
  if (age > WINDOW_MS) {
    await db.loginAttempt.delete({ where: { key } }).catch(() => undefined);
    return { failures: 0, delayMs: 0 };
  }
  if (row.failures < FREE_FAILURES) return { failures: row.failures, delayMs: 0 };
  // progressive delay: 1s, 2s, 4s, 8s … capped at 60s. No hard lockout — an
  // attacker cannot lock out the admin, they only slow themselves down.
  const delayMs = Math.min(2 ** (row.failures - FREE_FAILURES) * 1000, 60_000);
  const sinceLast = Date.now() - row.lastFailedAt.getTime();
  return { failures: row.failures, delayMs: sinceLast >= delayMs ? 0 : delayMs - sinceLast };
}

export async function recordLoginFailure(username: string, ip: string): Promise<void> {
  const key = throttleKey(username, ip);
  const row = await db.loginAttempt.findUnique({ where: { key } });
  const age = row ? Date.now() - row.lastFailedAt.getTime() : Infinity;
  if (!row || age > WINDOW_MS) {
    await db.loginAttempt.upsert({
      where: { key },
      update: { failures: 1, lastFailedAt: new Date(), firstFailedAt: new Date() },
      create: { key, failures: 1 },
    });
  } else {
    await db.loginAttempt.update({ where: { key }, data: { failures: { increment: 1 }, lastFailedAt: new Date() } });
  }
  // opportunistic cleanup of stale rows
  await db.loginAttempt.deleteMany({ where: { lastFailedAt: { lt: new Date(Date.now() - 24 * 3600_000) } } }).catch(() => undefined);
}

export async function clearLoginFailures(username: string, ip: string): Promise<void> {
  await db.loginAttempt.deleteMany({ where: { key: throttleKey(username, ip) } }).catch(() => undefined);
}

/** Client IP: only trusts X-Forwarded-For when LESTER_TRUST_PROXY=true. */
export function clientIpFromHeaders(headers: Headers): string {
  if (LESTER.trustProxy) {
    const xff = headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
  }
  return "local";
}

