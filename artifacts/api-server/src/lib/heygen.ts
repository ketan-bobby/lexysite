/**
 * lib/heygen.ts — HeyGen API client (Talking Photo → talking-avatar video)
 *
 * Thin, resilient wrapper over the HeyGen REST API used by the recruiter intro
 * video feature. The HTTP layer is isolated here so the orchestration and tests
 * can inject a fake `fetchImpl` and never touch the network.
 *
 * Endpoints used:
 *   POST {upload}/v1/talking_photo   raw image bytes  → { data: { talking_photo_id } }
 *   POST {base}/v2/video/generate    json             → { data: { video_id } }
 *   GET  {base}/v1/video_status.get  ?video_id=…       → { data: { status, video_url } }
 *   GET  {base}/v2/voices                              → { data: { voices: [...] } }
 *
 * Config:
 *   HEYGEN_API_KEY          required (auth via X-Api-Key header)
 *   HEYGEN_API_BASE_URL     default https://api.heygen.com
 *   HEYGEN_UPLOAD_BASE_URL  default https://upload.heygen.com
 *   HEYGEN_DISABLED=true    kill switch — heygenEnabled() returns false
 */
export interface HeyGenVoice {
  voiceId: string;
  language?: string;
  gender?: string;
  name?: string;
}

export interface HeyGenGenerateInput {
  talkingPhotoId: string;
  voiceId?: string | null;
  scriptText: string;
  width?: number;
  height?: number;
}

export interface HeyGenVideoStatus {
  status: "pending" | "processing" | "completed" | "failed" | "unknown";
  videoUrl?: string | null;
  error?: string | null;
}

export interface HeyGenClient {
  isEnabled(): boolean;
  uploadTalkingPhoto(image: Buffer, contentType: string): Promise<string>;
  generateVideo(input: HeyGenGenerateInput): Promise<string>;
  getVideoStatus(videoId: string): Promise<HeyGenVideoStatus>;
  listVoices(): Promise<HeyGenVoice[]>;
}

type FetchImpl = typeof fetch;

const DEFAULT_BASE = "https://api.heygen.com";
const DEFAULT_UPLOAD_BASE = "https://upload.heygen.com";

/** Master gate: false when the kill switch is on or no API key is configured. */
export function heygenEnabled(): boolean {
  if ((process.env.HEYGEN_DISABLED ?? "").toLowerCase() === "true") return false;
  return !!process.env.HEYGEN_API_KEY;
}

export interface HeyGenClientOptions {
  apiKey?: string;
  baseUrl?: string;
  uploadBaseUrl?: string;
  fetchImpl?: FetchImpl;
}

export function createHeyGenClient(opts: HeyGenClientOptions = {}): HeyGenClient {
  const apiKey = opts.apiKey ?? process.env.HEYGEN_API_KEY ?? "";
  const baseUrl = (opts.baseUrl ?? process.env.HEYGEN_API_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");
  const uploadBaseUrl = (opts.uploadBaseUrl ?? process.env.HEYGEN_UPLOAD_BASE_URL ?? DEFAULT_UPLOAD_BASE).replace(/\/$/, "");
  const doFetch: FetchImpl = opts.fetchImpl ?? fetch;

  const authHeaders = (extra: Record<string, string> = {}) => ({ "X-Api-Key": apiKey, ...extra });

  const parseJson = async (res: Response): Promise<any> => {
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return { raw: text };
    }
  };

  return {
    isEnabled() {
      return heygenEnabled() && !!apiKey;
    },

    async uploadTalkingPhoto(image, contentType) {
      const res = await doFetch(`${uploadBaseUrl}/v1/talking_photo`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": contentType || "image/jpeg" }),
        body: image as any,
      });
      const json = await parseJson(res);
      if (!res.ok) {
        throw new Error(`HeyGen talking_photo upload failed: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
      }
      const id = json?.data?.talking_photo_id ?? json?.data?.id ?? json?.talking_photo_id;
      if (!id) throw new Error("HeyGen talking_photo upload: no talking_photo_id in response");
      return String(id);
    },

    async generateVideo(input) {
      const body = {
        video_inputs: [
          {
            character: { type: "talking_photo", talking_photo_id: input.talkingPhotoId },
            voice: {
              type: "text",
              input_text: input.scriptText,
              ...(input.voiceId ? { voice_id: input.voiceId } : {}),
            },
          },
        ],
        dimension: { width: input.width ?? 1280, height: input.height ?? 720 },
      };
      const res = await doFetch(`${baseUrl}/v2/video/generate`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      const json = await parseJson(res);
      if (!res.ok) {
        throw new Error(`HeyGen video generate failed: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
      }
      const id = json?.data?.video_id ?? json?.video_id;
      if (!id) throw new Error("HeyGen video generate: no video_id in response");
      return String(id);
    },

    async getVideoStatus(videoId) {
      const res = await doFetch(`${baseUrl}/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`, {
        method: "GET",
        headers: authHeaders(),
      });
      const json = await parseJson(res);
      if (!res.ok) throw new Error(`HeyGen video status failed: ${res.status}`);
      const d = json?.data ?? json ?? {};
      const raw = String(d?.status ?? "unknown").toLowerCase();
      const status = (["pending", "processing", "completed", "failed"].includes(raw)
        ? raw
        : "unknown") as HeyGenVideoStatus["status"];
      const error = d?.error ? String(d.error?.message ?? d.error) : null;
      return { status, videoUrl: d?.video_url ?? d?.url ?? null, error };
    },

    async listVoices() {
      const res = await doFetch(`${baseUrl}/v2/voices`, { method: "GET", headers: authHeaders() });
      const json = await parseJson(res);
      if (!res.ok) throw new Error(`HeyGen list voices failed: ${res.status}`);
      const voices = json?.data?.voices ?? json?.voices ?? [];
      return (Array.isArray(voices) ? voices : []).map((v: any) => ({
        voiceId: String(v.voice_id ?? v.id ?? ""),
        language: v.language,
        gender: v.gender,
        name: v.name,
      })).filter((v: HeyGenVoice) => v.voiceId);
    },
  };
}
