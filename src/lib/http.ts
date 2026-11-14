import { NextResponse } from "next/server";
import { ZodType } from "zod";

export function json(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data as Record<string, unknown>, init);
}

export function apiError(status: number, code: string, message: string, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error: { code, message, ...extra } }, { status });
}

export class ApiFail extends Error {
  status: number;
  code: string;
  extra?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    const raw = await req.text();
    if (raw.length > 2 * 1024 * 1024) throw new ApiFail(413, "too_large", "Request body exceeds the 2 MB limit.");
    return JSON.parse(raw) as T;
  } catch (e) {
    if (e instanceof ApiFail) throw e;
    throw new ApiFail(400, "bad_json", "Request body must be valid JSON.");
  }
}

/** A2: schema-validated body parsing with sane error responses. */
export async function readJsonWith<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const raw = await readJson<unknown>(req);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ApiFail(400, "validation_failed", `${first?.path?.join(".") ?? "body"}: ${first?.message ?? "invalid value"}`);
  }
  return parsed.data;
}

export function failResponse(e: unknown): NextResponse {
  if (e instanceof ApiFail) {
    return apiError(e.status, e.code, e.message, e.extra);
  }
  // Never leak stack traces or internal messages to the client.
  console.error("[lester] unhandled:", e);
  return apiError(500, "internal", "Unexpected server error. Details were logged server-side.");
}
