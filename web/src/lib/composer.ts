// Composer helpers that are not part of the frozen api.ts contract yet.
import type { PinDto } from "./types";

const BASE = import.meta.env.VITE_API_BASE ?? "";

async function post<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

/** Optimistic followup instruction to a live task. The engine may include the
 *  stored message id in its reply — used to suppress the SSE echo (B32).
 *  RC1: `taskId` is the POST-ROLLOVER task id — a followup to a terminal task
 *  archives it server-side and mints a fresh UUID in the same session; the UI
 *  must follow it or it stays stuck on a dead id (refresh then loses the
 *  selection). */
export function sendFollowup(taskId: string, content: string): Promise<{ ok: boolean; messageId?: string; id?: string; taskId?: string; sessionId?: string; delivered?: string }> {
  return post(`${BASE}/api/tasks/${taskId}/message`, { content });
}

/**
 * Parse "@src/lib/api.ts" / "@src/lib/api.ts:L40-L80" / "@file.ts:L12"
 * into pins. Supports optional 'L'/'l' line number prefixes.
 */
export function parsePathRef(token: string): PinDto | null {
  const t = token.replace(/^@/, "").trim();
  if (!t || /\s/.test(t)) return null;
  const m = /^(.+?)(?::(?:L|l)?(\d+)-(?:L|l)?(\d+)|:(?:L|l)?(\d+))?$/.exec(t);
  if (!m || !m[1]) return null;
  const path = m[1];
  if (!/[.\-/]/.test(path)) return null; // require path-ish shape
  const s = m[4] !== undefined ? Number(m[4]) : m[2] !== undefined ? Number(m[2]) : undefined;
  const e = m[3] !== undefined ? Number(m[3]) : s;
  const pin: PinDto = { path };
  if (s !== undefined && Number.isFinite(s)) pin.start_line = s;
  if (e !== undefined && Number.isFinite(e)) pin.end_line = e;
  return pin;
}

/** Extract every @ref token from free text. */
export function extractRefs(text: string): PinDto[] {
  const out: PinDto[] = [];
  for (const m of text.matchAll(/@[^\s,;)]+/g)) {
    const pin = parsePathRef(m[0]);
    if (pin) out.push(pin);
  }
  return out;
}
