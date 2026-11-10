import type { VendorUsageUnits } from "@workspace/db";
import type { MeteredProvider } from "./vendor-usage";

const safeId = (value: unknown): string | null =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) ? value : null;
const quantity = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** Never retain arbitrary headers, URLs, response bodies or account balances. */
export function headerReceiptUnits(provider: MeteredProvider, headers: Headers): VendorUsageUnits {
  const units: VendorUsageUnits = {};
  const header =
    provider === "azure_openai" || provider === "azure_tts" || provider === "azure_stt"
      ? "apim-request-id"
      : provider === "elevenlabs"
        ? "request-id"
        : provider === "aws_ses"
          ? "x-amzn-requestid"
          : "x-request-id";
  const id = safeId(headers.get(header));
  if (id) units.provider_request_id = id;
  if (provider === "pdl") {
    // PDL documents X-Call-Credits-Spent. Profile count is NOT a substitute.
    const raw = headers.get("x-call-credits-spent");
    const credits = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
    if (credits !== null && Number.isSafeInteger(credits)) {
      units.provider_reported_credits = credits;
    }
  }
  if (provider === "elevenlabs") {
    const raw = headers.get("character-cost");
    if (raw !== null && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)))
      units.billed_characters = Number(raw);
  }
  return units;
}

export function bodyReceiptUnits(provider: MeteredProvider, body: unknown): VendorUsageUnits {
  const units: VendorUsageUnits = {};
  if (!body || typeof body !== "object") return units;
  const data = body as Record<string, any>;
  const id =
    provider === "serpapi"
      ? data.search_metadata?.id
      : provider === "deepgram"
        ? data.metadata?.request_id
        : null;
  const validated =
    typeof id === "string" &&
    (provider === "serpapi"
      ? /^[a-f0-9]{24}$/i.test(id)
      : /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))
      ? id
      : null;
  if (validated) units.provider_request_id = validated;
  // Explicit billing fields only. Processed audio duration, input character
  // count, generated video duration and wall-clock latency are NOT billed units.
  const billed = data.usage ?? data.data?.usage;
  const seconds = quantity(billed?.billed_duration_seconds);
  const credits = quantity(billed?.billed_credits);
  const characters = quantity(billed?.billed_characters);
  if (seconds !== null)
    units[provider === "heygen" ? "billed_video_seconds" : "billed_audio_seconds"] = seconds;
  if (provider === "openai_direct" || provider === "openai_proxy" || provider === "azure_openai") {
    const durationUsage = data.usage?.type === "duration" ? quantity(data.usage.seconds) : null;
    if (durationUsage !== null) units.billed_audio_seconds = durationUsage;
  }
  if (credits !== null) units.provider_reported_credits = credits;
  if (characters !== null) units.billed_characters = characters;
  if (provider === "heygen") {
    const duration = quantity(data.data?.duration);
    if (duration !== null) units.provider_reported_video_seconds = duration;
    const videoId = data.data?.video_id ?? data.video_id;
    if (typeof videoId === "string" && /^[a-f0-9]{32}$/i.test(videoId))
      units.provider_video_id = videoId;
  }
  return units;
}
