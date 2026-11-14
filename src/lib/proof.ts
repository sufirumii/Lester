/**
 * Lester Proof: the append-only hash-chained ledger, signed checkpoints, signed JSON exports and the auditor-facing PDF renderer.
 *
 * Merged module (v1.0.2 repository consolidation — zero behavior change).
 * Sections:
 *   1. Ledger, verification, checkpoints, exports
 *   2. PDF report renderer
 */

import { db } from "./db";
import { nodeId, proofSigningKey, sha256hex, signBytes } from "./auth";
import { LESTER } from "./env";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { readFileSync } from "node:fs";
import { default as path } from "node:path";


// ═══ Ledger, verification, checkpoints, exports ══════════════════════════════════
// merged from src/lib/proof.ts

export interface ProofInput {
  userId?: string | null;
  username?: string | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
  action: string;
  status: "ok" | "blocked" | "redacted" | "error";
  modelKey?: string | null;
  provider?: string | null;
  providerLabel?: string | null;
  endpointHost?: string | null;
  endpointIp?: string | null;
  egress?: "loopback" | "private" | "external" | "none" | null;
  latencyMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  redactions?: number | null;
  detail?: Record<string, unknown>;
  content?: string | null; // only when admin enabled content logging
}

// Serialize appends: the chain must be strictly sequential.
let appendQueue: Promise<unknown> = Promise.resolve();

/** The record fields covered by the hash (everything except selfHash/hashVersion). */
function hashRecord(input: {
  prevHash: string | null;
  seq?: number;
  ts?: Date;
  userId: string | null;
  username: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  action: string;
  status: string;
  modelKey: string | null;
  provider: string | null;
  providerLabel: string | null;
  endpointHost: string | null;
  endpointIp: string | null;
  egress: string | null;
  latencyMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  redactions: number | null;
  detail: string;
  content: string | null;
}) {
  return {
    userId: input.userId,
    username: input.username,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    action: input.action,
    status: input.status,
    modelKey: input.modelKey,
    provider: input.provider,
    providerLabel: input.providerLabel,
    endpointHost: input.endpointHost,
    endpointIp: input.endpointIp,
    egress: input.egress,
    latencyMs: input.latencyMs,
    tokensIn: input.tokensIn,
    tokensOut: input.tokensOut,
    redactions: input.redactions,
    detail: input.detail,
    content: input.content,
    prevHash: input.prevHash,
  };
}

/** v2 hash: seq + ISO timestamp + record. */
function entryHashV2(prevHash: string | null, seq: number, ts: Date, record: ReturnType<typeof hashRecord>): string {
  return sha256hex(`${prevHash ?? ""}|${seq}|${ts.toISOString()}|${canonicalJson(record)}`);
}

/** v1 hash (≤1.0.0): record only — kept for verification of legacy ledgers. */
export function entryHashV1(prevHash: string | null, record: ReturnType<typeof hashRecord>): string {
  return sha256hex((prevHash ?? "") + canonicalJson(record));
}

export function appendProof(input: ProofInput): Promise<{ seq: number; selfHash: string }> {
  const run = appendQueue.then(async () => {
    const last = await db.proofEntry.findFirst({ orderBy: { seq: "desc" }, select: { seq: true, selfHash: true } });
    const prevHash = last?.selfHash ?? null;
    const base = {
      userId: input.userId ?? null,
      username: input.username ?? null,
      workspaceId: input.workspaceId ?? null,
      workspaceName: input.workspaceName ?? null,
      action: input.action,
      status: input.status,
      modelKey: input.modelKey ?? null,
      provider: input.provider ?? null,
      providerLabel: input.providerLabel ?? null,
      endpointHost: input.endpointHost ?? null,
      endpointIp: input.endpointIp ?? null,
      egress: input.egress ?? null,
      latencyMs: input.latencyMs ?? null,
      tokensIn: input.tokensIn ?? null,
      tokensOut: input.tokensOut ?? null,
      redactions: input.redactions ?? null,
      detail: JSON.stringify(input.detail ?? {}),
      content: input.content ?? null,
      prevHash,
    };
    const created = await db.proofEntry.create({ data: base });
    const selfHash = entryHashV2(prevHash, created.seq, created.ts, hashRecord(base));
    await db.proofEntry.update({ where: { seq: created.seq }, data: { selfHash, hashVersion: "v2" } });
    return { seq: created.seq, selfHash };
  });
  // Keep the queue alive even if one append fails.
  appendQueue = run.catch(() => undefined);
  return run;
}

