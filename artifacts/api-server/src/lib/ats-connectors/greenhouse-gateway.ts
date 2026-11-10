import { ReplitConnectors } from "@replit/connectors-sdk";
import {
  GREENHOUSE_DIRECT_PREFIX,
  greenhouseDirect,
  type GreenhouseDirect,
} from "./greenhouse-direct";
import {
  greenhouseNoteInput,
  greenhouseNoteReceipt,
  type GreenhouseNoteInput,
} from "./greenhouse-note-policy";

const connector = "greenhouse-harvest-partner";
const MAX_BYTES = 2_000_000;

/** Read-only discovery plus a separate, fixed-purpose direct note publisher. */
export type GreenhouseGateway = {
  connections(): Promise<{ id: string }[]>;
  read(connectionId: string, path: string): Promise<unknown>;
  canPublishNotes?(connectionId: string): boolean;
  publishNote?(connectionId: string, input: GreenhouseNoteInput): Promise<string>;
  canReadNotes?(connectionId: string): boolean;
  readNote?(connectionId: string, noteId: string): Promise<unknown>;
  page?(
    connectionId: string,
    path: string,
  ): Promise<{ records: unknown; nextCursor: string | null }>;
};

export function applicationPreviewPath(jobId: string, cursor?: string) {
  if (!/^[1-9]\d*$/.test(jobId) || !Number.isSafeInteger(Number(jobId)))
    throw new Error("Invalid ATS job identifier");
  if (cursor !== undefined && (!cursor || cursor.length > 8000))
    throw new Error("Invalid ATS cursor");
  return cursor
    ? `/v3/applications?cursor=${encodeURIComponent(cursor)}`
    : `/v3/applications?job_ids=${jobId}&per_page=25`;
}

export function nextApplicationCursor(link: string | null): string | null {
  if (!link) return null;
  if (link.length > 12000) throw new Error("Invalid ATS pagination");
  const next = link.split(",").filter((part) => /;\s*rel="next"\s*$/.test(part));
  if (!next.length) return null;
  if (next.length !== 1) throw new Error("Invalid ATS pagination");
  const match = next[0].match(/^\s*<([^>]+)>;\s*rel="next"\s*$/);
  if (!match) throw new Error("Invalid ATS pagination");
  const url = new URL(match[1]);
  const keys = [...url.searchParams.keys()];
  const cursor = url.searchParams.get("cursor");
  if (
    url.origin !== "https://harvest.greenhouse.io" ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== "/v3/applications" ||
    keys.length !== 1 ||
    keys[0] !== "cursor" ||
    !cursor ||
    cursor.length > 8000
  )
    throw new Error("Invalid ATS pagination");
  return cursor;
}

export async function boundedAtsRead<T>(work: Promise<T>, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("ATS read timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function greenhouseGateway(
  sdk?: Pick<ReplitConnectors, "listConnections" | "createProxyFetch">,
  direct: GreenhouseDirect = greenhouseDirect(),
): GreenhouseGateway {
  const managed = () => (sdk ??= new ReplitConnectors());
  async function request(connectionId: string, path: string, noteId?: string) {
    const response =
      noteId !== undefined
        ? await direct.readNote!(connectionId, noteId)
        : connectionId.startsWith(GREENHOUSE_DIRECT_PREFIX)
          ? await direct.request(connectionId, path)
          : await managed().createProxyFetch(connector, { connectionId })(path, {
              method: "GET",
              redirect: "error",
              signal: AbortSignal.timeout(10_000),
            });
    if (!response.ok || response.redirected || !response.body) throw new Error("ATS read failed");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BYTES) throw new Error("ATS response exceeded limit");
        chunks.push(part.value);
      }
      if (
        connectionId.startsWith(GREENHOUSE_DIRECT_PREFIX) &&
        direct.connectionId() !== connectionId
      )
        throw new Error("ATS connection changed");
      return {
        records: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        link: response.headers.get("link"),
      };
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
  return {
    canReadNotes(connectionId) {
      return (
        connectionId.startsWith(GREENHOUSE_DIRECT_PREFIX) &&
        direct.connectionId() === connectionId &&
        typeof direct.readNote === "function"
      );
    },
    async readNote(connectionId, noteId) {
      if (
        !connectionId.startsWith(GREENHOUSE_DIRECT_PREFIX) ||
        direct.connectionId() !== connectionId ||
        !direct.readNote ||
        !/^[1-9]\d*$/.test(noteId) ||
        !Number.isSafeInteger(Number(noteId))
      )
        throw new Error("Direct Greenhouse note verification unavailable.");
      return (await request(connectionId, "", noteId)).records;
    },
    canPublishNotes(connectionId) {
      return (
        connectionId.startsWith(GREENHOUSE_DIRECT_PREFIX) &&
        direct.connectionId() === connectionId &&
        typeof direct.createNote === "function"
      );
    },
    async publishNote(connectionId, raw) {
      const input = greenhouseNoteInput.parse(raw);
      if (
        !connectionId.startsWith(GREENHOUSE_DIRECT_PREFIX) ||
        direct.connectionId() !== connectionId ||
        !direct.createNote
      )
        throw new Error("Direct Greenhouse note creation permission is required.");
      const response = await direct.createNote(connectionId, input);
      if (!response.body) throw new Error("Greenhouse note outcome unconfirmed.");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 128_000) throw new Error("Greenhouse note outcome unconfirmed.");
          chunks.push(part.value);
        }
        if (direct.connectionId() !== connectionId)
          throw new Error("Greenhouse connection changed.");
        return greenhouseNoteReceipt(JSON.parse(Buffer.concat(chunks).toString("utf8")), input);
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    },
    async connections() {
      // An explicitly configured direct pilot replaces workspace discovery.
      // Old allocations are not silently migrated to these credentials.
      const id = direct.connectionId();
      if (id) return [{ id }];
      return (await managed().listConnections({ connector_names: connector }))
        .filter((c) => c.connector_name === connector)
        .map((c) => ({ id: c.id }));
    },
    async read(connectionId, path) {
      if (!/^\/v3\/(jobs|candidates|applications)\?ids=[1-9]\d*$/.test(path))
        throw new Error("Unsupported ATS read");
      return (await request(connectionId, path)).records;
    },
    async page(connectionId, path) {
      // No general-purpose list proxy: only a bounded job-filtered first page
      // or a cursor issued by this service's authenticated preview endpoint.
      if (
        !/^\/v3\/applications\?job_ids=[1-9]\d*&per_page=25$/.test(path) &&
        !/^\/v3\/applications\?cursor=[A-Za-z0-9_.!~*'()%+-]+$/.test(path)
      )
        throw new Error("Unsupported ATS preview");
      const result = await request(connectionId, path);
      return { records: result.records, nextCursor: nextApplicationCursor(result.link) };
    },
  };
}
