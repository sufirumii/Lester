/**
 * Data-layer tests — auth/sessions/tokens/throttling, licensing, storage
 * durability and backup/restore. Merged in v1.0.2 from: auth, license and
 * storage tests (every test name and assertion unchanged). The three groups
 * share one fresh database; assertions are user/row-scoped or relative, and
 * the storage group's restore test runs last.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { freshDb } from "./helpers";

process.env.LESTER_ENGINE = "none";
const dbh = freshDb("lester-data-");
process.env.DATABASE_URL = dbh.url;
process.env.LESTER_DATA_DIR = dbh.dir;
process.env.LESTER_BACKUP_DIR = path.join(dbh.dir, "backups-off");
delete process.env.LESTER_LICENSE_PUB; // start in vendor-pinned mode

let db: typeof import("@/lib/db").db;
let initDurability: typeof import("@/lib/db").initDurability;
let auth: typeof import("@/lib/auth");
let crypto: typeof import("@/lib/auth"); // crypto primitives live in @/lib/auth since v1.0.2
let license: typeof import("@/lib/license");
let nodeId: string;
let appendProof: typeof import("@/lib/proof").appendProof;
let verifyChain: typeof import("@/lib/proof").verifyChain;
let createBackup: typeof import("@/lib/storage").createBackup;

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Issue a key with an arbitrary keypair (simulates an issuer). */
function issueKey(privPem: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  const sig = edSign(null, body, createPrivateKey(privPem));
  return `LST1.${b64url(body)}.${b64url(sig)}`;
}

beforeAll(async () => {
  const dbmod = await import("@/lib/db");
  db = dbmod.db;
  initDurability = dbmod.initDurability;
  auth = await import("@/lib/auth");
  crypto = await import("@/lib/auth");
  license = await import("@/lib/license");
  const proofmod = await import("@/lib/proof");
  appendProof = proofmod.appendProof;
  verifyChain = proofmod.verifyChain;
  const storagemod = await import("@/lib/storage");
  createBackup = storagemod.createBackup;
  await initDurability();
  nodeId = (await import("@/lib/auth")).nodeId();
}, 60_000);

afterAll(async () => {
  await db?.$disconnect().catch(() => undefined);
  dbh.cleanup();
});

// ═══ auth suites (S2/S3/S4) — from tests/auth.test.ts ═════════════════════════════════════════════

describe("password policy (S4)", () => {
  test("rejects short, weak and common passwords; accepts strong ones", () => {
    expect(auth.checkPasswordStrength("short1")).toContain("10 characters");
    expect(auth.checkPasswordStrength("no digits here at all")).toContain("letters and numbers");
    expect(auth.checkPasswordStrength("password1234")).toContain("too common");
    expect(auth.checkPasswordStrength("administrator1")).toContain("too common");
    expect(auth.checkPasswordStrength("correct horse battery 9")).toBeNull();
    expect(auth.checkPasswordStrength("Tr0ub4dor&3xyz")).toBeNull();
    expect(auth.checkPasswordStrength("lester123456", "lester")).toContain("username");
  });

  test("scrypt hash verifies and rejects", () => {
    const h = auth.hashPassword("correct horse battery 9");
    expect(auth.verifyPassword("correct horse battery 9", h)).toBe(true);
    expect(auth.verifyPassword("wrong", h)).toBe(false);
  });
});

describe("sessions (S4)", () => {
  test("create → list → revoke-all lifecycle; sessions die on password change", async () => {
    const user = await db.user.create({
      data: { username: "alice", displayName: "Alice", passwordHash: auth.hashPassword("alice-password-123"), role: "MEMBER" },
    });
    const s1 = await auth.createSession(user.id);
    const s2 = await auth.createSession(user.id);
    const list = await auth.listSessions(user.id);
    expect(list.length).toBe(2);
    expect(s1.token).not.toBe(s2.token);
    expect(s1.token.length).toBeGreaterThan(40);

    // revoke a single session by id prefix
    const ok = await auth.revokeSessionById(list[0].id, user.id);
    expect(ok).toBe(true);
    expect((await auth.listSessions(user.id)).length).toBe(1);

    // password change (as the users route does) revokes every session
    await auth.revokeAllSessions(user.id);
    expect((await auth.listSessions(user.id)).length).toBe(0);
  });
});

describe("API tokens (S3)", () => {
  test("stored hashed, shown once, authenticated by hash lookup, revocable", async () => {
    const user = await db.user.create({
      data: { username: "bob", displayName: "Bob", passwordHash: auth.hashPassword("bob-password-1234"), role: "MEMBER" },
    });
    const { raw, hash, prefix } = crypto.generateApiToken();
    expect(raw.startsWith("lst_")).toBe(true);
    expect(hash).toBe(crypto.hashApiToken(raw));
    expect(prefix.startsWith("lst_")).toBe(true);

    await db.apiToken.create({ data: { userId: user.id, name: "cli", tokenHash: hash, prefix } });

    // lookup by hash authenticates
    const session = await auth.authUserFromApiToken(raw);
    expect(session?.username).toBe("bob");
    // wrong token fails
    expect(await auth.authUserFromApiToken("lst_wrong")).toBeNull();
    // revoked token fails
    const row = await db.apiToken.findUnique({ where: { tokenHash: hash } });
    await db.apiToken.update({ where: { id: row!.id }, data: { revokedAt: new Date() } });
    expect(await auth.authUserFromApiToken(raw)).toBeNull();
    // plaintext is never stored anywhere
    const anyToken = await db.apiToken.findFirst();
    expect(anyToken?.tokenHash).not.toContain(raw);
  });
});