/** Deterministic JSON: sorted keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

// ─── Verification ─────────────────────────────────────────────────────────────

export interface ChainVerification {
  valid: boolean;
  checked: number;
  headHash: string | null;
  firstBrokenSeq: number | null;
  brokenReason: string | null;
  legacyEntries: number; // entries still on the v1 hash form
}

export async function verifyChain(): Promise<ChainVerification> {
  const entries = await db.proofEntry.findMany({ orderBy: { seq: "asc" } });
  let prevHash: string | null = null;
  let legacy = 0;
  for (const e of entries) {
    const record = hashRecord({
      prevHash: e.prevHash,
      userId: e.userId,
      username: e.username,
      workspaceId: e.workspaceId,
      workspaceName: e.workspaceName,
      action: e.action,
      status: e.status,
      modelKey: e.modelKey,
      provider: e.provider,
      providerLabel: e.providerLabel,
      endpointHost: e.endpointHost,
      endpointIp: e.endpointIp,
      egress: e.egress,
      latencyMs: e.latencyMs,
      tokensIn: e.tokensIn,
      tokensOut: e.tokensOut,
      redactions: e.redactions,
      detail: e.detail,
      content: e.content,
    });
    if (e.prevHash !== prevHash) {
      return { valid: false, checked: e.seq - 1, headHash: prevHash, firstBrokenSeq: e.seq, brokenReason: "prevHash link mismatch — an entry was inserted or removed.", legacyEntries: legacy };
    }
    const isV1 = e.hashVersion === "v1";
    if (isV1) legacy++;
    const expected = isV1 ? entryHashV1(prevHash, record) : entryHashV2(prevHash, e.seq, e.ts, record);
    if (e.selfHash !== expected) {
      return {
        valid: false,
        checked: e.seq - 1,
        headHash: prevHash,
        firstBrokenSeq: e.seq,
        brokenReason: isV1
          ? "selfHash mismatch (v1 form) — an entry was modified after the fact."
          : "selfHash mismatch — an entry, its sequence number or its timestamp was modified after the fact.",
        legacyEntries: legacy,
      };
    }
    prevHash = e.selfHash;
  }
  return { valid: true, checked: entries.length, headHash: prevHash, firstBrokenSeq: null, brokenReason: null, legacyEntries: legacy };
}

/**
 * Upgrade a v1 ledger to the v2 hash form. Refuses to touch anything unless
 * the full v1 chain verifies first. Re-hashes sequentially in one transaction
 * and appends a `proof.rehash` entry recording the transition.
 */
export async function rehashLegacyChain(actor?: { id?: string; username?: string }): Promise<{ upgraded: number; refused?: string }> {
  const entries = await db.proofEntry.findMany({ orderBy: { seq: "asc" } });
  const legacy = entries.filter((e) => e.hashVersion === "v1");
  if (legacy.length === 0) return { upgraded: 0 };

  // 1 — verify the whole chain as it stands (v1 rules for v1 rows)
  const check = await verifyChain();
  if (!check.valid) {
    return { upgraded: 0, refused: `Legacy chain does not verify (broken at seq ${check.firstBrokenSeq}: ${check.brokenReason}). Left untouched — inspect Proof before upgrading.` };
  }

  // 2 — rewrite hashes to v2, strictly in order (the record must carry the
  //     RUNNING prevHash, not the row's original one)
  await db.$transaction(async (tx) => {
    let prevHash: string | null = null;
    for (const e of entries) {
      const record = hashRecord({
        prevHash,
        userId: e.userId,
        username: e.username,
        workspaceId: e.workspaceId,
        workspaceName: e.workspaceName,
        action: e.action,
        status: e.status,
        modelKey: e.modelKey,
        provider: e.provider,
        providerLabel: e.providerLabel,
        endpointHost: e.endpointHost,
        endpointIp: e.endpointIp,
        egress: e.egress,
        latencyMs: e.latencyMs,
        tokensIn: e.tokensIn,
        tokensOut: e.tokensOut,
        redactions: e.redactions,
        detail: e.detail,
        content: e.content,
      });
      const selfHash = entryHashV2(prevHash, e.seq, e.ts, record);
      await tx.proofEntry.update({ where: { seq: e.seq }, data: { prevHash, selfHash, hashVersion: "v2" } });
      prevHash = selfHash;
    }
  });

  // 3 — record the transition itself
  await appendProof({
    userId: actor?.id ?? null,
    username: actor?.username ?? "system",
    action: "proof.rehash",
    status: "ok",
    detail: { upgraded: legacy.length, from: "v1", to: "v2", reason: "1.0.1 upgrade: seq+ts now covered by the hash" },
  });
  return { upgraded: legacy.length };
}

