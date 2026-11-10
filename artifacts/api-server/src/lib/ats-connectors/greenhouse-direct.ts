import { createHash } from "node:crypto";
import { greenhouseNoteInput, type GreenhouseNoteInput } from "./greenhouse-note-policy";

export const GREENHOUSE_DIRECT_PREFIX = "greenhouse-direct:";
type Credentials = { clientId: string; clientSecret: string };
export type GreenhouseDirect = {
  connectionId(): string | null;
  request(connectionId: string, path: string): Promise<Response>;
  createNote?(connectionId: string, input: GreenhouseNoteInput): Promise<Response>;
  readNote?(connectionId: string, noteId: string): Promise<Response>;
};

/** The same bounded read surface as the managed connector, never a general proxy. */
export function isGreenhouseReadPath(path: string): boolean {
  return (
    /^\/v3\/(jobs|candidates|applications)\?ids=[1-9]\d*$/.test(path) ||
    /^\/v3\/applications\?job_ids=[1-9]\d*&per_page=25$/.test(path) ||
    /^\/v3\/applications\?cursor=[A-Za-z0-9_.!~*'()%+-]{1,24000}$/.test(path)
  );
}

const unavailable = () => new Error("Greenhouse direct read unavailable.");

/**
 * Optional server-owned Harvest v3 client-credentials transport. The read
 * allowlist remains unchanged; note creation is a separate fixed-purpose call.
 * Credential presence is NOT employer authorization: the existing allocation,
 * exact-employer approval, mapping and per-request authority fences still apply.
 * A credential change changes the opaque connection identity and invalidates its
 * old allocation rather than silently attaching another account.
 */
export function greenhouseDirect({
  credentials = (): Credentials | null => {
    const clientId = process.env.GREENHOUSE_CLIENT_ID;
    const clientSecret = process.env.GREENHOUSE_CLIENT_SECRET;
    if (!clientId && !clientSecret) return null;
    if (!clientId || !clientSecret) throw unavailable();
    return { clientId, clientSecret };
  },
  fetcher = fetch,
  now = Date.now,
}: {
  credentials?: () => Credentials | null;
  fetcher?: typeof fetch;
  now?: () => number;
} = {}): GreenhouseDirect {
  let cached: { id: string; token: string; expiresAt: number } | undefined;
  let pending: { id: string; work: Promise<string> } | undefined;
  const snapshot = () => {
    const value = credentials();
    if (!value) return null;
    if (
      !value.clientId ||
      !value.clientSecret ||
      value.clientId.includes(":") ||
      /[\r\n]/.test(value.clientId + value.clientSecret) ||
      value.clientId.length > 4096 ||
      value.clientSecret.length > 4096
    )
      throw unavailable();
    return {
      ...value,
      id:
        GREENHOUSE_DIRECT_PREFIX +
        createHash("sha256")
          .update(JSON.stringify([value.clientId, value.clientSecret]))
          .digest("hex"),
    };
  };
  function assertCurrent(id: string) {
    if (snapshot()?.id !== id) {
      cached = undefined;
      throw unavailable();
    }
  }
  async function exchange(c: NonNullable<ReturnType<typeof snapshot>>): Promise<string> {
    const response = await fetcher(
      "https://auth.greenhouse.io/token?grant_type=client_credentials",
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization:
            "Basic " + Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64"),
        },
        body: "{}",
      },
    );
    if (!response.ok || response.redirected || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw unavailable();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let body: { access_token?: unknown; expires_in?: unknown; token_type?: unknown };
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 65_536) throw unavailable();
        chunks.push(part.value);
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (
      !body ||
      typeof body.access_token !== "string" ||
      !body.access_token ||
      body.access_token.length > 16_384 ||
      /[\s\x00-\x1f\x7f]/.test(body.access_token) ||
      typeof body.token_type !== "string" ||
      body.token_type.toLowerCase() !== "bearer" ||
      typeof body.expires_in !== "number" ||
      !Number.isSafeInteger(body.expires_in) ||
      body.expires_in < 1
    )
      throw unavailable();
    assertCurrent(c.id);
    cached = {
      id: c.id,
      token: body.access_token,
      // Never retain tokens longer than an hour or into their last 30 seconds.
      expiresAt: now() + Math.max(0, Math.min(body.expires_in, 3600) - 30) * 1000,
    };
    return body.access_token;
  }
  async function token(c: NonNullable<ReturnType<typeof snapshot>>) {
    if (cached?.id === c.id && cached.expiresAt > now()) return cached.token;
    if (pending?.id === c.id) return pending.work;
    const work = exchange(c);
    const current = { id: c.id, work };
    pending = current;
    try {
      return await work;
    } finally {
      if (pending === current) pending = undefined;
    }
  }
  async function readResponse(connectionId: string, path: string) {
    try {
      const c = snapshot();
      if (!c || c.id !== connectionId) throw unavailable();
      const accessToken = await token(c);
      assertCurrent(c.id);
      const response = await fetcher(`https://harvest.greenhouse.io${path}`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      });
      try {
        assertCurrent(c.id);
      } catch {
        await response.body?.cancel().catch(() => undefined);
        throw unavailable();
      }
      if (response.status !== 200 || response.redirected) {
        if (response.status === 401 || response.status === 403) cached = undefined;
        await response.body?.cancel().catch(() => undefined);
        throw unavailable();
      }
      return response;
    } catch {
      throw unavailable();
    }
  }
  return {
    connectionId() {
      return snapshot()?.id ?? null;
    },
    async readNote(connectionId, noteId) {
      if (!/^[1-9]\d*$/.test(noteId) || !Number.isSafeInteger(Number(noteId))) throw unavailable();
      return readResponse(connectionId, `/v3/notes?ids=${noteId}`);
    },
    async createNote(connectionId, input) {
      try {
        const body = greenhouseNoteInput.parse(input);
        const c = snapshot();
        if (!c || c.id !== connectionId) throw unavailable();
        const accessToken = await token(c);
        assertCurrent(c.id);
        // Exactly one request. No automatic retry, alternate endpoint or redirect.
        const response = await fetcher("https://harvest.greenhouse.io/v3/notes", {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(body),
        });
        try {
          assertCurrent(c.id);
        } catch {
          await response.body?.cancel().catch(() => undefined);
          throw unavailable();
        }
        if (response.status !== 201 || response.redirected) {
          if (response.status === 401 || response.status === 403) cached = undefined;
          await response.body?.cancel().catch(() => undefined);
          throw unavailable();
        }
        return response;
      } catch {
        throw new Error("Greenhouse note outcome could not be confirmed.");
      }
    },
    async request(connectionId, path) {
      // The general read allowlist still excludes notes.
      if (!isGreenhouseReadPath(path)) throw unavailable();
      return readResponse(connectionId, path);
    },
  };
}