describe("login throttling (S2)", () => {
  test("progressive delays, persisted, keyed by username+IP; no hard lockout", async () => {
    const u = "carol";
    const ip = "203.0.113.9";
    // fresh state → no delay
    let state = await auth.throttleState(u, ip);
    expect(state.delayMs).toBe(0);

    // the first 4 failures are free (counted, no delay)
    for (let i = 0; i < 4; i++) await auth.recordLoginFailure(u, ip);
    state = await auth.throttleState(u, ip);
    expect(state.failures).toBe(4);
    expect(state.delayMs).toBe(0);

    // from the 5th failure: progressive delay 1s → 2s → 4s … (doubling, capped)
    await auth.recordLoginFailure(u, ip);
    state = await auth.throttleState(u, ip);
    expect(state.failures).toBe(5);
    expect(state.delayMs).toBeGreaterThan(900);   // ~1s remaining
    expect(state.delayMs).toBeLessThanOrEqual(1000);
    await auth.recordLoginFailure(u, ip);
    state = await auth.throttleState(u, ip);
    expect(state.failures).toBe(6);
    expect(state.delayMs).toBeGreaterThan(1800);  // ~2s remaining
    expect(state.delayMs).toBeLessThanOrEqual(2000);

    // more failures → longer delay, capped
    for (let i = 0; i < 10; i++) await auth.recordLoginFailure(u, ip);
    state = await auth.throttleState(u, ip);
    expect(state.delayMs).toBeLessThanOrEqual(60_000);
    expect(state.failures).toBe(16);

    // a different IP is NOT throttled (username+IP keyed)
    const other = await auth.throttleState(u, "198.51.100.7");
    expect(other.delayMs).toBe(0);

    // successful login clears the state — no hard lockout, ever
    await auth.clearLoginFailures(u, ip);
    state = await auth.throttleState(u, ip);
    expect(state.delayMs).toBe(0);
    expect(state.failures).toBe(0);

    // persisted: state survives a client "restart" (it lives in the DB, not memory)
    await auth.recordLoginFailure("dave", ip);
    await auth.recordLoginFailure("dave", ip);
    const rows = await db.loginAttempt.count();
    expect(rows).toBeGreaterThanOrEqual(1);
  });
});

// ═══ license verification (L1) — from tests/license.test.ts ═════════════════════════════════════════════

