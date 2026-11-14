/**
 * Governance: the policy router, on-device PII/secret redaction, and the SSRF guard for admin-configured URLs.
 *
 * Merged module (v1.0.2 repository consolidation — zero behavior change).
 * Sections:
 *   1. Policy router
 *   2. PII / secret redaction
 *   3. URL guard (SSRF)
 */

import { lookup } from "node:dns/promises";
import { classifyIp, isLinkLocalOrMetadata } from "./engine";


// ═══ Policy router ═══════════════════════════════════════════════════════════════
// merged from src/lib/policy.ts

export type PolicyMode = "LOCAL_ONLY" | "CLOUD_FALLBACK" | "BLOCK_ALL";

export interface PolicyRules {
  mode: PolicyMode;
  redactPii: boolean;
  blockKeywords: string;
  allowedModels: string;
  maxTokens: number;
}

export interface PolicyDecision {
  decision: "allow" | "block";
  reason: string;
  redactedText: string;
  findings: RedactionFinding[];
  redactionCount: number;
  /** true when PII was masked before dispatch */
  redacted: boolean;
}

function keywords(blockKeywords: string): string[] {
  return blockKeywords
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

function models(allowedModels: string): string[] {
  return allowedModels
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

export const MODE_PLAIN_LANGUAGE: Record<PolicyMode, { title: string; description: string }> = {
  LOCAL_ONLY: {
    title: "Local only",
    description: "Requests run on this machine's engine. Nothing is ever sent to a cloud API. Cloud models are refused even if someone selects one.",
  },
  CLOUD_FALLBACK: {
    title: "Local first, cloud fallback",
    description: "Requests try the local engine first. If the local engine fails, a configured cloud provider may take over — and the Proof ledger records every byte that left.",
  },
  BLOCK_ALL: {
    title: "Blocked",
    description: "All model requests in this workspace are refused. Useful for freeze, investigation, or audit windows.",
  },
};

export function evaluatePolicy(
  rules: PolicyRules,
  input: { text: string; modelKey: string; targetIsCloud: boolean; cloudConfigured: boolean }
): PolicyDecision {
  // 1. Hard block
  if (rules.mode === "BLOCK_ALL") {
    return { decision: "block", reason: "Workspace policy is set to Blocked — all model requests are refused.", redactedText: input.text, findings: [], redactionCount: 0, redacted: false };
  }

  // 2. Keyword blocks (case-insensitive)
  const kws = keywords(rules.blockKeywords);
  const lower = input.text.toLowerCase();
  for (const kw of kws) {
    if (lower.includes(kw)) {
      return {
        decision: "block",
        reason: `Blocked by keyword rule: "${kw}". Ask an admin to adjust this workspace's policy if this is a mistake.`,
        redactedText: input.text,
        findings: [],
        redactionCount: 0,
        redacted: false,
      };
    }
  }

  // 3. Cloud usage requires explicit permission
  if (input.targetIsCloud) {
    if (rules.mode !== "CLOUD_FALLBACK") {
      return {
        decision: "block",
        reason: "Cloud fallback is OFF for this workspace. This request selected a cloud model, so it was refused before any data left the machine.",
        redactedText: input.text,
        findings: [],
        redactionCount: 0,
        redacted: false,
      };
    }
    if (!input.cloudConfigured) {
      return {
        decision: "block",
        reason: "Cloud fallback is allowed by policy, but no cloud provider is configured. Nothing left the machine.",
        redactedText: input.text,
        findings: [],
        redactionCount: 0,
        redacted: false,
      };
    }
  }

  // 4. Allowed model list
  const allowed = models(rules.allowedModels);
  if (allowed.length > 0 && !allowed.includes(input.modelKey)) {
    return {
      decision: "block",
      reason: `Model is not on this workspace's approved list (${allowed.length} approved).`,
      redactedText: input.text,
      findings: [],
      redactionCount: 0,
      redacted: false,
    };
  }

  // 5. PII redaction before dispatch
  if (rules.redactPii) {
    const r = redact(input.text);
    if (r.total > 0) {
      return {
        decision: "allow",
        reason: `Redacted ${r.total} sensitive value${r.total === 1 ? "" : "s"} (${r.findings.map((f) => f.type).join(", ")}) before dispatch.`,
        redactedText: r.redacted,
        findings: r.findings,
        redactionCount: r.total,
        redacted: true,
      };
    }
  }

  return { decision: "allow", reason: "Allowed by workspace policy.", redactedText: input.text, findings: [], redactionCount: 0, redacted: false };
}

// ═══ PII / secret redaction ══════════════════════════════════════════════════════
// merged from src/lib/redact.ts

export type FindingType =
  | "credit_card"
  | "ssn"
  | "email"
  | "phone"
  | "api_key"
  | "private_key"
  | "iban";

export interface RedactionFinding {
  type: FindingType;
  count: number;
}

export interface RedactionResult {
  redacted: string;
  findings: RedactionFinding[];
  total: number;
}

function luhnValid(digits: string): boolean {
  const s = digits.replace(/[ -]/g, "");
  if (!/^\d{13,19}$/.test(s)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = parseInt(s[i], 10);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const MASKS: Record<FindingType, string> = {
  credit_card: "[CARD REDACTED]",
  ssn: "[SSN REDACTED]",
  email: "[EMAIL REDACTED]",
  phone: "[PHONE REDACTED]",
  api_key: "[API KEY REDACTED]",
  private_key: "[PRIVATE KEY REDACTED]",
  iban: "[IBAN REDACTED]",
};

interface Rule {
  type: FindingType;
  regex: RegExp;
  validate?: (m: RegExpMatchArray) => boolean;
}

const RULES: Rule[] = [
  {
    type: "private_key",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    type: "api_key",
    regex: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xoxb-[A-Za-z0-9-]{20,})\b/g,
  },
  {
    type: "credit_card",
    regex: /\b(?:\d[ -]?){13,19}\b/g,
    validate: (m) => luhnValid(m[0]),
  },
  {
    type: "ssn",
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    type: "iban",
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,26}\b/g,
  },
  {
    type: "email",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    type: "phone",
    // international-format numbers with flexible grouping (covers +91 Indian
    // mobiles in 5+5 and 10-digit groupings, +1 NANP, +49 German, etc.)
    regex: /\+\d{1,3}(?:[\s()./-]+\d{2,10}){1,3}/g,
    validate: (m) => {
      const digits = m[0].replace(/\D/g, "");
      return digits.length >= 10 && digits.length <= 15;
    },
  },
];

export function redact(text: string): RedactionResult {
  let out = text;
  const findings: RedactionFinding[] = [];
  for (const rule of RULES) {
    const matches = [...out.matchAll(rule.regex)];
    let count = 0;
    for (const m of matches) {
      if (rule.validate && !rule.validate(m)) continue;
      count++;
    }
    if (count > 0) {
      // Re-run replacement with validation to mask only valid hits
      out = out.replace(rule.regex, (fullMatch, ...args) => {
        // Build a synthetic match array for validation
        const synthetic = [fullMatch, ...args.slice(0, -2)] as unknown as RegExpMatchArray;
        if (rule.validate && !rule.validate(synthetic)) return fullMatch;
        return MASKS[rule.type];
      });
      findings.push({ type: rule.type, count });
    }
  }
  return { redacted: out, findings, total: findings.reduce((a, f) => a + f.count, 0) };
}

/** Which detector types exist — surfaced in the Policy UI. */
export const DETECTORS: { type: FindingType; label: string; example: string }[] = [
  { type: "credit_card", label: "Credit cards", example: "Luhn-validated card numbers" },
  { type: "ssn", label: "US SSN", example: "123-45-6789" },
  { type: "iban", label: "IBAN", example: "DE89 3704 0044 0532 0130 00" },
  { type: "email", label: "Email addresses", example: "name@company.com" },
  { type: "phone", label: "Phone numbers", example: "+49 30 12345678" },
  { type: "api_key", label: "API keys", example: "sk-…, ghp_…, AKIA…, xoxb-…" },
  { type: "private_key", label: "Private key blocks", example: "-----BEGIN PRIVATE KEY-----" },
];

// ═══ URL guard (SSRF) ════════════════════════════════════════════════════════════
// merged from src/lib/urlguard.ts

export interface UrlCheck {
  ok: boolean;
  reason?: string;
  resolvedIp?: string;
  egress?: "loopback" | "private" | "external";
}

const ALLOW_METADATA = (process.env.LESTER_ALLOW_METADATA_ENDPOINTS ?? "").trim() === "true";

export async function checkUrl(rawUrl: string, opts: { allowExternal: boolean }): Promise<UrlCheck> {
  const url = (rawUrl ?? "").trim();
  if (!url) return { ok: false, reason: "URL is empty." };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "Not a valid URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "Only http:// and https:// URLs are allowed." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "URLs with embedded credentials are not allowed." };
  }
  const host = parsed.hostname;
  let ip = host;
  if (host !== "localhost" && !/^\d+\.\d+\.\d+\.\d+$/.test(host) && !host.includes(":")) {
    try {
      ip = (await lookup(host, { family: 0 })).address;
    } catch {
      return { ok: false, reason: `Host "${host}" does not resolve.` };
    }
  }
  if (host === "localhost") ip = "127.0.0.1";
  if (isLinkLocalOrMetadata(ip) && !ALLOW_METADATA) {
    return { ok: false, reason: `${host} resolves to ${ip} (link-local / cloud-metadata range) — refused. Set LESTER_ALLOW_METADATA_ENDPOINTS=true if this is genuinely intended.`, resolvedIp: ip };
  }
  const egress = classifyIp(ip);
  if (!opts.allowExternal && egress === "external") {
    return { ok: false, reason: `${host} resolves to ${ip}, a public address. Local engines must live on loopback or a private network.`, resolvedIp: ip, egress };
  }
  return { ok: true, resolvedIp: ip, egress };
}