// ─── Signed checkpoints (P2) ──────────────────────────────────────────────────

export interface CheckpointInfo {
  id: string;
  seq: number;
  headHash: string;
  ts: string;
  keyId: string;
  signature: string;
}

/** Sign the current head hash. Export/anchor the row outside the host to make
 *  a full-chain rewrite detectable even by an attacker with disk access. */
export async function createCheckpoint(): Promise<CheckpointInfo> {
  const head = await db.proofEntry.findFirst({ orderBy: { seq: "desc" }, select: { seq: true, selfHash: true } });
  const seq = head?.seq ?? 0;
  const headHash = head?.selfHash ?? sha256hex("lester-empty-ledger");
  const ts = new Date();
  const key = proofSigningKey();
  const payload = `lester-checkpoint:${nodeId()}:${seq}:${headHash}:${ts.toISOString()}`;
  const signature = signBytes(payload);
  const row = await db.proofCheckpoint.create({
    data: { seq, headHash, ts, signature, keyId: key.keyId },
  });
  return { id: row.id, seq, headHash, ts: ts.toISOString(), keyId: key.keyId, signature };
}

export async function listCheckpoints(take = 20): Promise<CheckpointInfo[]> {
  const rows = await db.proofCheckpoint.findMany({ orderBy: { ts: "desc" }, take });
  return rows.map((r) => ({ id: r.id, seq: r.seq, headHash: r.headHash, ts: r.ts.toISOString(), keyId: r.keyId, signature: r.signature }));
}

export function verifyCheckpoint(cp: { headHash: string; ts: string; seq: number; signature: string; keyId: string }, publicPem: string, expectedNodeId: string): boolean {
  const payload = `lester-checkpoint:${expectedNodeId}:${cp.seq}:${cp.headHash}:${cp.ts}`;
  try {
    return verifyBytesLocal(payload, cp.signature, publicPem);
  } catch {
    return false;
  }
}

