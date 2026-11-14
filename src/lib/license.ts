/**
 * Offline licensing: vendor-key-pinned Ed25519 verification, node binding, tiers and quotas.
 *
 * Merged module (v1.0.2 repository consolidation — zero behavior change).
 * Sections:
 *   1. Pinned vendor public key
 *   2. Verification, activation, quotas
 */

import { createPublicKey, verify as edVerify } from "node:crypto";
import { db } from "./db";
import { nodeId } from "./auth";
import { appendProof } from "./proof";


// ═══ Pinned vendor public key ════════════════════════════════════════════════════
// merged from src/lib/license-vendor-key.ts

export const VENDOR_LICENSE_PUB_HEX =
  "302a300506032b657003210063178d05e48aaddd432b21c15c62b5f092b06bd2c7a507e96e53110b44bce3e2";

// ═══ Verification, activation, quotas ════════════════════════════════════════════
// merged from src/lib/license.ts

export function licensePublicKeyHex(): string {
  // deliberately NOT cached: the dev-key override (LESTER_LICENSE_PUB) must
  // take effect and clear without a restart, and this is not a hot path.
  const override = (process.env.LESTER_LICENSE_PUB ?? "").trim();
  return override || VENDOR_LICENSE_PUB_HEX;
}

export function usingVendorKey(): boolean {
  return licensePublicKeyHex() === VENDOR_LICENSE_PUB_HEX;
}

export interface LicensePayload {
  v: 1;
  tier: "team";
  customer: string;
  nodes: number;
  users: number;
  nodeId: string;
  issuedAt: string;
  expiresAt: string | null;
}

export interface LicenseInfo {
  tier: "free" | "team";
  customer: string;
  users: number;
  workspaces: number;
  nodeId: string;
  expiresAt: string | null;
  valid: boolean;
}

function b64urlToBytes(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function parseLicenseKey(key: string): { payload: LicensePayload | null; valid: boolean; reason?: string } {
  const raw = key.trim();
  if (!raw.startsWith("LST1.")) return { payload: null, valid: false, reason: "Key must start with LST1." };
  const parts = raw.slice(5).split(".");
  if (parts.length !== 2) return { payload: null, valid: false, reason: "Malformed key." };
  let payload: LicensePayload;
  try {
    payload = JSON.parse(b64urlToBytes(parts[0]).toString("utf-8"));
  } catch {
    return { payload: null, valid: false, reason: "Payload is not valid JSON." };
  }
  const ok = edVerify(
    null,
    Buffer.from(b64urlToBytes(parts[0]).toString("utf-8"), "utf-8"),
    createPublicKey({
      key: Buffer.from(licensePublicKeyHex(), "hex"),
      format: "der",
      type: "spki",
    }),
    b64urlToBytes(parts[1])
  );
  if (!ok) {
    return {
      payload,
      valid: false,
      reason: usingVendorKey()
        ? "Signature check failed — this key was not issued by the Lester vendor key pinned in this build (or it was issued for a dev-key build)."
        : "Signature check failed — this key was not issued by the currently configured license authority (LESTER_LICENSE_PUB).",
    };
  }
  if (payload.nodeId !== nodeId()) {
    return { payload, valid: false, reason: `Key is bound to another node (${payload.nodeId}). This node is ${nodeId()}.` };
  }
  if (payload.expiresAt && new Date(payload.expiresAt) < new Date()) {
    return { payload, valid: false, reason: `Key expired ${payload.expiresAt}.` };
  }
  return { payload, valid: true };
}

export async function activateLicense(key: string, actor: { id: string; username: string }): Promise<LicenseInfo> {
  const parsed = parseLicenseKey(key);
  if (!parsed.valid || !parsed.payload) {
    await appendProof({
      userId: actor.id,
      username: actor.username,
      action: "license.activate",
      status: "error",
      detail: { reason: parsed.reason ?? "invalid" },
    });
    throw new Error(parsed.reason ?? "Invalid license key.");
  }
  const p = parsed.payload;
  await db.license.create({
    data: {
      key: key.trim(),
      tier: p.tier,
      customer: p.customer,
      nodes: p.nodes,
      userLimit: p.users ?? 25,
      nodeId: p.nodeId,
      issuedAt: new Date(p.issuedAt),
      expiresAt: p.expiresAt ? new Date(p.expiresAt) : null,
      valid: true,
    },
  });
  await appendProof({
    userId: actor.id,
    username: actor.username,
    action: "license.activate",
    status: "ok",
    detail: { tier: p.tier, customer: p.customer, nodes: p.nodes, users: p.users },
  });
  return licenseInfo();
}

export async function licenseInfo(): Promise<LicenseInfo> {
  const node = nodeId();
  const rows = await db.license.findMany({ orderBy: { activatedAt: "desc" } });
  const active = rows.find((r) => {
    if (!r.valid) return false;
    if (r.nodeId !== node) return false;
    if (r.expiresAt && r.expiresAt < new Date()) return false;
    return true;
  });
  if (!active) {
    return { tier: "free", customer: "Free single-user tier", users: 1, workspaces: 1, nodeId: node, expiresAt: null, valid: true };
  }
  return {
    tier: active.tier === "team" ? "team" : "free",
    customer: active.customer,
    users: active.userLimit,
    workspaces: 999,
    nodeId: node,
    expiresAt: active.expiresAt?.toISOString() ?? null,
    valid: true,
  };
}

/** Enforcement gate used by user/workspace creation. */
export async function checkUserQuota(): Promise<{ allowed: boolean; limit: number; current: number }> {
  const info = await licenseInfo();
  const current = await db.user.count();
  return { allowed: current < info.users, limit: info.users, current };
}

export async function checkWorkspaceQuota(): Promise<{ allowed: boolean; limit: number; current: number }> {
  const info = await licenseInfo();
  const current = await db.workspace.count();
  return { allowed: current < info.workspaces, limit: info.workspaces, current };
}

export const licenseTierLabel = (info: LicenseInfo) =>
  info.tier === "team" ? `Team · ${info.customer} · node ${info.nodeId.slice(0, 8)}` : "Free tier";