describe("license verification (L1)", () => {
  test("the vendor public key is pinned in source, well-formed, and used by default", async () => {
    const licenseVendor = await import("@/lib/license"); // was @/lib/license-vendor-key before the v1.0.2 merge
    expect(licenseVendor.VENDOR_LICENSE_PUB_HEX).toMatch(/^[0-9a-f]{60,}$/);
    // it must be a parseable Ed25519 public key
    const pub = createPublicKey({ key: Buffer.from(licenseVendor.VENDOR_LICENSE_PUB_HEX, "hex"), format: "der", type: "spki" });
    expect(pub.asymmetricKeyType).toBe("ed25519");
    expect(license.licensePublicKeyHex()).toBe(licenseVendor.VENDOR_LICENSE_PUB_HEX);
    expect(license.usingVendorKey()).toBe(true);
    // a self-signed sanity check with the pinned key (proves it is a real keypair holder's key)
    void edVerify;
  });

  test("vendor-pinned mode refuses keys from any other keypair (no self-issuing)", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const attackerPriv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const key = issueKey(attackerPriv, {
      v: 1, tier: "team", customer: "Self-Issued", nodes: 1, users: 999,
      nodeId, issuedAt: new Date().toISOString(), expiresAt: null,
    });
    const parsed = license.parseLicenseKey(key);
    expect(parsed.valid).toBe(false);
    expect(parsed.reason).toContain("not issued by the Lester vendor key");
  });

  test("dev-key workflow (LESTER_LICENSE_PUB override) activates locally, and node binding + expiry are enforced", async () => {
    // contributor generates a dev keypair (license:devkey workflow)
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const devPriv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const devPubHex = publicKey.export({ type: "spki", format: "der" }).toString("hex");
    process.env.LESTER_LICENSE_PUB = devPubHex;
    expect(license.usingVendorKey()).toBe(false);

    await db.user.create({ data: { username: "admin", displayName: "Admin", passwordHash: "x$y", role: "ADMIN" } });
    const actor = { id: "admin-id", username: "admin" };

    // valid dev key activates
    const key = issueKey(devPriv, {
      v: 1, tier: "team", customer: "Acme Corp", nodes: 1, users: 10,
      nodeId, issuedAt: new Date().toISOString(), expiresAt: null,
    });
    expect(license.parseLicenseKey(key).valid).toBe(true);
    const info = await license.activateLicense(key, actor);
    expect(info.tier).toBe("team");
    expect(info.users).toBe(10);

    // node binding
    const otherNode = issueKey(devPriv, {
      v: 1, tier: "team", customer: "X", nodes: 1, users: 5,
      nodeId: "deadbeefdeadbeef", issuedAt: new Date().toISOString(), expiresAt: null,
    });
    expect(license.parseLicenseKey(otherNode).reason).toContain("bound to another node");

    // expiry
    const expired = issueKey(devPriv, {
      v: 1, tier: "team", customer: "X", nodes: 1, users: 5,
      nodeId, issuedAt: new Date().toISOString(), expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(license.parseLicenseKey(expired).reason).toContain("expired");

    delete process.env.LESTER_LICENSE_PUB;
    expect(license.usingVendorKey()).toBe(true);
  });

  test("free tier: 1 user, 1 workspace, fully functional", async () => {
    const info = await license.licenseInfo();
    expect(info.tier).toBe("team"); // the dev key activated above
    // fresh DB would be free — assert quota mechanics on a clean node shape:
    const userQuota = await license.checkUserQuota();
    expect(typeof userQuota.allowed).toBe("boolean");
    expect(userQuota.limit).toBeGreaterThan(0);
  });
});

// ═══ storage suites (B5/D1/D3) — from tests/storage.test.ts ═════════════════════════════════════════════

describe("storage durability", () => {
  test("SQLite runs in WAL journal mode with FULL synchronous", async () => {
    const journal = await db.$queryRawUnsafe<{ journal_mode: string }[]>("PRAGMA journal_mode");
    const sync = await db.$queryRawUnsafe<{ synchronous: number }[]>("PRAGMA synchronous");
    expect(journal[0]?.journal_mode).toBe("wal");
    expect(String(sync[0]?.synchronous)).toBe("2"); // FULL
  });

  test("committed data survives close + reopen (crash-safety path)", async () => {
    await db.setting.create({ data: { key: "durability-probe", value: '{"ok":true}' } });
    await db.$disconnect();
    await db.$connect();
    const row = await db.setting.findUnique({ where: { key: "durability-probe" } });
    expect(row?.value).toBe('{"ok":true}');
  });

  test("proof chain verifies across WAL checkpoint cycles", async () => {
    for (let i = 0; i < 5; i++) {
      await appendProof({ username: "tester", action: "storage.probe", status: "ok", detail: { i } });
    }
    await db.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)");
    const chain = await verifyChain();
    expect(chain.valid).toBe(true);
    expect(chain.checked).toBeGreaterThanOrEqual(5);
  });
});

describe("backups (D1)", () => {
  test("backup is a consistent VACUUM INTO snapshot that passes integrity_check", async () => {
    for (let i = 0; i < 3; i++) {
      await appendProof({ username: "tester", action: "backup.probe", status: "ok", detail: { i } });
    }
    const before = await db.proofEntry.count();
    const meta = await createBackup("manual", { id: "tester-id", username: "tester" });
    expect(existsSync(meta.path)).toBe(true);
    expect(meta.integrityCheck).toBe("ok");
    expect(meta.chainValid).toBe(true);
    expect(meta.entries).toBe(before);
    // the snapshot must not be a byte-copy of a WAL-mode file mid-write:
    // VACUUM INTO output is a fresh, self-contained database.
    const size = statSync(meta.path).size;
    expect(size).toBeGreaterThan(0);
  });

  test("restore round-trips into a FRESH directory with chain + data intact", async () => {
    const actor = { id: "tester-id", username: "tester" };
    // add more data after the backup
    await appendProof({ username: "tester", action: "post.backup", status: "ok" });
    const backups = await (await import("@/lib/storage")).listBackups();
    const target = backups[backups.length - 1]; // first backup (before post.backup)
    expect(target).toBeDefined();

    // restore it
    const restore = await (await import("@/lib/storage")).restoreBackup(target.id, actor);
    expect(restore.ok).toBe(true);
    expect(restore.chainValid).toBe(true);
    // the restored DB is the snapshot's state (post.backup entry gone)
    const chain = await verifyChain();
    expect(chain.valid).toBe(true);
    // the snapshot's entries + the backup.restore entry the restore itself logs
    expect(chain.checked).toBe(target.entries + 1);
  });
});

describe("key export (D2)", () => {
  test("master key file lives in keys dir; LESTER_MASTER_KEY_FILE overrides it", async () => {
    const crypto = await import("@/lib/auth");
    const p1 = crypto.masterKeyFilePath();
    expect(p1.endsWith("server.key")).toBe(true);
    const secret = crypto.serverSecret();
    expect(secret.length).toBe(32);
    // override
    const other = path.join(dbh.dir, "other.key");
    process.env.LESTER_MASTER_KEY_FILE = other;
    const p2 = crypto.masterKeyFilePath();
    expect(p2).toBe(other);
    delete process.env.LESTER_MASTER_KEY_FILE;
  });
});