function verifyBytesLocal(data: string, sigB64: string, publicPem: string): boolean {
  try {
    return edVerify(null, Buffer.from(data), createPublicKey(publicPem), Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}

// ─── Signed exports ───────────────────────────────────────────────────────────

export interface ProofReport {
  product: string;
  version: string;
  generatedAt: string;
  period: { from: string | null; to: string | null };
  node: { entries: number; firstSeq: number | null; lastSeq: number | null; nodeId: string };
  chain: { valid: boolean; headHash: string | null; checked: number; firstBrokenSeq: number | null; brokenReason: string | null; legacyEntries: number };
  checkpoints: CheckpointInfo[];
  counts: {
    total: number;
    byStatus: Record<string, number>;
    byEgress: Record<string, number>;
    blocked: number;
    redacted: number;
    tokensIn: number;
    tokensOut: number;
  };
  entries: Array<Record<string, unknown>>;
  publicKeyPem: string;
  signature: string;
  signatureInput: string;
  verificationInstructions: string;
}

export async function buildReport(from?: Date, to?: Date): Promise<ProofReport> {
  const where = {
    ...(from ? { ts: { gte: from } } : {}),
    ...(to ? { ts: { lte: to } } : {}),
  };
  const entries = await db.proofEntry.findMany({ where, orderBy: { seq: "asc" } });
  const chain = await verifyChain();
  const checkpoints = await listCheckpoints(50);
  const byStatus: Record<string, number> = {};
  const byEgress: Record<string, number> = {};
  let tokensIn = 0;
  let tokensOut = 0;
  for (const e of entries) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    const eg = e.egress ?? "none";
    byEgress[eg] = (byEgress[eg] ?? 0) + 1;
    tokensIn += e.tokensIn ?? 0;
    tokensOut += e.tokensOut ?? 0;
  }
  const { publicPem } = proofSigningKey();
  const base = {
    product: "Lester",
    version: LESTER.version,
    generatedAt: new Date().toISOString(),
    period: { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null },
    node: { entries: entries.length, firstSeq: entries[0]?.seq ?? null, lastSeq: entries[entries.length - 1]?.seq ?? null, nodeId: nodeId() },
    chain: { valid: chain.valid, headHash: chain.headHash, checked: chain.checked, firstBrokenSeq: chain.firstBrokenSeq, brokenReason: chain.brokenReason, legacyEntries: chain.legacyEntries },
    checkpoints,
    counts: {
      total: entries.length,
      byStatus,
      byEgress,
      blocked: byStatus["blocked"] ?? 0,
      redacted: byStatus["redacted"] ?? 0,
      tokensIn,
      tokensOut,
    },
    entries: entries.map((e) => ({
      seq: e.seq,
      ts: e.ts.toISOString(),
      userId: e.userId,
      username: e.username,
      workspaceId: e.workspaceId,
      workspaceName: e.workspaceName,
      action: e.action,
      status: e.status,
      modelKey: e.modelKey,
      provider: e.provider,
      providerLabel: e.providerLabel,
      endpointHost: e.endpointHost,
      endpointIp: e.endpointIp,
      egress: e.egress,
      latencyMs: e.latencyMs,
      tokensIn: e.tokensIn,
      tokensOut: e.tokensOut,
      redactions: e.redactions,
      detail: e.detail,
      content: e.content,
      prevHash: e.prevHash,
      selfHash: e.selfHash,
      hashVersion: e.hashVersion,
      display: {
        endpoint: e.endpointHost ? `${e.endpointHost} (${e.endpointIp ?? "?"})` : null,
      },
    })),
    publicKeyPem: publicPem,
  };
  const signatureInput = canonicalJson(base);
  const signature = signBytes(signatureInput);
  return {
    ...base,
    signature,
    signatureInput,
    verificationInstructions:
      "Verify offline: (1) check the Ed25519 signature over signatureInput with the embedded public key, (2) recompute the hash chain over entries (v2: sha256(prevHash|seq|ts|canonicalJson), v1 legacy rows: sha256(prevHash+canonicalJson)), (3) optionally verify signed checkpoints against an anchored copy. Lester ships scripts/verify-proof.ts to do all of this in one command.",
  };
}

/** Hash that an auditor can compare before trusting a report. */
export function reportChecksum(report: ProofReport): string {
  return sha256hex(report.signatureInput);
}

// ═══ PDF report renderer ═════════════════════════════════════════════════════════
// merged from src/lib/proof-pdf.ts

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 40;
const GREEN = rgb(0.055, 0.42, 0.34);

/** Standard 14 PDF fonts are WinAnsi-only — sanitize everything we draw. */
function ascii(s: string): string {
  return s
    .replace(/\u2026/g, "...")
    .replace(/\u2192/g, "->")
    .replace(/\u2014/g, "-")
    .replace(/\u2013/g, "-")
    .replace(/\u2019/g, "'")
    .replace(/\u201c|\u201d/g, '"')
    .replace(/[^\x20-\x7E]/g, "");
}

export async function renderProofPdf(report: ProofReport): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Lester Proof Report");
  doc.setSubject("Data-stayed-local ledger export");
  doc.setProducer("Lester 1.0.0");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);

  // Brand mark
  let logo: Awaited<ReturnType<typeof doc.embedPng>> | null = null;
  try {
    const iconPath = path.join(process.cwd(), "public", "icons", "icon-512.png");
    logo = await doc.embedPng(readFileSync(iconPath));
  } catch {
    logo = null;
  }

  const pages: ReturnType<typeof doc.addPage>[] = [];
  let page = doc.addPage([PAGE_W, PAGE_H]);
  pages.push(page);
  let y = PAGE_H - M;

  const ensureSpace = (needed: number) => {
    if (y - needed < M + 30) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      pages.push(page);
      y = PAGE_H - M;
    }
  };

  const text = (s: string, x: number, yPos: number, size: number, f = font, color = rgb(0.12, 0.13, 0.12)) => {
    page.drawText(ascii(s), { x, y: yPos, size, font: f, color });
  };

  // ── Header ─────────────────────────────────────────────────────────────
  if (logo) {
    page.drawImage(logo, { x: M, y: y - 44, width: 52, height: 52 });
  }
  text("Lester Proof Report", M + 64, y - 8, 20, bold, GREEN);
  text("Where every request ran — and whether any byte left the machine.", M + 64, y - 26, 9, font, rgb(0.4, 0.42, 0.4));
  y -= 68;

  const rows: [string, string][] = [
    ["Generated", new Date(report.generatedAt).toUTCString()],
    ["Period", `${report.period.from ?? "beginning"} → ${report.period.to ?? "now"}`],
    ["Entries", `${report.counts.total} (seq ${report.node.firstSeq ?? "—"}…${report.node.lastSeq ?? "—"})`],
    ["Chain integrity", report.chain.valid ? `VERIFIED (${report.chain.checked} entries, head ${report.chain.headHash?.slice(0, 16)}…)` : `BROKEN at seq ${report.chain.firstBrokenSeq}: ${report.chain.brokenReason}`],
    ["Blocked by policy", String(report.counts.blocked)],
    ["Redacted before dispatch", String(report.counts.redacted)],
    ["Egress breakdown", Object.entries(report.counts.byEgress).map(([k, v]) => `${k}: ${v}`).join("   ") || "none"],
    ["Tokens (in/out)", `${report.counts.tokensIn} / ${report.counts.tokensOut}`],
    ["Signature (Ed25519)", `${report.signature.slice(0, 44)}…`],
  ];
  for (const [k, v] of rows) {
    ensureSpace(16);
    text(k, M, y, 9, bold, rgb(0.25, 0.27, 0.25));
    page.drawText(ascii(v.length > 92 ? v.slice(0, 92) + "..." : v), { x: M + 150, y, size: 9, font: mono, color: rgb(0.12, 0.13, 0.12) });
    y -= 14;
  }
  y -= 8;

  // ── Table ──────────────────────────────────────────────────────────────
  const cols: { label: string; w: number; get: (e: Record<string, unknown>) => string }[] = [
    { label: "Seq", w: 30, get: (e) => String(e.seq) },
    { label: "Time (UTC)", w: 78, get: (e) => String(e.ts).slice(5, 16).replace("T", " ") },
    { label: "Action", w: 74, get: (e) => String(e.action) },
    { label: "Status", w: 44, get: (e) => String(e.status) },
    { label: "Model", w: 92, get: (e) => String(e.modelKey ?? "—") },
    { label: "Provider", w: 60, get: (e) => String(e.provider ?? "—") },
    { label: "Egress", w: 46, get: (e) => String(e.egress ?? "none") },
    { label: "Host", w: 66, get: (e) => String((e as { display?: { endpoint?: string } }).display?.endpoint ?? e.endpointHost ?? "—") },
    { label: "Tok I/O", w: 46, get: (e) => `${e.tokensIn ?? 0}/${e.tokensOut ?? 0}` },
    { label: "ms", w: 30, get: (e) => String(e.latencyMs ?? "—") },
  ];

  const drawHeader = () => {
    ensureSpace(28);
    let x = M;
    page.drawRectangle({ x: M, y: y - 4, width: PAGE_W - 2 * M, height: 16, color: rgb(0.93, 0.95, 0.93) });
    for (const c of cols) {
      text(c.label, x, y, 7, bold);
      x += c.w;
    }
    y -= 16;
  };
  drawHeader();

  const statusColor: Record<string, ReturnType<typeof rgb>> = {
    ok: rgb(0.1, 0.42, 0.3),
    blocked: rgb(0.64, 0.16, 0.12),
    redacted: rgb(0.66, 0.42, 0.05),
    error: rgb(0.64, 0.16, 0.12),
  };

  for (const e of report.entries) {
    ensureSpace(14);
    let x = M;
    for (const c of cols) {
      const v = c.get(e);
      const truncated = v.length > c.w / 4.1 ? v.slice(0, Math.floor(c.w / 4.1)) : v;
      if (c.label === "Status") {
        text(truncated, x, y, 7, font, statusColor[String(e.status)] ?? rgb(0.2, 0.2, 0.2));
      } else {
        text(truncated, x, y, 7, mono);
      }
      x += c.w;
    }
    y -= 12;
  }

  // ── Footer on every page ───────────────────────────────────────────────
  for (const [i, p] of pages.entries()) {
    p.drawLine({ start: { x: M, y: M + 14 }, end: { x: PAGE_W - M, y: M + 14 }, thickness: 0.5, color: rgb(0.85, 0.86, 0.85) });
    p.drawText(ascii("Lester - Proof Report - verify with scripts/verify-proof.ts (checks Ed25519 signature + hash chain)"), {
      x: M, y: M + 3, size: 6.5, font, color: rgb(0.45, 0.47, 0.45),
    });
    p.drawText(`Page ${i + 1} / ${pages.length}`, { x: PAGE_W - M - 40, y: M + 3, size: 6.5, font, color: rgb(0.45, 0.47, 0.45) });
  }

  return doc.save();
}
