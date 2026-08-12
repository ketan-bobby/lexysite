/**
 * pages/recruiter/interviews/room.tsx — AI Interview Room
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * The live interview room where a candidate takes an AI-proctored, video-
 * based interview. The AI interviewer asks questions, listens to spoken
 * answers via Web Speech API, and generates a full report at the end.
 * This page is accessed by candidates via a magic-link interview invite URL.
 *
 * ─── High-level flow ─────────────────────────────────────────────────────────
 *   1. Camera / microphone permission check → show PreCheck screen
 *   2. Load interview session (GET /api/interviews/:sessionId)
 *   3. Candidate clicks "Start" → session transitions to "in_progress"
 *   4. For each question:
 *      a. AI reads the question aloud (Web Speech TTS)
 *      b. Candidate speaks their answer
 *      c. Web Speech API transcribes speech → textarea
 *      d. Candidate confirms → answer stored in answers[]
 *   5. After all questions: POST /api/interviews/:sessionId/complete
 *      → backend stores transcript + triggers AI report generation
 *   6. "Thank you" screen shown; candidate can review their answers
 *
 * ─── Proctoring ──────────────────────────────────────────────────────────────
 * Proctoring events (tab switches, copy attempts, camera loss, face detection
 * anomalies) are recorded locally and submitted with the completion payload.
 * The proctor report is viewable by the recruiter at
 * /recruiter/interviews/:id/proctor-report.
 *
 * ─── Recording ───────────────────────────────────────────────────────────────
 * Optional video recording via MediaRecorder API. Chunks are uploaded to S3
 * using the multipart upload API (POST /api/objects/multipart/*) on completion.
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /interview/:sessionId  (no AppLayout — full-screen room UI)
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Mic, MicOff, Camera, CameraOff, Upload, CheckCircle2, Loader2,
  Play, AlertTriangle, Brain, ThumbsUp, Code2, ChevronRight, Terminal,
  ChevronLeft, RotateCcw, ChevronDown, VolumeX,
} from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn, pluralize } from "@/lib/utils";
import { authHeaders } from "@/lib/api";
import { reportClientError } from "@/lib/report-client-error";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
const DEFAULT_TOTAL_QUESTIONS = 8;

/* Maps short language keys (as stored in DB) → BCP-47 locale for Web Speech API.
   Full codes like "en-US", "es-MX" pass through unchanged. */
const LOCALE_MAP: Record<string, string> = {
  hi: "hi-IN", bn: "bn-IN", ta: "ta-IN", te: "te-IN", mr: "mr-IN",
  gu: "gu-IN", kn: "kn-IN", ml: "ml-IN", pa: "pa-IN", or: "or-IN",
  ur: "ur-PK", as: "as-IN", fr: "fr-FR", de: "de-DE", it: "it-IT",
  pt: "pt-BR", "pt-BR": "pt-BR", "pt-PT": "pt-PT", nl: "nl-NL", ru: "ru-RU", zh: "zh-CN", ja: "ja-JP",
  ko: "ko-KR", ar: "ar-SA", tr: "tr-TR", pl: "pl-PL", sv: "sv-SE",
  no: "nb-NO", da: "da-DK", fil: "fil-PH", tl: "fil-PH",
  id: "id-ID", ms: "ms-MY", th: "th-TH", vi: "vi-VN", he: "he-IL",
};
/* ── Browser-TTS fallback voice selection ──────────────────────────────────
   When cloud TTS (Azure/OpenAI) fails, we fall back to the browser's Web
   Speech voices. Lexy is a British woman, so we must deterministically pick a
   FEMALE voice and reuse the SAME voice for the rest of the session — otherwise
   the voice (and apparent gender) changes turn-to-turn, which is jarring. */
let cachedTtsVoice: SpeechSynthesisVoice | null | undefined;
const FEMALE_VOICE_HINTS = /(female|woman|libby|sonia|hazel|susan|samantha|victoria|zira|aria|jenny|fiona|karen|moira|tessa|serena|amy|emma|joanna|salli|kendra|kimberly|google uk english female)/i;
const MALE_VOICE_HINTS = /(\bmale\b|\bman\b|david|mark|george|guy|ryan|daniel|alex|fred|oliver|james|thomas|brian|arthur|google uk english male)/i;
// Choose a consistent (preferably female en-GB) browser TTS voice so the AI
// interviewer sounds the same across turns; result is memoised once voices load.
function pickStableTtsVoice(): SpeechSynthesisVoice | null {
  if (cachedTtsVoice !== undefined) return cachedTtsVoice;
  const ss = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  const voices = ss?.getVoices?.() ?? [];
  if (voices.length === 0) {
    /* Voices load asynchronously in some browsers. Warm them so the NEXT turn
       can pick a stable voice; don't cache a result yet. */
    if (ss && !ss.onvoiceschanged) ss.onvoiceschanged = () => { cachedTtsVoice = undefined; };
    return null;
  }
  const byPref = (list: SpeechSynthesisVoice[]) =>
    list.find(v => FEMALE_VOICE_HINTS.test(v.name)) ??
    list.find(v => !MALE_VOICE_HINTS.test(v.name)) ??
    null;
  const enGB = voices.filter(v => /^en-GB/i.test(v.lang));
  const enAny = voices.filter(v => /^en/i.test(v.lang));
  cachedTtsVoice = byPref(enGB) ?? byPref(enAny) ?? byPref(voices) ?? null;
  return cachedTtsVoice;
}

/* Detect when the candidate is trying to end the interview. Two tiers, because
   the speech-to-text transcript of a normal substantive ANSWER routinely
   contains phrases like "that's all", "nothing more", "we're done" or "I'm
   finished" — spoken about a project or job, not the interview. Treating those
   as a farewell ended interviews early at random question counts (one candidate
   got 2 questions, another 5, another the full 8). So:
   - STRONG signals are explicit and virtually never occur inside a real answer
     → they always close.
   - WEAK signals only close when the WHOLE utterance is short, i.e. the
     candidate is plainly signing off rather than using the words mid-answer. */
const STRONG_FAREWELL_RE = /\b(good\s?bye|end (?:the |this )?interview|that concludes (?:the |this )?interview)\b/i;
const WEAK_FAREWELL_RE = /\b(bye(?:\s?bye)?|see (?:you|ya)|that'?s (?:all|it|everything)|that is (?:all|it|everything)|i'?m (?:all )?done|i am done|i'?m finished|i'?m all set|nothing (?:else|more|further)|no (?:more|further) questions|we'?re done|let'?s (?:wrap|end)|wrap (?:it|this) up|i (?:have to|need to|gotta|got to)\s+(?:go|leave)\b(?!\s+to\b))\b/i;
const FAREWELL_WEAK_MAX_WORDS = 8;
function candidateWantsToEnd(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  if (STRONG_FAREWELL_RE.test(t)) return true;
  const words = t.split(/\s+/).filter(Boolean).length;
  return words <= FAREWELL_WEAK_MAX_WORDS && WEAK_FAREWELL_RE.test(t);
}

// Map an interview language code to a full BCP-47 speech locale (falls back to itself).
function resolveSpeechLocale(lang: string): string {
  return LOCALE_MAP[lang] ?? lang;
}

/* Mobile detection. On phones/tablets the browser Web Speech API cannot reliably
   capture the microphone while the interview's video MediaRecorder is also using
   it (iOS Safari especially), so these devices route listening through the server
   transcription endpoint instead. iPadOS reports as "Macintosh" — detect it via
   touch points. */
function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const iOS = /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && (navigator as any).maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const mobile = /Mobi|Mobile/.test(ua);
  return iOS || android || mobile;
}

/* Pick a recording container the current device actually supports. Android/Chrome
   yields webm/opus; iOS Safari only supports mp4/AAC. Empty string lets the
   browser choose its default. */
function pickAudioMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/aac",
  ];
  for (const c of candidates) {
    try { if (MediaRecorder.isTypeSupported(c)) return c; } catch { /* ignore */ }
  }
  return "";
}

/* Send one captured audio segment to the server STT endpoint (Azure → Whisper)
   and return the recognized text. Returns "" on any failure so the live loop
   simply keeps listening. */
async function transcribeSegment(sessionId: string, blob: Blob, lang: string, prompt?: string): Promise<string> {
  if (!blob || blob.size < 900) return "";
  const buf = await blob.arrayBuffer();
  /* The answer transcribed so far primes Whisper to continue honestly instead of
     hallucinating on a short/quiet clip. Strip to ASCII-safe header bytes (HTTP
     headers are latin1) and cap length. */
  const priming = (prompt || "").replace(/[\r\n]+/g, " ").trim().slice(-500);
  /* Session-scoped: the path-scoped interview cookie (minted by /begin after
     the consent gate) authenticates this upload server-side. */
  const res = await fetch(`${BASE}/api/interviews/${sessionId}/transcribe`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": blob.type || "audio/webm",
      "X-Language": resolveSpeechLocale(lang),
      ...(priming ? { "X-Prompt": encodeURIComponent(priming) } : {}),
      ...authHeaders(),
    },
    body: buf,
  });
  if (!res.ok) return "";
  const data = await res.json().catch(() => ({} as any));
  return ((data?.transcript as string) || "").trim();
}

/* Custom error so the UI can branch on a 401 step-up vs a 410 expired session. */
class ApiError extends Error {
  status: number;
  data: any;
  constructor(status: number, data: any) {
    super(typeof data?.error === "string" ? data.error : `API ${status}`);
    this.status = status;
    this.data = data ?? {};
  }
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    /* credentials: "include" sends the resumable interview-session cookie
       (lexy_iv_<sid>) on every candidate-facing call so the server can
       verify the HMAC + fingerprint binding it issued at /begin. */
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    ...opts,
  });
  if (!res.ok) {
    let body: any = {};
    try { body = await res.json(); } catch { /* non-JSON */ }
    throw new ApiError(res.status, body);
  }
  return res.json();
}

/* ── Layout ─────────────────────────────────────────────────────────────── */
// Branded full-screen shell for the interview room, with an optional overlay slot.
function RoomLayout({ children, overlay }: { children: React.ReactNode; overlay?: React.ReactNode }) {
  return (
    <div className="min-h-screen text-foreground flex flex-col">
      <header className="shrink-0 border-b border-border/40 px-5 py-2.5 flex items-center gap-3 bg-card/60 backdrop-blur z-10 sticky top-0">
        <span className="text-base font-black tracking-tight">L3<span className="text-primary">X</span>Y</span>
        <span className="text-xs text-muted-foreground font-medium">AI™</span>
        <span className="text-muted-foreground/30 mx-1">|</span>
        <span className="text-sm text-muted-foreground">AI Video Interview</span>
      </header>
      <div className="flex-1">{children}</div>
      {overlay}
    </div>
  );
}

/* ── Step-up OTP modal ───────────────────────────────────────────────────
   Shown when the server requires email-OTP verification (different device/
   browser, lost cookie, suspected takeover). Kept dependency-free (no shadcn
   Dialog) so it always renders even if the parent card unmounts. */
function StepUpModal(props: {
  stage: "sending" | "enter_code" | "verifying" | "error";
  message: string;
  sentTo: string;
  code: string;
  onCodeChange: (v: string) => void;
  onSubmit: () => void;
  onResend: () => void;
}) {
  const { stage, message, sentTo, code, onCodeChange, onSubmit, onResend } = props;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-border/60 bg-card p-6 space-y-4 shadow-2xl">
        <div className="space-y-1.5">
          <h2 className="text-lg font-black">Verify it's you</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            For security, we need to verify your identity before you can resume this interview from a new device or browser.
          </p>
        </div>
        {stage === "sending" && (
          <div className="flex items-center gap-3 rounded-lg bg-muted/30 p-3 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            Sending a verification code…
          </div>
        )}
        {(stage === "enter_code" || stage === "verifying") && (
          <>
            <p className="text-sm text-muted-foreground">
              We sent a 6-digit code to <span className="font-bold text-foreground">{sentTo}</span>. It expires in 10 minutes.
            </p>
            <input
              autoFocus
              inputMode="numeric"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => onCodeChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
              onKeyDown={(e) => { if (e.key === "Enter" && stage === "enter_code") onSubmit(); }}
              disabled={stage === "verifying"}
              className="w-full text-center text-2xl font-mono tracking-[0.4em] rounded-lg border border-border bg-background py-3 outline-none focus:border-primary disabled:opacity-50"
            />
            {message && (
              <p className="text-xs text-yellow-400">{message}</p>
            )}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onResend} disabled={stage === "verifying"} className="flex-1">
                Resend code
              </Button>
              <Button onClick={onSubmit} disabled={stage === "verifying" || code.length !== 6} className="flex-1 gap-2">
                {stage === "verifying" && <Loader2 className="w-4 h-4 animate-spin" />}
                Verify
              </Button>
            </div>
          </>
        )}
        {stage === "error" && (
          <>
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{message}</span>
            </div>
            <Button variant="outline" onClick={onResend} className="w-full">Try again</Button>
          </>
        )}
      </div>
    </div>
  );
}

// Human-friendly countdown ("2h 5m left" / "Expired") for the session window.
function formatHoursLeft(expiresAt: Date): string {
  const ms = expiresAt.getTime() - Date.now();
  if (ms <= 0) return "Expired";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 1) return `${h}h ${m}m left`;
  return `${m}m left`;
}

/* ── Webcam feed ─────────────────────────────────────────────────────────── */
// Mirrored self-view of the candidate's camera with a REC indicator while recording.
function WebcamView({ stream, isRecording }: { stream: MediaStream | null; isRecording: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && stream) {
      ref.current.srcObject = stream;
      ref.current.play().catch(() => {});
    }
  }, [stream]);

  return (
    <div className="relative w-full h-full bg-zinc-900 rounded-xl overflow-hidden">
      {stream
        ? <video ref={ref} muted autoPlay playsInline className="w-full h-full object-cover scale-x-[-1]" />
        : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-3">
            <CameraOff className="w-10 h-10 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">No camera</p>
          </div>
        )
      }
      {isRecording && (
        <div className="absolute top-3 left-3 flex items-center gap-1.5 bg-black/60 rounded-full px-2.5 py-1">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
          </span>
          <span className="text-[10px] text-white font-bold tracking-wide">REC</span>
        </div>
      )}
      <div className="absolute bottom-2 right-3">
        <span className="text-[10px] text-white/50 font-medium">You</span>
      </div>
    </div>
  );
}

/* ── AI Avatar ───────────────────────────────────────────────────────────── */
// Animated interviewer avatar reflecting the conversation state (idle/thinking/speaking/listening).
function AIAvatar({ state }: { state: "idle" | "thinking" | "speaking" | "listening" }) {
  return (
    <div className="relative flex flex-col items-center justify-center h-full gap-5">
      {/* Ripple rings when speaking */}
      {state === "speaking" && (
        <>
          <div className="absolute w-48 h-48 rounded-full border-2 border-primary/30 animate-ping" style={{ animationDuration: "1.5s" }} />
          <div className="absolute w-56 h-56 rounded-full border border-primary/15 animate-ping" style={{ animationDuration: "2s", animationDelay: "0.3s" }} />
        </>
      )}

      {/* Avatar photo */}
      <div className={cn(
        "relative w-40 h-40 rounded-full overflow-hidden transition-all duration-500 border-4",
        state === "speaking"  ? "border-primary shadow-[0_0_40px_12px] shadow-primary/30" : "",
        state === "thinking"  ? "border-primary/40 opacity-80" : "",
        state === "listening" ? "border-border/50" : "",
        state === "idle"      ? "border-border/30" : "",
      )}>
        <img
          src="/lexy-avatar.jpeg"
          alt="Lexy AI Interviewer"
          className="w-full h-full object-cover object-top"
        />
        {/* Thinking overlay */}
        {state === "thinking" && (
          <div className="absolute inset-0 bg-background/50 flex items-center justify-center">
            <Loader2 className="w-10 h-10 text-primary animate-spin" />
          </div>
        )}
      </div>

      {/* Sound bars when speaking */}
      {state === "speaking" && (
        <div className="flex items-end gap-0.5 h-6">
          {[4, 7, 11, 8, 14, 9, 5, 12, 7, 4, 10, 6].map((h, i) => (
            <div
              key={i}
              className="w-1 bg-primary rounded-full"
              style={{
                height: `${h}px`,
                animation: "soundBar 0.9s ease-in-out infinite",
                animationDelay: `${i * 0.07}s`,
              }}
            />
          ))}
        </div>
      )}

      <div className="text-center">
        <p className="font-bold text-sm">Lexy</p>
        <p className="text-xs text-muted-foreground">AI Interviewer · L3XY</p>
        <p className={cn("text-xs mt-1 transition-all", {
          "text-primary animate-pulse": state === "speaking",
          "text-muted-foreground/60 animate-pulse": state === "thinking",
          "text-emerald-400": state === "listening",
          "text-muted-foreground/40": state === "idle",
        })}>
          {state === "speaking"  ? "Speaking…" : ""}
          {state === "thinking"  ? "Thinking…" : ""}
          {state === "listening" ? "Listening to you" : ""}
          {state === "idle"      ? "Ready" : ""}
        </p>
      </div>
    </div>
  );
}

/* ── Transcript bubble ───────────────────────────────────────────────────── */
// Chat bubble for one AI/candidate turn; `live` shows a typing caret for in-progress text.
function TranscriptBubble({ role, text, live }: { role: "ai" | "candidate"; text: string; live?: boolean }) {
  if (!text) return null;
  return (
    <div className={cn("flex gap-2", role === "ai" ? "justify-start" : "justify-end")}>
      {role === "ai" && (
        <div className="shrink-0 w-6 h-6 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center mt-0.5">
          <span className="text-[8px] font-black text-primary">AI</span>
        </div>
      )}
      <div className={cn(
        "max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap",
        role === "ai"
          ? "bg-primary/10 border border-primary/20 text-foreground rounded-tl-sm"
          : "bg-muted/60 border border-border/40 text-foreground rounded-tr-sm",
        live && "border-dashed opacity-80",
      )}>
        {text}
        {live && <span className="inline-block w-1.5 h-3.5 bg-current ml-1 animate-pulse rounded-sm align-middle opacity-70" />}
      </div>
    </div>
  );
}

/* ── Score ring ──────────────────────────────────────────────────────────── */
// Circular gauge for the final interview score (green/amber/red by threshold).
// Final interview-score band (0–100 interview result; own cutoffs, not the match/fit band).
const RING_SCORE_STRONG = 80, RING_SCORE_MODERATE = 60;
function ScoreRing({ score }: { score: number }) {
  const color = score >= RING_SCORE_STRONG ? "#4ade80" : score >= RING_SCORE_MODERATE ? "#facc15" : "#fb7185";
  const c = 2 * Math.PI * 28;
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 72 72" className="w-20 h-20 -rotate-90">
        <circle cx="36" cy="36" r="28" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="5" />
        <circle cx="36" cy="36" r="28" fill="none" stroke={color} strokeWidth="5"
          strokeDasharray={`${(score / 100) * c} ${c}`} strokeLinecap="round" />
      </svg>
      <div>
        <div className="text-5xl font-black" style={{ color }}>{score}</div>
        <div className="text-xs text-muted-foreground mt-0.5">/100</div>
      </div>
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────────────────── */
type Phase = "loading" | "start" | "interview" | "uploading" | "done" | "error";
type ConvPhase = "thinking" | "speaking" | "listening" | "finished";

// Candidate-facing live AI interview room: orchestrates media capture, the
// speak/listen/think turn loop, proctoring, and final upload/scoring.
export default function InterviewRoom() {
  const [, params] = useRoute("/interviews/:id/room");
  const sessionId = params?.id ?? "";

  /* The candidate video interview is an intentionally dark, immersive surface.
     Force dark mode for the duration of the room regardless of the app-wide
     light/dark preference, then restore the previous theme on exit. */
  useEffect(() => {
    const root = document.documentElement;
    const hadDark = root.classList.contains("dark");
    root.classList.add("dark");
    return () => {
      if (!hadDark) root.classList.remove("dark");
    };
  }, []);

  const [phase,          setPhase]          = useState<Phase>("loading");
  const [convPhase,      setConvPhase]      = useState<ConvPhase>("thinking");
  const [plan,           setPlan]           = useState<any>(null);
  /* Interview language, readable from any closure without staleness. The
     session GET 401s ({needsBegin:true}) on a never-opened link, so `session`
     can legitimately be null when the candidate clicks Start — if callbacks
     read `session?.language` directly they silently fall back to "en-US" and
     a non-English interview gets routed to the browser's ENGLISH recognizer
     (fluent-but-wrong transcripts). All STT/TTS call sites read this ref;
     it is synced from session/plan state and set directly by the post-/begin
     refetch. */
  const interviewLangRef = useRef<string>("en-US");
  const [session,        setSession]        = useState<any>(null);
  /* Recruiter "smooth handover" intro: a recorded greeting shown on the start
     screen before Lexy takes over. null until resolved; mode "fallback" means
     no recruiter video on file (we simply don't render the intro block). */
  const [intro,          setIntro]          = useState<any>(null);
  const [introEnded,     setIntroEnded]     = useState(false);
  /* Autoplay-with-sound is blocked by every browser without a prior user
     gesture. To still start the recruiter greeting on its own we autoplay
     MUTED (always allowed) and surface a one-tap "unmute" overlay so the
     candidate can hear the voice. `introMuted` drives both. */
  const [introMuted,     setIntroMuted]     = useState(true);
  const introVideoRef = useRef<HTMLVideoElement | null>(null);
  const introPlayStartedRef = useRef(false);

  /* Try to start the intro the instant it can play. Attempt WITH sound first
     (works if the candidate already interacted with the page); on the
     autoplay-policy rejection, fall back to muted playback + the unmute
     prompt instead of stranding the candidate on a paused frame. `canplay`
     can fire repeatedly (re-buffering) — only run the kickoff once. */
  const handleIntroCanPlay = useCallback(() => {
    const v = introVideoRef.current;
    if (!v || introPlayStartedRef.current) return;
    introPlayStartedRef.current = true;
    v.muted = false;
    v.play()
      .then(() => setIntroMuted(false))
      .catch(() => {
        v.muted = true;
        setIntroMuted(true);
        v.play().catch(() => { /* even muted autoplay denied — controls remain */ });
      });
  }, []);

  /* One-tap unmute: re-run play() inside the click gesture so audio is allowed. */
  const handleIntroUnmute = useCallback(() => {
    const v = introVideoRef.current;
    if (!v) return;
    v.muted = false;
    setIntroMuted(false);
    v.play().catch(() => { /* ignore — user can use native controls */ });
  }, []);
  const [history,        setHistory]        = useState<{ role: "ai" | "candidate"; text: string }[]>([]);
  const [currentAiText,  setCurrentAiText]  = useState("");
  const [liveTranscript, setLiveTranscript] = useState("");
  const [questionNumber, setQuestionNumber] = useState(1);
  const [summary,        setSummary]        = useState<any>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [camError,       setCamError]       = useState(false);
  const [liveStream,     setLiveStream]     = useState<MediaStream | null>(null);

  /* AI + biometric (BIPA) consent gate. `consentRequired` is null until the
     session-scoped status check returns; the camera is NOT requested and the
     interview cannot start until it resolves to false (consent on file). */
  const [consentRequired, setConsentRequired] = useState<boolean | null>(null);
  const [consentDisclosure, setConsentDisclosure] = useState<any>(null);
  const [aiAgreed, setAiAgreed] = useState(false);
  const [bioAgreed, setBioAgreed] = useState(false);
  const [consentSaving, setConsentSaving] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [consentLoadError, setConsentLoadError] = useState(false);
  const [isRecording,    setIsRecording]    = useState(false);
  const [sttAvailable,   setSttAvailable]   = useState(false);
  const [useTextInput,   setUseTextInput]   = useState(false);
  /* Ref mirror of useTextInput so callbacks created before a state flip (e.g.
     aiTurn re-enabling voice right before startListening) see the live value. */
  const useTextInputRef = useRef(false);
  useEffect(() => { useTextInputRef.current = useTextInput; }, [useTextInput]);
  /* WHY the room fell back to typing. "nospeech" = the candidate simply didn't
     speak (or nothing transcribed) — that's a per-question condition, so the
     NEXT question returns to voice automatically. Anything else (mic hardware
     missing, recorder/recognition error, or the candidate chose typing) stays
     sticky for the rest of the interview. */
  const textModeReasonRef = useRef<"nospeech" | "sticky" | null>(null);
  /* ALWAYS use these two helpers to flip text mode — they keep the ref and the
     state in lockstep so a startListening call in the same tick sees the truth. */
  const enableTextInput = useCallback((reason: "nospeech" | "sticky") => {
    textModeReasonRef.current = reason;
    useTextInputRef.current = true;
    setUseTextInput(true);
  }, []);
  const disableTextInput = useCallback(() => {
    textModeReasonRef.current = null;
    useTextInputRef.current = false;
    setUseTextInput(false);
  }, []);
  const [micFallbackNotice, setMicFallbackNotice] = useState(false);
  /* True while handleDoneSpeaking is flushing the final STT segment + submitting,
     so the Send button shows a spinner and can't be double-tapped. */
  const [finalizing, setFinalizing] = useState(false);
  const [textAnswer,     setTextAnswer]     = useState("");
  const [micEnabled,     setMicEnabled]     = useState(true);
  const [camEnabled,     setCamEnabled]     = useState(true);

  // ── Programming interview state ───────────────────────────────────────────
  const [progChallengeIdx,   setProgChallengeIdx]   = useState(0);
  const [progCode,           setProgCode]           = useState<Record<string, string>>({});
  const [progLang,           setProgLang]           = useState("javascript");
  const [progSubmitting,     setProgSubmitting]     = useState(false);
  const [progSubmissions,    setProgSubmissions]    = useState<any[]>([]);
  const [progLastEval,       setProgLastEval]       = useState<any>(null);

  // ── Proctoring ───────────────────────────────────────────────────────────
  const [proctorEvents,  setProctorEvents]  = useState<{ type: string; detail: string; ts: string }[]>([]);
  const [showProctorLog, setShowProctorLog] = useState(false);

  /* ── Resumable session metadata ─────────────────────────────────────────
     `expiresAt` is the absolute deadline (set on first /begin, persisted on
     the server). `durationHours` is what /begin tells us — usually 24 — so
     we can label the banner without hard-coding it.
     Step-up state drives the OTP modal that appears when the server flips
     `step_up_required` (different fingerprint / new device / cookie lost). */
  const [expiresAt,        setExpiresAt]        = useState<Date | null>(null);
  const [durationHours,    setDurationHours]    = useState<number>(24);
  const [resumed,          setResumed]          = useState(false);
  const [stepUpOpen,       setStepUpOpen]       = useState(false);
  const [stepUpStage,      setStepUpStage]      = useState<"sending" | "enter_code" | "verifying" | "error">("sending");
  const [stepUpMessage,    setStepUpMessage]    = useState<string>("");
  const [stepUpSentTo,     setStepUpSentTo]     = useState<string>("");
  const [stepUpCode,       setStepUpCode]       = useState<string>("");
  const [sessionEnded,     setSessionEnded]     = useState<{ reason: "completed" | "expired"; expiresAt?: string } | null>(null);
  const snapshotTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const webcamVideoRef   = useRef<HTMLVideoElement | null>(null);

  const streamRef         = useRef<MediaStream | null>(null);
  const screenStreamRef   = useRef<MediaStream | null>(null);
  const recorderRef       = useRef<MediaRecorder | null>(null);
  const chunksRef         = useRef<Blob[]>([]);
  const uploadTokenRef    = useRef<string | null>(null); /* short-lived JWT for recording upload */
  const audioRef          = useRef<HTMLAudioElement | null>(null);
  /* Shared AudioContext that lives for the whole interview.
     Both Lexy's TTS clips and the mic feed into this context so that
     the MediaRecorder captures everything in one mixed stream. */
  const audioCtxRef       = useRef<AudioContext | null>(null);
  const recordingDestRef  = useRef<MediaStreamAudioDestinationNode | null>(null);
  /* Server-STT (mobile) listening: a SEPARATE mic-only MediaRecorder whose audio
     is segmented on silence and POSTed to /interviews/transcribe. Kept distinct
     from the mixed video-recording stream so it never captures Lexy's TTS. */
  const micRecRef            = useRef<MediaRecorder | null>(null);
  const micChunksRef         = useRef<Blob[]>([]);
  const serverSttActiveRef   = useRef(false);
  const segBusyRef           = useRef(false);
  const serverMimeRef        = useRef<string>("");
  /* Consecutive empty mobile STT segments — drives the typed-answer fallback */
  const emptySegCountRef     = useRef(0);
  const finalizeServerSttRef = useRef<(() => Promise<void>) | null>(null);
  const browserSTTRef     = useRef<any>(null);
  const transcriptRef     = useRef("");
  const historyRef        = useRef<{ role: "ai" | "candidate"; text: string }[]>([]);
  const questionNumRef    = useRef(1);
  const scrollRef         = useRef<HTMLDivElement>(null);
  const silenceTimerRef        = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceWarningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doneSpeakingRef        = useRef<(() => void) | null>(null);
  const convPhaseRef           = useRef<ConvPhase>("thinking");
  /* Work-authorization logistics: a SEPARATE, NON-SCORED step asked once at the
     very end of a job interview, just before the closing. The answer is sent to
     /work-auth (never save-turn) so it can never influence the interview score.
     workAuthDoneRef ensures it's asked at most once; workAuthActiveRef marks the
     window in which handleDoneSpeaking should route the answer to /work-auth;
     histBeforeWorkAuthRef preserves the assessed transcript so the work-auth
     exchange is never fed into the closing conversation. */
  const workAuthDoneRef        = useRef(false);
  const workAuthActiveRef      = useRef(false);
  const histBeforeWorkAuthRef  = useRef<{ role: "ai" | "candidate"; text: string }[]>([]);
  const [workAuthActive, setWorkAuthActive] = useState(false);
  const [silenceCountdown, setSilenceCountdown] = useState<number | null>(null);
  const [showSilenceWarning, setShowSilenceWarning] = useState(false);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sttActiveRef      = useRef(false);

  /* ── Mic level analyser ─────────────────────────────────────────────── */
  const analyserRef      = useRef<AnalyserNode | null>(null);
  const micCtxRef        = useRef<AudioContext | null>(null);
  /* When VAD reuses the shared (already user-gesture-resumed) recording context,
     don't close it in stopListening — only close a context we created ourselves. */
  const micCtxSharedRef  = useRef(false);
  const micSrcRef        = useRef<MediaStreamAudioSourceNode | null>(null);
  /* Guards handleDoneSpeaking against re-entrant taps / silence-timer overlap. */
  const doneInFlightRef  = useRef(false);
  /* Holds the in-flight save-turn DB write so it can run OFF the critical path
     (it doesn't gate the next AI turn — converse() gets the full history in its
     body). The closing path awaits this before /end so the last answer is
     always persisted before background scoring reads session.answers. */
  const pendingSaveTurnRef = useRef<Promise<unknown> | null>(null);
  const micAnimFrameRef  = useRef<number | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const startBtnRef      = useRef<HTMLButtonElement>(null);

  /* When the recruiter intro video finishes, the Start button often sits below
     the fold — bring it into view so the candidate sees the next step instead
     of feeling stuck on the video. */
  useEffect(() => {
    if (introEnded) {
      startBtnRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [introEnded]);

  /* keep refs in sync */
  useEffect(() => { historyRef.current = history; }, [history]);
  useEffect(() => { questionNumRef.current = questionNumber; }, [questionNumber]);
  useEffect(() => { convPhaseRef.current = convPhase; }, [convPhase]);

  /* STT support check. Listening works either via the browser Web Speech API
     (desktop) or via the server transcription endpoint, which only needs
     MediaRecorder + getUserMedia (covers mobile). Only force the text-input
     fallback when neither is available. */
  useEffect(() => {
    const hasBrowserSTT = !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
    const hasServerSTT  = typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
    const ok = hasBrowserSTT || hasServerSTT;
    setSttAvailable(ok);
    if (!ok) enableTextInput("sticky");
  }, [enableTextInput]);

  /* auto-scroll transcript */
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history, liveTranscript]);

  /* ── Step-up OTP flow ───────────────────────────────────────────────────
     Triggered whenever the server returns 401 with {stepUp:true}. We open
     the modal, immediately ask the server to email a code, then let the
     candidate enter it. On success we just close the modal — the next
     apiFetch will succeed because the cookie has been re-issued. */
  const startStepUp = useCallback(async () => {
    setStepUpOpen(true);
    setStepUpStage("sending");
    setStepUpMessage("");
    setStepUpCode("");
    try {
      const r = await apiFetch<{ sentTo?: string; expiresInMinutes?: number }>(
        `/interviews/${sessionId}/step-up/start`,
        { method: "POST" },
      );
      setStepUpSentTo(r.sentTo ?? "your email");
      setStepUpStage("enter_code");
    } catch (e: any) {
      const data = e?.data ?? {};
      if (data.error === "no_candidate_email") {
        setStepUpStage("error");
        setStepUpMessage(data.message ?? "We don't have an email on file for this candidate. Please contact the recruiter.");
      } else if (data.error === "step_up_locked") {
        setStepUpStage("error");
        setStepUpMessage("Too many failed attempts. Please contact the recruiter to reset your session.");
      } else {
        setStepUpStage("error");
        setStepUpMessage("We couldn't send the verification code. Please refresh and try again.");
      }
    }
  }, [sessionId]);

  const submitStepUpCode = useCallback(async () => {
    if (!/^\d{6}$/.test(stepUpCode)) {
      setStepUpMessage("Please enter the 6-digit code from your email.");
      return;
    }
    setStepUpStage("verifying");
    setStepUpMessage("");
    try {
      await apiFetch(`/interviews/${sessionId}/step-up/verify`, {
        method: "POST",
        body: JSON.stringify({ otp: stepUpCode }),
      });
      setStepUpOpen(false);
      setStepUpCode("");
    } catch (e: any) {
      const data = e?.data ?? {};
      if (data.error === "otp_incorrect") {
        setStepUpStage("enter_code");
        setStepUpMessage(`Code didn't match. ${data.attemptsRemaining ?? 0} attempts remaining.`);
      } else if (data.error === "otp_expired") {
        setStepUpStage("enter_code");
        setStepUpMessage("That code expired — request a new one.");
      } else if (data.error === "step_up_locked") {
        setStepUpStage("error");
        setStepUpMessage("Too many failed attempts. Please contact the recruiter.");
      } else {
        setStepUpStage("error");
        setStepUpMessage("Verification failed. Please refresh and try again.");
      }
    }
  }, [sessionId, stepUpCode]);

  /* Force the candidate back to the consent gate. Used whenever the server
     reports consent is missing/stale (412 AI_CONSENT_REQUIRED) — including
     MID-interview. Resetting `phase` to "start" is essential: the consent gate
     only renders on the start phase, so without this a mid-interview 412 would
     silently leave the candidate in the interview with no way to consent. We
     also clear the checkboxes so they must actively re-acknowledge. */
  const requireConsent = useCallback(() => {
    setConsentRequired(true);
    setAiAgreed(false);
    setBioAgreed(false);
    setPhase("start");
  }, []);

  /* Centralised handler for the candidate-facing API errors that all
     candidate routes can throw: 401 step_up_required → open OTP modal;
     410 session_completed/expired → terminal screen. Returns true if it
     handled the error so the caller can stop further work. */
  const handleApiError = useCallback((err: unknown): boolean => {
    if (!(err instanceof ApiError)) return false;
    const { status, data } = err;
    if (status === 401 && data?.stepUp) {
      void startStepUp();
      return true;
    }
    if (status === 410 && (data?.error === "session_completed" || data?.error === "session_expired")) {
      setSessionEnded({
        reason: data.error === "session_expired" ? "expired" : "completed",
        expiresAt: data.expiresAt,
      });
      setPhase("done");
      return true;
    }
    /* 412 AI_CONSENT_REQUIRED → the candidate has not consented to the current
       AI interview + biometric (BIPA) disclosure. This is a PUBLIC recruiter
       link (no portal login), so we surface the in-room consent gate rather
       than redirecting to the login-gated portal consent page (a dead end
       here). The disclosure was already fetched on mount. */
    if (status === 412 && data?.error === "AI_CONSENT_REQUIRED") {
      requireConsent();
      return true;
    }
    return false;
  }, [startStepUp, requireConsent]);

  /* Keep the language ref in lockstep with whatever loads first. */
  useEffect(() => {
    const l = session?.language || plan?.language;
    if (l) interviewLangRef.current = l;
  }, [session, plan]);

  /* load session */
  useEffect(() => {
    if (!sessionId) return;
    (async () => {
      try {
        const s = await apiFetch<any>(`/interviews/${sessionId}`);
        const p = await apiFetch<any>(`/interviews/plans/${s.planId}`);
        setSession(s);
        setPlan(p);
        setPhase("start");
      } catch (err) {
        /* If session has never been opened, the GET will return 401
           {needsBegin:true} — that's expected. Surface real terminal
           errors via the centralised handler. */
        if (err instanceof ApiError && err.data?.needsBegin) {
          setPhase("start");
          return;
        }
        if (handleApiError(err)) return;
        setPhase("start");
      }
    })();
  }, [sessionId, handleApiError]);

  /* Resolve the recruiter "smooth handover" intro independently of the session
     GET. This MUST run on initial load even when the session hasn't begun yet
     (the session GET 401s with {needsBegin:true} pre-/begin); the intro endpoint
     is intentionally ungated so the candidate sees the recruiter greeting on the
     start screen. Best-effort: failures just mean no recruiter video. */
  useEffect(() => {
    if (!sessionId) return;
    apiFetch<any>(`/interviews/${sessionId}/intro`)
      .then((iv) => setIntro(iv))
      .catch(() => setIntro({ mode: "fallback" }));
  }, [sessionId]);

  /* Step-up modal element — hoisted above all render branches so every phase
     return can reference `stepUpOverlay` without a temporal-dead-zone error. */
  const stepUpOverlay = stepUpOpen ? (
    <StepUpModal
      stage={stepUpStage}
      message={stepUpMessage}
      sentTo={stepUpSentTo}
      code={stepUpCode}
      onCodeChange={setStepUpCode}
      onSubmit={submitStepUpCode}
      onResend={startStepUp}
    />
  ) : null;

  /* Session-scoped consent status — resolves the candidate from the interview
     session (this is a public, no-login link) and tells us whether the AI +
     biometric disclosure still needs to be acknowledged for the current
     version. FAIL-CLOSED: a fetch failure must NOT unlock the camera/start
     screen — we surface an error + retry and keep consentRequired unresolved
     so getUserMedia never runs before consent is confirmed. */
  const loadConsentStatus = useCallback(async () => {
    if (!sessionId) return;
    setConsentLoadError(false);
    try {
      const s = await apiFetch<any>(`/interviews/${sessionId}/consent-status`);
      setConsentDisclosure(s?.disclosure ?? null);
      setConsentRequired(!!s?.required);
    } catch {
      setConsentLoadError(true);
    }
  }, [sessionId]);

  useEffect(() => { void loadConsentStatus(); }, [loadConsentStatus]);

  /* camera — only requested AFTER consent is confirmed (consentRequired===false).
     This guarantees no biometric capture (webcam) begins before the candidate
     has read the disclosure and granted the BIPA biometric release. */
  useEffect(() => {
    if (consentRequired !== false) return;
    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .then(stream => { streamRef.current = stream; setLiveStream(stream); })
      .catch(() => {
        setCamError(true);
        navigator.mediaDevices.getUserMedia({ audio: true })
          .then(s => { streamRef.current = s; })
          .catch(() => {});
      });
    return () => streamRef.current?.getTracks().forEach(t => t.stop());
  }, [consentRequired]);

  /* Guard against losing the recording: this flow keeps the entire video in
   * memory and only uploads it after the interview ends, so closing the tab
   * while recording or uploading destroys the footage. Warn the candidate with
   * a native confirm prompt before they navigate away. */
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isRecording || phase === "uploading") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isRecording, phase]);

  const toggleCamera = () => {
    streamRef.current?.getVideoTracks().forEach(t => { t.enabled = !t.enabled; });
    setCamEnabled(p => !p);
  };
  const toggleMic = () => {
    streamRef.current?.getAudioTracks().forEach(t => { t.enabled = !t.enabled; });
    setMicEnabled(p => !p);
  };

  /* recording — accepts the screen stream captured in the click handler */
  const startRecording = useCallback((screenStream: MediaStream | null) => {
    const micStream = streamRef.current;
    screenStreamRef.current = screenStream;

    /* ── Shared AudioContext + destination node ───────────────────────────
       One context lives for the entire interview. The mic feed and every
       TTS clip connect to it so the MediaRecorder picks up all audio. */
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const dest = ctx.createMediaStreamDestination();
    recordingDestRef.current = dest;

    /* Route mic audio into the recording destination */
    if (micStream) {
      try {
        const micAudioTracks = micStream.getAudioTracks();
        if (micAudioTracks.length > 0) {
          const micNode = ctx.createMediaStreamSource(new MediaStream(micAudioTracks));
          micNode.connect(dest);
        }
      } catch { /* mic routing failed — continue without mic in recording */ }
    }

    /* Video: prefer screen share, fall back to webcam */
    const videoTracks = screenStream?.getVideoTracks() ?? micStream?.getVideoTracks() ?? [];
    /* Audio: always use the mixed destination stream */
    const combinedStream = new MediaStream([
      ...videoTracks,
      ...dest.stream.getAudioTracks(),
    ]);

    chunksRef.current = [];
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? "video/webm;codecs=vp9,opus"
      : MediaRecorder.isTypeSupported("video/webm") ? "video/webm" : "video/mp4";
    try {
      const rec = new MediaRecorder(combinedStream, { mimeType: mime, videoBitsPerSecond: 1_500_000 });
      rec.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.start(3000);
      recorderRef.current = rec;
      setIsRecording(true);
    } catch (err) {
      console.error("[recording] MediaRecorder start failed", err);
    }
  }, []);

  const stopAndUpload = useCallback(async (): Promise<void> => {
    return new Promise(resolve => {
      const rec = recorderRef.current;
      if (!rec || rec.state === "inactive") { resolve(); return; }
      rec.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "video/webm" });
        /* Stop screen-share tracks */
        screenStreamRef.current?.getTracks().forEach(t => t.stop());
        screenStreamRef.current = null;
        /* Close the shared recording AudioContext */
        audioCtxRef.current?.close().catch(() => {});
        audioCtxRef.current = null;
        recordingDestRef.current = null;
        streamRef.current?.getTracks().forEach(t => t.stop());
        setLiveStream(null);
        setIsRecording(false);
        if (blob.size < 1000) { resolve(); return; }

        /* Auth for the upload: short-lived upload token for portal-less
           candidates, else the recruiter's own auth (session cookie in prod,
           DEV Bearer fallback via the shared helper). */
        const auth = (): Record<string, string> => {
          const t = uploadTokenRef.current;
          return t ? { Authorization: `Bearer ${t}` } : { ...authHeaders() };
        };

        /* Primary path: chunked S3 multipart upload (~5.5 MB parts). On a flaky
           mobile connection a dropped request only loses (and retries) a single
           chunk instead of forcing the entire multi-minute video to re-upload
           from scratch — which is exactly why single-blob uploads were failing on
           mobile data. The server completes the multipart object on the last
           chunk and attaches the recording pointer to the session in-request. */
        const uploadChunked = async (): Promise<{ objectPath: string; attached: boolean }> => {
          const CHUNK_SIZE = Math.ceil(5.5 * 1024 * 1024); // S3 requires >=5 MB parts (except the last)
          const totalChunks = Math.max(1, Math.ceil(blob.size / CHUNK_SIZE));
          const uploadId =
            (typeof crypto !== "undefined" && (crypto as any).randomUUID)
              ? crypto.randomUUID()
              : `${sessionId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
          let last: any = null;
          for (let i = 0; i < totalChunks; i++) {
            const part = blob.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, blob.size));
            let ok = false, partErr: any;
            /* Per-chunk retry — this is the resilience that makes mobile work. */
            for (let attempt = 1; attempt <= 4; attempt++) {
              try {
                if (attempt > 1) await new Promise(r => setTimeout(r, Math.pow(2, attempt - 1) * 1000));
                const fd = new FormData();
                fd.append("file", part, `interview-${sessionId}.webm`);
                fd.append("uploadId", uploadId);
                fd.append("chunkIndex", String(i));
                fd.append("totalChunks", String(totalChunks));
                fd.append("sessionId", sessionId);
                const ctrl = new AbortController();
                const to = setTimeout(() => ctrl.abort(), 2 * 60_000);
                let res: Response;
                try {
                  res = await fetch(`${BASE}/api/storage/uploads/recording/chunk`, {
                    method: "POST", headers: auth(), body: fd, signal: ctrl.signal,
                    credentials: "include", /* recruiter-preview: session cookie authenticates when no upload token */
                  });
                } finally { clearTimeout(to); }
                if (!res.ok) {
                  const t = await res.text().catch(() => "");
                  throw new Error(`chunk ${i + 1}/${totalChunks} failed (${res.status}): ${t.slice(0, 200)}`);
                }
                last = await res.json();
                ok = true;
                break;
              } catch (e: any) {
                partErr = e;
                console.warn("[interview] chunk upload attempt failed", { chunk: i + 1, totalChunks, attempt, err: e?.message });
              }
            }
            if (!ok) {
              /* Report only when ALL attempts for this chunk are exhausted —
                 per-attempt transient failures are retried and would be noise. */
              reportClientError("interview recording chunk upload exhausted retries", {
                sessionId, phase: "recording-upload:chunk",
                chunk: i + 1, totalChunks, err: (partErr as any)?.message,
              });
              throw partErr ?? new Error("chunk upload failed");
            }
            /* Reserve the final 10% for the attach/PATCH step. */
            setUploadProgress(Math.min(90, Math.round(((i + 1) / totalChunks) * 90)));
          }
          if (!last?.objectPath) throw new Error("chunked upload finished without an objectPath");
          return { objectPath: last.objectPath, attached: !!last.attached };
        };

        /* Fallback path: single-blob server-proxied POST (the previous behaviour).
           Used only if chunked upload fails outright. */
        const uploadSingle = async (): Promise<{ objectPath: string; attached: boolean }> => {
          setUploadProgress(10);
          const fd = new FormData();
          fd.append("sessionId", sessionId);
          fd.append("file", blob, `interview-${sessionId}.webm`);
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), 5 * 60_000);
          let res: Response;
          try {
            res = await fetch(`${BASE}/api/storage/uploads/recording`, {
              method: "POST", headers: auth(), body: fd, signal: ctrl.signal,
              credentials: "include",
            });
          } finally { clearTimeout(to); }
          setUploadProgress(70);
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            throw new Error(`Upload failed (${res.status}): ${txt.slice(0, 200)}`);
          }
          const json = await res.json();
          if (!json?.objectPath) throw new Error("Upload succeeded but no objectPath was returned");
          return { objectPath: json.objectPath, attached: !!json.attached };
        };

        /* The page stays in phase="uploading" throughout so the beforeunload
           guard keeps blocking navigation until the upload settles. */
        let result: { objectPath: string; attached: boolean } | null = null;
        let lastErr: any;
        try {
          result = await uploadChunked();
        } catch (err: any) {
          lastErr = err;
          console.warn("[interview] chunked upload failed — falling back to single-blob", { err: err?.message });
          reportClientError("interview recording chunked upload failed — falling back to single-blob", {
            sessionId, phase: "recording-upload:fallback", err: err?.message,
          });
          try {
            setUploadProgress(0);
            result = await uploadSingle();
            lastErr = null;
          } catch (err2: any) {
            lastErr = err2;
          }
        }

        if (result) {
          /* The upload route attaches the pointer in-request when it can
             authorize the caller for the session. Only fall back to the
             standalone PATCH when it didn't. */
          if (!result.attached) {
            try {
              await apiFetch(`/interviews/${sessionId}/recording`, {
                method: "PATCH",
                body: JSON.stringify({ objectPath: result.objectPath }),
              });
            } catch (err: any) {
              console.warn("[interview] recording pointer PATCH failed", { err: err?.message });
              /* Highest-value report: the footage IS in storage but nothing
                 points to it. objectPath lets an admin reattach it manually
                 via PATCH /interviews/:sessionId/recording. */
              reportClientError("interview recording pointer PATCH failed — footage uploaded but unattached", {
                sessionId, phase: "recording-upload:attach",
                objectPath: result.objectPath, err: err?.message,
              });
            }
          }
          setUploadProgress(100);
          console.info("[interview] recording uploaded", { sessionId, sizeKB: Math.round(blob.size / 1024), objectPath: result.objectPath });
        } else {
          /* All paths exhausted — surface to the user. */
          console.error("[interview] recording upload failed after all attempts", lastErr);
          reportClientError("interview recording upload failed after all attempts", {
            sessionId, phase: "recording-upload:total-failure",
            sizeKB: Math.round(blob.size / 1024), err: lastErr?.message,
          });
          setUploadProgress(0);
          if (typeof window !== "undefined") {
            alert(
              "Your interview recording could not be uploaded. " +
                "The interview transcript is safe and saved, but the video failed to upload. " +
                `Please contact support and reference session ${sessionId}.\n\n` +
                `Reason: ${lastErr?.message || "unknown error"}`,
            );
          }
        }
        resolve();
      };
      rec.stop();
    });
  }, [sessionId]);

  /* TTS — routed through the SHARED AudioContext so Lexy's voice is captured
     in the recording alongside the mic.  No per-clip AudioContext is created
     or destroyed; we reuse audioCtxRef for the whole interview lifetime.       */
  const speakText = useCallback((text: string): Promise<void> => {
    return new Promise(resolve => {
      audioRef.current?.pause();

      /* speakText MUST NEVER hang the interview. The opening turn awaits this
         before it opens the mic, so if the promise never settles the candidate is
         frozen on "Lexy is speaking…" forever (reported as "Lexy not responding").
         On iOS Safari a muted <audio> routed through a suspended AudioContext can
         fail to ever fire `onended`, so we guard every path with a watchdog. */
      let done = false;
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      const ttsAbort = new AbortController();
      const finish = () => {
        if (done) return;
        done = true;
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
        /* Cancel any in-flight TTS so a late response can't start audio AFTER the
           turn already advanced to listening (which would have Lexy talk over the
           candidate and contaminate the STT transcript). */
        try { ttsAbort.abort(); } catch { /* noop */ }
        resolve();
      };
      /* Pre-metadata safety net based on a rough speaking-rate estimate; tightened
         to the real clip length once metadata loads. */
      const estMs = Math.min(60000, Math.max(8000, text.length * 90 + 3000));
      watchdog = setTimeout(finish, estMs);

      const speakViaSynthesis = () => {
        try {
          if (done) return;                    /* turn already advanced */
          if (!window.speechSynthesis) return; /* watchdog resolves */
          const u = new SpeechSynthesisUtterance(text);
          u.lang = "en-GB";
          const pick = pickStableTtsVoice();
          if (pick) u.voice = pick;
          u.onend   = () => finish();
          u.onerror = () => finish();
          window.speechSynthesis.speak(u);
        } catch { /* watchdog resolves */ }
      };

      (async () => {
        try {
          const lang = interviewLangRef.current;
          const res = await fetch(`${BASE}/api/interviews/tts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, language: lang }),
            signal: ttsAbort.signal,
          });
          if (!res.ok) throw new Error("tts-failed");
          const blob = await res.blob();
          if (done) return; /* watchdog already advanced the turn — drop late audio */
          const url  = URL.createObjectURL(blob);
          const audio = new Audio(url);
          /* Start muted — Chrome always allows muted autoplay no matter how many
             async hops we are from the user gesture. Unmute once play() resolves
             so the candidate hears full-volume audio from the first frame. */
          audio.muted = true;
          audioRef.current = audio;

          /* Route through the shared recording AudioContext so Lexy's voice is
             captured in the MediaRecorder stream AND boosted for the speakers. */
          const ctx = audioCtxRef.current;
          if (ctx && ctx.state !== "closed") {
            try {
              if (ctx.state === "suspended") await ctx.resume();
              const src  = ctx.createMediaElementSource(audio);
              const gain = ctx.createGain();
              gain.gain.value = 1.3;
              src.connect(gain);
              gain.connect(ctx.destination);                 /* → speakers          */
              if (recordingDestRef.current) {
                gain.connect(recordingDestRef.current);      /* → MediaRecorder     */
              }
            } catch { /* Web Audio setup failed — audio still plays at unity gain */ }
          }

          audio.onended = () => { URL.revokeObjectURL(url); finish(); };
          audio.onerror = () => { URL.revokeObjectURL(url); finish(); };
          audio.onloadedmetadata = () => {
            if (Number.isFinite(audio.duration) && audio.duration > 0) {
              if (watchdog) clearTimeout(watchdog);
              watchdog = setTimeout(finish, audio.duration * 1000 + 3000);
            }
          };

          if (done) { try { audio.pause(); } catch { /* noop */ } URL.revokeObjectURL(url); return; }

          /* Do NOT await play() — on mobile its promise can stay pending; resolving
             the turn must not depend on it. Unmute when it settles; if autoplay is
             rejected (common on mobile through Web Audio), fall back to browser TTS
             so the candidate still hears Lexy. */
          const p = audio.play();
          if (p && typeof (p as any).then === "function") {
            (p as Promise<void>)
              .then(() => { audio.muted = false; })
              .catch(() => { audio.muted = false; speakViaSynthesis(); });
          } else {
            audio.muted = false;
          }
        } catch {
          speakViaSynthesis();
        }
      })();
    });
  }, [session, plan]);

  /* Clear silence timer + countdown + silence warning */
  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current)        { clearTimeout(silenceTimerRef.current);        silenceTimerRef.current = null; }
    if (countdownTimerRef.current)      { clearInterval(countdownTimerRef.current);      countdownTimerRef.current = null; }
    if (silenceWarningTimerRef.current) { clearTimeout(silenceWarningTimerRef.current);  silenceWarningTimerRef.current = null; }
    setSilenceCountdown(null);
    setShowSilenceWarning(false);
  }, []);

  /* STT — two paths feeding the SAME transcriptRef / doneSpeaking pipeline:
       • Desktop: browser Web Speech API (low-latency, free, multi-language).
       • Mobile : server transcription (Azure → Whisper). On phones the Web Speech
         API can't share the mic with the interview's video MediaRecorder, so it
         silently hears nothing — we capture a dedicated mic-only recorder, segment
         it on silence via the mic meter, and POST each segment to /transcribe.
     Falls back to text input when neither path can run.                          */
  const startListening = useCallback((language?: string) => {
    if (useTextInputRef.current) return;

    sttActiveRef.current = true;
    transcriptRef.current = "";
    setLiveTranscript("");
    clearSilenceTimer();

    const lang = language || plan?.language || "en-US";
    const SILENCE_MS        = 9000;  /* 9s after last speech → auto-submit. The timer re-arms on every detected word (interim results on desktop, VAD on the server-STT path), so this only counts TRUE trailing silence — 16s made every answer feel stuck. */
    const INITIAL_WAIT_MS   = 45000; /* 45s before first word — time to gather thoughts */
    const SILENCE_WARN_MS   = 8000;  /* 8s without speech → "Still there?" prompt */

    const armSilenceTimer = (ms = SILENCE_MS) => {
      clearSilenceTimer();
      let remaining = Math.ceil(ms / 1000);
      setSilenceCountdown(remaining);
      countdownTimerRef.current = setInterval(() => {
        remaining -= 1;
        setSilenceCountdown(remaining > 0 ? remaining : null);
      }, 1000);
      silenceTimerRef.current = setTimeout(() => {
        clearSilenceTimer();
        if (sttActiveRef.current && convPhaseRef.current === "listening" && doneSpeakingRef.current) {
          doneSpeakingRef.current();
        }
      }, ms);
    };

    /* 8-second warning: fires if the candidate hasn't spoken recently.
       Dismissed as soon as speech is detected.                           */
    const armSilenceWarning = () => {
      if (silenceWarningTimerRef.current) clearTimeout(silenceWarningTimerRef.current);
      silenceWarningTimerRef.current = setTimeout(() => {
        silenceWarningTimerRef.current = null;
        if (sttActiveRef.current && convPhaseRef.current === "listening") {
          setShowSilenceWarning(true);
          armSilenceWarning(); /* re-arm so it can repeat after another 8 s */
        }
      }, SILENCE_WARN_MS);
    };

    /* Shared "speech detected" handler — resets the warning + answer-complete
       timers. Used by both the browser-STT final-result handler and the
       mobile VAD loop. */
    const onSpeechDetected = () => {
      setShowSilenceWarning(false);
      armSilenceWarning();
      armSilenceTimer();
    };

    armSilenceWarning();
    armSilenceTimer(INITIAL_WAIT_MS);

    const SpeechRecognitionAPI =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    /* The browser Web Speech API is only reliable for English. For every other
       language (e.g. Portuguese) Chrome frequently ignores recognition.lang and
       falls back to its English model, producing fluent-but-wrong English text
       ("random sentences without any sense"). So we keep the fast/free browser
       path for English ONLY and route all other languages through the server
       transcription path (Whisper), which is far more accurate for non-English
       and matches the project STT policy. */
    const isEnglishStt = /^en(-|$)/i.test(lang);
    const useServerStt = isMobileDevice() || !SpeechRecognitionAPI || !isEnglishStt;

    /* ── Server transcription path (mobile + all non-English) ──────────── */
    if (useServerStt) {
      const stream = streamRef.current;
      if (!stream || stream.getAudioTracks().length === 0) { enableTextInput("sticky"); return; }

      serverSttActiveRef.current = true;
      const mime = pickAudioMime();
      serverMimeRef.current = mime;
      segBusyRef.current = false;
      emptySegCountRef.current = 0;

      const SEG_SILENCE_MS = 1000;   /* pause after speech → cut + transcribe a segment (lower = each chunk transcribes sooner in parallel, so less text is left to convert when the candidate finishes) */
      const MIN_SEG_MS     = 2500;   /* don't auto-cut on a brief pause until the segment has this much audio — short, hesitant early utterances merge into one longer clip instead of being sent to Whisper as tiny snippets (which it transcribes as confident gibberish). The final cut (handleDoneSpeaking) ignores this floor, so a genuinely short answer is never dropped. */
      const MAX_SEG_MS     = 25000;  /* hard cap so each segment stays within STT limits */
      const SPEAK_THRESH   = 9;      /* minimum mic RMS floor for voice — the effective
                                        threshold ADAPTS above this to the room's noise
                                        floor (fan/AC hum can sit above a fixed value,
                                        making the VAD believe the candidate never stops
                                        talking → answer timer resets forever and the
                                        interview never auto-advances). */
      const MAX_EMPTY_SEGS = 3;      /* this many empty transcriptions in a row → offer typing */
      let speaking = false;
      let lastVoiceAt = 0;
      let segStart = 0;
      let lastArm = Date.now();
      let lastSegText = "";
      /* True once the mic meter saw voice (rms > SPEAK_THRESH) during the CURRENT
         segment. Noise-only segments (cut at MAX_SEG_MS while the candidate is
         silent) are NOT sent to STT at all — Sarvam/Whisper fabricate fluent
         sentences from room noise, and those fabrications reset the answer
         timer and stall the interview. The FINAL cut still always transcribes. */
      let segHadVoice = false;
      /* Adaptive noise floor: falls quickly toward quiet readings, creeps up very
         slowly during loud ones (speech has natural gaps, so the floor keeps
         tracking the ambient hum even while the candidate talks). Voice is only
         counted when the level clearly exceeds the ambient floor. */
      let noiseFloor = SPEAK_THRESH;

      const startSegRecorder = () => {
        if (!serverSttActiveRef.current) return;
        try {
          const micStream = new MediaStream(stream.getAudioTracks());
          const rec = mime
            ? new MediaRecorder(micStream, { mimeType: mime })
            : new MediaRecorder(micStream);
          micChunksRef.current = [];
          rec.ondataavailable = e => { if (e.data && e.data.size > 0) micChunksRef.current.push(e.data); };
          rec.start();
          micRecRef.current = rec;
          segStart = Date.now();
          segHadVoice = false;
        } catch {
          serverSttActiveRef.current = false;
          enableTextInput("sticky");
        }
      };

      /* Stop the current mic recorder, transcribe the captured segment, append the
         text to the live transcript, then (unless final) start a fresh recorder. */
      const cutSegment = (isFinal: boolean): Promise<void> => new Promise<void>(resolve => {
        const rec = micRecRef.current;
        if (!rec || rec.state === "inactive" || segBusyRef.current) { resolve(); return; }
        segBusyRef.current = true;
        speaking = false;
        const hadVoice = segHadVoice;
        rec.onstop = async () => {
          const chunks = micChunksRef.current;
          micChunksRef.current = [];
          micRecRef.current = null;
          const blob = new Blob(chunks, { type: serverMimeRef.current || "audio/webm" });
          let gotText = false;
          try {
            /* Voice gate: a non-final segment with zero detected voice is pure
               room noise — skip STT entirely (it would only hallucinate) and
               count it as an empty segment. The final cut always transcribes so
               a soft-spoken answer below the meter threshold is never lost. */
            const text = (!isFinal && !hadVoice)
              ? ""
              : await transcribeSegment(sessionId, blob, lang, transcriptRef.current);
            /* Hallucination-repeat guard: on near-silent audio (candidate not
               speaking, only room noise) Sarvam/Whisper often fabricate the SAME
               plausible sentence for every segment. Drop a segment ONLY when it
               is an exact, normalized repeat of the IMMEDIATELY PREVIOUS
               segment and is ≥12 chars — a candidate restating a long sentence
               verbatim back-to-back with a silence gap in between is
               vanishingly rare, whereas it is the signature of STT
               hallucination on noise. Dropped repeats count as empty segments
               so a truly silent candidate escalates to the typed-input
               fallback instead of looping forever. */
            const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
            const normNew = text ? norm(text) : "";
            const isDupRepeat = normNew.length >= 12 && normNew === norm(lastSegText);
            if (text) lastSegText = text; /* track even dropped text so A,A,A chains stay detected */
            if (text && !isDupRepeat) {
              gotText = true;
              const merged = (transcriptRef.current ? transcriptRef.current + " " : "") + text;
              transcriptRef.current = merged;
              setLiveTranscript(merged);
              onSpeechDetected(); /* real words → treat as speech, reset answer-complete timer */
            }
          } catch { /* keep listening */ }
          segBusyRef.current = false;
          /* Track consecutive empty segments. If the mic keeps producing audio that
             transcribes to nothing — the candidate's mic genuinely isn't being heard —
             stop looping and offer the typed-answer fallback, mirroring the desktop
             no-speech path instead of silently submitting an empty answer. */
          if (gotText) {
            emptySegCountRef.current = 0;
          } else if (!isFinal) {
            emptySegCountRef.current += 1;
            if (emptySegCountRef.current >= MAX_EMPTY_SEGS && serverSttActiveRef.current) {
              serverSttActiveRef.current = false;
              clearSilenceTimer();
              if (micAnimFrameRef.current) { cancelAnimationFrame(micAnimFrameRef.current); micAnimFrameRef.current = null; }
              setMicLevel(0);
              setMicFallbackNotice(true);
              enableTextInput("nospeech"); /* per-question — voice returns next question */
              resolve();
              return;
            }
          }
          if (!isFinal && serverSttActiveRef.current && convPhaseRef.current === "listening") {
            startSegRecorder();
          }
          resolve();
        };
        try { rec.stop(); } catch { segBusyRef.current = false; resolve(); }
      });

      /* Called by handleDoneSpeaking before it reads the answer: flush whatever is
         still being recorded so the final utterance is transcribed. Wait out any
         segment transcription already in flight (so its text lands first), then
         cut the current recorder. */
      finalizeServerSttRef.current = async () => {
        serverSttActiveRef.current = false;
        const start = Date.now();
        while (segBusyRef.current && Date.now() - start < 8000) {
          await new Promise(r => setTimeout(r, 100));
        }
        await cutSegment(true);
      };

      startSegRecorder();

      /* Mic meter + voice-activity detection drives both the visible level bar and
         the silence-based segmentation. */
      try {
        /* Reuse the shared recording AudioContext when it's alive — it was
           created/resumed inside the interview-start user gesture, so its
           analyser actually receives samples. A fresh AudioContext created
           here (outside a gesture) stays "suspended" on iOS Safari, the VAD
           reads silence forever, segments never auto-cut, and speech-to-text
           silently does nothing. */
        let ctx = audioCtxRef.current;
        if (ctx && ctx.state !== "closed") {
          micCtxSharedRef.current = true;
        } else {
          ctx = new AudioContext();
          micCtxSharedRef.current = false;
        }
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        micCtxRef.current = ctx;
        const src      = ctx.createMediaStreamSource(stream);
        micSrcRef.current = src;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.75;
        src.connect(analyser);
        analyserRef.current = analyser;
        const dataArr = new Uint8Array(analyser.frequencyBinCount);
        const poll = () => {
          if (!analyserRef.current) return;
          analyserRef.current.getByteFrequencyData(dataArr);
          const rms = Math.sqrt(dataArr.reduce((s: number, v: number) => s + v * v, 0) / dataArr.length);
          setMicLevel(rms);
          const now = Date.now();
          /* Track the ambient floor: drop fast toward quieter readings, creep up
             slowly during louder ones. Voice = clearly above the floor. */
          noiseFloor = rms < noiseFloor ? noiseFloor * 0.7 + rms * 0.3 : Math.min(noiseFloor * 1.002, 40);
          const voiceThresh = Math.max(SPEAK_THRESH, noiseFloor * 1.6 + 3);
          if (rms > voiceThresh) {
            speaking = true;
            segHadVoice = true;
            lastVoiceAt = now;
            /* throttle timer re-arming to ~1/s so the countdown stays smooth and
               never fires mid-answer during continuous speech */
            if (now - lastArm > 1000) { lastArm = now; onSpeechDetected(); }
          } else if (speaking && now - lastVoiceAt > SEG_SILENCE_MS && !segBusyRef.current && now - segStart >= MIN_SEG_MS) {
            /* Only auto-cut once the segment has accumulated enough audio. A brief
               pause after a short utterance leaves the recorder running so the
               next words merge into the same (longer) clip — Whisper transcribes
               longer clips accurately and stops hallucinating on tiny snippets. */
            cutSegment(false);
          }
          if (!segBusyRef.current && micRecRef.current && now - segStart > MAX_SEG_MS) {
            cutSegment(false); /* long segment → cut even mid-speech to stay under STT limit */
          }
          micAnimFrameRef.current = requestAnimationFrame(poll);
        };
        micAnimFrameRef.current = requestAnimationFrame(poll);
      } catch {
        /* Web Audio unavailable — no VAD segmentation; the answer-complete timer
           and the manual "Done" button still finalize via finalizeServerSttRef. */
      }
      return;
    }

    /* ── Desktop: browser Web Speech API path ──────────────────────────── */
    let accumulated = "";
    let lastInterimArm = 0;

    const recognition = new SpeechRecognitionAPI();
    recognition.lang = resolveSpeechLocale(lang);
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    browserSTTRef.current = recognition;

    recognition.onresult = (event: any) => {
      if (!sttActiveRef.current) return;
      let interimText = "";
      let finalText   = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText   += t;
        else                          interimText += t;
      }
      /* Fold any final chunk into the running answer FIRST, then build the live
         view as accumulated + the remaining interim tail. Doing it in this order
         means a single event carrying BOTH final and interim text keeps the
         interim tail instead of dropping it. */
      if (finalText) {
        accumulated += (accumulated ? " " : "") + finalText.trim();
      }
      if (interimText || finalText) {
        const combined = accumulated + (accumulated && interimText ? " " : "") + interimText;
        const display = combined || accumulated;
        setLiveTranscript(display);
        /* Keep the answer source in sync with what's shown. If the turn ends
           mid-utterance (silence timer fires, or the candidate taps Send) before
           Chrome promotes the current words to a "final" result, transcriptRef
           still holds the trailing interim text instead of dropping it — fixes
           "parts of my answer weren't in the transcription". */
        transcriptRef.current = display;
      }
      if (finalText) {
        onSpeechDetected(); /* dismiss "still there?" + reset silence windows */
      } else if (interimText) {
        /* Interim words mean the candidate is actively speaking RIGHT NOW. Chrome
           streams interim results continuously during a long answer and only marks
           a chunk "final" after a pause, so without this the 16s answer-complete
           timer (armed at listen-start, only reset on final results) would fire
           mid-sentence and cut the candidate off. Re-arm on interim too, throttled
           to ~1/s so the countdown stays smooth and the interval isn't rebuilt on
           every partial result. */
        const now = Date.now();
        if (now - lastInterimArm > 1000) { lastInterimArm = now; onSpeechDetected(); }
      }
    };

    recognition.onerror = (event: any) => {
      if (!sttActiveRef.current) return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        sttActiveRef.current = false;
        clearSilenceTimer();
        enableTextInput("sticky");
      }
      /* no-speech / network / audio-capture → silence timer will handle it */
    };

    recognition.onend = () => {
      /* Browser stops recognition after a pause — restart automatically if still listening */
      if (sttActiveRef.current && convPhaseRef.current === "listening") {
        try { recognition.start(); } catch { /* already restarting */ }
      }
    };

    try {
      recognition.start();
    } catch {
      enableTextInput("sticky");
    }

    /* ── Real-time mic level meter ─────────────────────────────────────
       Feeds the existing audio stream through an AnalyserNode so the
       candidate can see their voice is being picked up.               */
    if (streamRef.current) {
      try {
        const ctx = new AudioContext();
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        micCtxRef.current = ctx;
        const src      = ctx.createMediaStreamSource(streamRef.current);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.75;
        src.connect(analyser);
        analyserRef.current = analyser;
        const dataArr = new Uint8Array(analyser.frequencyBinCount);
        const poll = () => {
          if (!analyserRef.current) return;
          analyserRef.current.getByteFrequencyData(dataArr);
          const rms = Math.sqrt(dataArr.reduce((s: number, v: number) => s + v * v, 0) / dataArr.length);
          setMicLevel(rms);
          micAnimFrameRef.current = requestAnimationFrame(poll);
        };
        micAnimFrameRef.current = requestAnimationFrame(poll);
      } catch { /* Web Audio unavailable — meter just stays at 0 */ }
    }
  }, [plan, useTextInput, clearSilenceTimer]);

  const stopListening = useCallback(() => {
    sttActiveRef.current = false;
    serverSttActiveRef.current = false;
    clearSilenceTimer();
    try { browserSTTRef.current?.stop(); } catch {}
    browserSTTRef.current = null;
    /* tear down the mobile mic-only STT recorder */
    try { micRecRef.current?.stop(); } catch {}
    micRecRef.current = null;
    micChunksRef.current = [];
    segBusyRef.current = false;
    finalizeServerSttRef.current = null;
    /* tear down mic level analyser */
    if (micAnimFrameRef.current) { cancelAnimationFrame(micAnimFrameRef.current); micAnimFrameRef.current = null; }
    try { micSrcRef.current?.disconnect(); } catch {}
    micSrcRef.current = null;
    /* Only close a context we own — never the shared recording context. */
    if (!micCtxSharedRef.current) { micCtxRef.current?.close().catch(() => {}); }
    micCtxRef.current = null;
    micCtxSharedRef.current = false;
    analyserRef.current = null;
    setMicLevel(0);
  }, [clearSilenceTimer]);

  /* Interrupt Lexy — stop audio and switch to listening immediately.
     NOTE: do NOT close audioCtxRef here — it's the shared recording context
     and must stay alive until stopAndUpload() is called at interview end. */
  const handleInterrupt = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setConvPhase("listening");
    setLiveTranscript("");
    transcriptRef.current = "";
    startListening(interviewLangRef.current);
  }, [startListening, session, plan]);

  /* Core loop: AI generates → speaks → then listens */
  const totalQuestions = (session as any)?.totalQuestions || (plan as any)?.questions?.length || DEFAULT_TOTAL_QUESTIONS;
  const aiTurn = useCallback(async (hist: { role: "ai" | "candidate"; text: string }[], qNum: number) => {
    setConvPhase("thinking");
    /* End the interview when we've run out of questions OR when the candidate
       has signalled they want to wrap up (said goodbye / "that's all"). The
       backend ALSO detects farewell intent and echoes it back via isClosing,
       so we honour whichever side sees it first. */
    const lastCandidateText = [...hist].reverse().find(h => h.role === "candidate")?.text ?? "";
    let isClosing = qNum > totalQuestions || candidateWantsToEnd(lastCandidateText);

    /* ── Work-authorization logistics (SEPARATE, NON-SCORED) ──────────────────
       The assessed conversation NEVER asks about work authorization (the EEO
       guardrail forbids it). Instead, the moment the interview would close, we
       ask two lawful work-eligibility logistics questions once, as a clearly
       separate step. The answer goes to /work-auth (never save-turn), so it
       cannot affect the score, transcript, or recommendation. Only for a real,
       linked candidate — demo / unlinked sessions skip it entirely. */
    if (isClosing && !workAuthDoneRef.current
        && (session as any)?.candidateId && (session as any).candidateId !== "demo") {
      try {
        const { text: waText } = await apiFetch<{ text: string }>(`/interviews/${sessionId}/work-auth-prompt`);
        histBeforeWorkAuthRef.current = hist;          // preserve assessed transcript for the real close
        workAuthActiveRef.current = true;
        setWorkAuthActive(true);
        const waHist = [...hist, { role: "ai" as const, text: waText }];
        setHistory(waHist);
        historyRef.current = waHist;
        setCurrentAiText(waText);
        setConvPhase("speaking");
        await speakText(waText);
        /* Open the mic to capture the answer (same settle delay as normal turns). */
        noSpeechCountRef.current = 0;
        setConvPhase("thinking");
        convPhaseRef.current = "thinking";
        await new Promise(r => setTimeout(r, 700));
        convPhaseRef.current = "listening";
        setConvPhase("listening");
        setLiveTranscript("");
        transcriptRef.current = "";
        startListening(interviewLangRef.current);
        return;
      } catch {
        /* If the prompt can't be fetched, don't block the interview — mark the
           step done and fall through to the normal closing. */
        workAuthActiveRef.current = false;
        setWorkAuthActive(false);
        workAuthDoneRef.current = true;
      }
    }

    try {
      let text: string;
      try {
        const r = await apiFetch<{ text: string; isClosing: boolean }>(`/interviews/${sessionId}/converse`, {
          method: "POST",
          body: JSON.stringify({ history: hist, questionNumber: qNum, totalQuestions }),
        });
        text = r.text;
        if (r.isClosing) isClosing = true;
      } catch (err) {
        if (handleApiError(err)) return;   /* step-up modal will recover; the candidate can retry */
        throw err;
      }

      const newHist = [...hist, { role: "ai" as const, text }];
      setHistory(newHist);
      historyRef.current = newHist;
      setCurrentAiText(text);

      setConvPhase("speaking");
      await speakText(text);

      if (isClosing) {
        setConvPhase("finished");
        convPhaseRef.current = "finished";
        setPhase("uploading");
        /* Fetch a short-lived upload token BEFORE stopping the recorder.
           The interview cookie is path-scoped and cleared by /end, so it
           never reaches /storage/uploads/recording. Candidate portal users
           have no localStorage JWT token. This token is fetched while the
           cookie is still valid and stored in uploadTokenRef for the upload. */
        try {
          const tok = await apiFetch<any>(`/interviews/${sessionId}/upload-token`, { method: "POST" });
          if (tok?.uploadToken) uploadTokenRef.current = tok.uploadToken;
        } catch { /* best-effort — recruiters with localStorage token don't need it */ }
        /* Call /end BEFORE starting the upload. /end marks the session as
           "completed" in the DB, which the server-side session-capability auth
           check requires before it will accept an unauthenticated recording
           upload (candidates with no portal account have no Bearer token).
           /end is fast; the upload is the slow part, so firing stopAndUpload()
           in the background after /end still keeps the UI responsive. */
        /* /end now returns immediately ({ status: "processing" }) and the
           expensive AI evaluation runs in the background job queue. We only
           need the side effect (session marked "completed" so the recording
           upload is authorized); the recruiter-facing summary is fetched later
           via GET /interviews/:id/summary. */
        /* The turn saves run in the background (off the critical path), chained
           so they finish in order. Drain the chain before /end triggers
           background scoring, or the final answer could be missing from
           session.answers — but cap the wait so a hung save can never block
           interview completion / the recording upload. */
        try {
          await Promise.race([
            pendingSaveTurnRef.current ?? Promise.resolve(),
            new Promise((r) => setTimeout(r, 4000)),
          ]);
        } catch {}
        try {
          await apiFetch<any>(`/interviews/${sessionId}/end`, { method: "POST" });
        } catch (err) {
          /* /end re-checks AI consent per-request (412 AI_CONSENT_REQUIRED if
             revoked mid-interview) and can also demand step-up (401). Route
             through handleApiError so requireConsent()/startStepUp() run —
             swallowing it would leave the session un-finalized server-side
             while the UI showed "done". Other errors stay best-effort: the
             upload path must not be blocked by a transient /end failure. */
          if (handleApiError(err)) return;
        }
        /* Upload keeps phase="uploading" until it finishes so the beforeunload
           guard blocks navigation and prevents aborting a slow upload. The
           session is already completed so the server capability check will pass. */
        stopAndUpload().finally(() => setPhase("done"));
      } else {
        noSpeechCountRef.current = 0;
        /* ── 900ms settling delay ─────────────────────────────────────────
           After TTS audio ends, the room's acoustics (and browser audio
           pipeline) need a moment to decay before we open the microphone.
           Without this delay, residual speaker echo gets picked up by STT
           and submitted as the candidate's answer.                         */
        setConvPhase("thinking"); /* brief "thinking" while mic settles */
        convPhaseRef.current = "thinking";
        await new Promise(r => setTimeout(r, 700));
        /* If the last question fell back to typing only because the candidate
           didn't speak, give voice another chance on this new question. Mic
           hardware failures and explicit "type instead" choices stay in text. */
        if (useTextInputRef.current && textModeReasonRef.current === "nospeech") {
          disableTextInput();
          setMicFallbackNotice(false);
        }
        /* Now safe to open the mic */
        convPhaseRef.current = "listening";
        setConvPhase("listening");
        setLiveTranscript("");
        transcriptRef.current = "";
        startListening(interviewLangRef.current);
      }
    } catch {
      noSpeechCountRef.current = 0;
      if (useTextInputRef.current && textModeReasonRef.current === "nospeech") {
        disableTextInput();
        setMicFallbackNotice(false);
      }
      convPhaseRef.current = "listening";
      setConvPhase("listening");
      startListening(interviewLangRef.current);
    }
  }, [sessionId, speakText, stopAndUpload, startListening, session, plan]);

  /* ── Proctoring: log event to backend + local state ─────────────────────── */
  const logProctorEvent = useCallback(async (type: string, detail: string) => {
    const entry = { type, detail, ts: new Date().toISOString() };
    setProctorEvents(prev => [...prev, entry]);
    try {
      await apiFetch(`/interviews/${sessionId}/proctor-event`, {
        method: "POST",
        body: JSON.stringify({ type, detail }),
      });
    } catch {}
  }, [sessionId]);

  /* Tab-switch detection — active from lobby onwards */
  useEffect(() => {
    /* Only log during the lobby + live interview — post-interview phases
       (uploading/done/error) must not feed the proctoring integrity score. */
    if (phase !== "start" && phase !== "interview") return;
    const handleVisibility = () => {
      if (document.hidden) {
        /* Log silently — no disruptive overlay shown to the candidate */
        logProctorEvent("tab_switch", "Candidate switched away from interview tab");
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [phase, logProctorEvent]);

  /* Copy/Paste detection — active during interview */
  useEffect(() => {
    if (phase !== "interview") return;
    const onCopy = (e: ClipboardEvent) => {
      /* Block copy from the interview page (don't let candidates share questions) */
      e.preventDefault();
      logProctorEvent("copy", "Candidate attempted to copy content");
    };
    const onPaste = (e: ClipboardEvent) => {
      /* Allow paste so candidates can still type answers, but flag + log it */
      logProctorEvent("paste", "Candidate pasted content into answer field");
    };
    const onContextMenu = () => {
      /* Allow right-click but log it as a proctoring signal */
      logProctorEvent("right_click", "Candidate opened context menu");
    };
    document.addEventListener("copy",        onCopy);
    document.addEventListener("paste",       onPaste);
    document.addEventListener("contextmenu", onContextMenu);
    return () => {
      document.removeEventListener("copy",        onCopy);
      document.removeEventListener("paste",       onPaste);
      document.removeEventListener("contextmenu", onContextMenu);
    };
  }, [phase, logProctorEvent]);

  /* Periodic webcam snapshot + AI face analysis every 30s during interview */
  useEffect(() => {
    if (phase !== "interview" || !liveStream) {
      if (snapshotTimerRef.current) { clearInterval(snapshotTimerRef.current); snapshotTimerRef.current = null; }
      return;
    }

    const captureSnapshot = async () => {
      try {
        const vid = document.createElement("video");
        vid.srcObject = liveStream;
        vid.muted = true;
        await new Promise<void>(resolve => {
          vid.onloadedmetadata = () => { vid.play(); resolve(); };
        });
        await new Promise(r => setTimeout(r, 200)); // let frame render
        const canvas = document.createElement("canvas");
        canvas.width  = 320;
        canvas.height = 240;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(vid, 0, 0, 320, 240);
        vid.pause();
        const dataUrl    = canvas.toDataURL("image/jpeg", 0.6);
        const base64     = dataUrl.split(",")[1];
        const entry = { type: "snapshot", detail: "Periodic face check", ts: new Date().toISOString() };
        setProctorEvents(prev => [...prev, entry]);
        await apiFetch(`/interviews/${sessionId}/proctor-event`, {
          method: "POST",
          body: JSON.stringify({ type: "snapshot", detail: "Periodic face check", snapshotBase64: base64 }),
        });
      } catch {}
    };

    captureSnapshot(); // immediate on interview start
    snapshotTimerRef.current = setInterval(captureSnapshot, 30_000);
    return () => { if (snapshotTimerRef.current) { clearInterval(snapshotTimerRef.current); snapshotTimerRef.current = null; } };
  }, [phase, liveStream, sessionId]);

  /* Begin interview — getDisplayMedia MUST be the very first async call so
     Chrome counts it as a direct response to the user's click gesture.       */
  const handleBegin = useCallback(async () => {
    /* ── 1. Request screen share ────────────────────────────────────────
       Ask for the full screen (preferably).  If the user cancels or the
       browser blocks it we fall back to webcam-only recording silently. */
    let screenStream: MediaStream | null = null;
    /* getDisplayMedia (full-screen capture) exists only on desktop browsers —
       iOS Safari / Android Chrome don't implement it, so attempting it there
       just throws. Guard on support so mobile silently uses webcam-only and we
       never block the start on an unsupported prompt. */
    if (navigator.mediaDevices?.getDisplayMedia) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: "monitor" } as any,
          audio: false,   /* we capture audio via the shared AudioContext */
        });
      } catch {
        /* User cancelled or no permission — webcam fallback handled in startRecording */
      }
    }

    /* Confirm eligibility + consent with the server BEFORE any biometric
       capture (webcam recording) starts. The inline consent gate already
       blocks the Start button, but this is defense-in-depth: if /begin returns
       412 (consent missing/stale), we surface the in-room consent gate instead
       of recording first. We deliberately do NOT redirect to the portal login
       page — this is a public recruiter link and the candidate has no portal
       session. */
    try {
      const r = await apiFetch<any>(`/interviews/${sessionId}/begin`, { method: "POST" });
      if (r?.expiresAt) setExpiresAt(new Date(r.expiresAt));
      if (typeof r?.durationHours === "number") setDurationHours(r.durationHours);
      if (r?.resumed) setResumed(true);
      /* /begin returns the full session row — take the language from it
         immediately so even if the refetch below fails, STT/TTS never fall
         back to English on a non-English interview. */
      if (r?.language) interviewLangRef.current = r.language;
      /* On a NEVER-opened link the pre-/begin session GET 401s ({needsBegin})
         so `session`/`plan` are still null here. Re-fetch them now that /begin
         has minted the interview cookie — the interview LANGUAGE lives on the
         session, and without it every startListening call falls back to
         "en-US" and a non-English interview is transcribed by the browser's
         English recognizer as fluent gibberish. Setting the ref directly
         (not just state) means the aiTurn closure captured by THIS click
         still sees the right language. Best-effort: a failure here must not
         block the interview. */
      if (!session) {
        try {
          const s = await apiFetch<any>(`/interviews/${sessionId}`);
          setSession(s);
          if (s?.language) interviewLangRef.current = s.language;
          if (s?.planId) {
            try {
              const p = await apiFetch<any>(`/interviews/plans/${s.planId}`);
              setPlan(p);
              if (!s?.language && p?.language) interviewLangRef.current = p.language;
            } catch { /* plan is optional here */ }
          }
        } catch { /* proceed — language ref keeps its current value */ }
      }
    } catch (err) {
      /* Stop the screen-share we just acquired so nothing keeps capturing. */
      screenStream?.getTracks().forEach(t => t.stop());
      if (err instanceof ApiError && err.status === 412) {
        await loadConsentStatus();
        requireConsent();
        return;
      }
      handleApiError(err);
      return;
    }
    setPhase("interview");
    setConvPhase("thinking");
    startRecording(screenStream);
    await aiTurn([], 1);
  }, [sessionId, session, startRecording, aiTurn, handleApiError, loadConsentStatus, requireConsent]);

  /* ── End interview (used by programming + other) ────────────────────── */
  const handleEnd = useCallback(async () => {
    setPhase("uploading");
    try { await apiFetch(`/interviews/${sessionId}/end`, { method: "POST" }); } catch (err) { handleApiError(err); }
    setPhase("done");
  }, [sessionId, handleApiError]);

  /* ── Programming interview handlers ─────────────────────────────────── */
  const handleBeginProgramming = useCallback(async () => {
    try {
      const r = await apiFetch<any>(`/interviews/${sessionId}/begin`, { method: "POST" });
      if (r?.expiresAt) setExpiresAt(new Date(r.expiresAt));
      if (typeof r?.durationHours === "number") setDurationHours(r.durationHours);
      if (r?.resumed) setResumed(true);
    } catch (err) {
      /* 412 = consent required → show the in-room consent gate (no portal
         redirect on this public link); other errors via the shared handler. */
      if (err instanceof ApiError && err.status === 412) {
        await loadConsentStatus();
        requireConsent();
        return;
      }
      handleApiError(err);
      return;
    }
    setPhase("interview");
    const qs = (plan?.questions as any[]) ?? [];
    if (qs.length > 0) {
      const starter = qs[0]?.starterCode?.javascript ?? "// Write your solution here\n";
      setProgCode({ [qs[0].id]: starter });
    }
  }, [sessionId, plan, handleApiError, loadConsentStatus, requireConsent]);

  const handleSubmitCode = useCallback(async (questionId: string, code: string) => {
    setProgSubmitting(true);
    setProgLastEval(null);
    try {
      const result = await apiFetch<any>(`/interviews/${sessionId}/submit-code`, {
        method: "POST",
        body: JSON.stringify({ questionId, code, language: progLang }),
      });
      setProgSubmissions(prev => [...prev, result]);
      setProgLastEval(result.evaluation);
    } catch (err) {
      /* A 412 (consent revoked mid-interview) or 401 (step-up) must surface as
         the consent/verification gate, not a generic "failed to evaluate". */
      if (handleApiError(err)) return;
      setProgLastEval({ score: 0, feedback: "Failed to evaluate. Check your code and try again.", passed: false });
    } finally {
      setProgSubmitting(false);
    }
  }, [sessionId, progLang, handleApiError]);

  const handleNextChallenge = useCallback(() => {
    const qs = (plan?.questions as any[]) ?? [];
    const next = progChallengeIdx + 1;
    if (next >= qs.length) {
      handleEnd();
      return;
    }
    setProgChallengeIdx(next);
    setProgLastEval(null);
    const nextQ = qs[next];
    if (nextQ && !progCode[nextQ.id]) {
      const starter = nextQ.starterCode?.[progLang] ?? nextQ.starterCode?.javascript ?? "// Write your solution here\n";
      setProgCode(prev => ({ ...prev, [nextQ.id]: starter }));
    }
  }, [plan, progChallengeIdx, progLang, progCode, handleEnd]);

  /* Candidate done speaking — also exposed via ref for silence-detection auto-call */
  /* Track consecutive no-speech timeouts so we don't loop forever */
  const noSpeechCountRef = useRef(0);

  const handleDoneSpeaking = useCallback(async () => {
    /* Guard against re-entrant submits — a double-tap, or the silence timer
       firing the same instant the candidate taps Send, must not run twice. */
    if (doneInFlightRef.current) return;
    doneInFlightRef.current = true;
    setFinalizing(true);
    /* Single release point — the Send button stays disabled (spinner) for the
       ENTIRE in-flight window (STT flush + save-turn + aiTurn). Releasing
       `finalizing` any earlier would re-enable the button while taps are still
       silently swallowed by the `doneInFlightRef` guard. */
    try {
      /* Mobile server-STT: flush the in-flight recording so the final utterance is
         transcribed into transcriptRef BEFORE we read the answer below. */
      if (serverSttActiveRef.current && finalizeServerSttRef.current) {
        try { await finalizeServerSttRef.current(); } catch { /* keep going with whatever we have */ }
      }
      stopListening();
      const answer = useTextInput ? textAnswer.trim() : transcriptRef.current.trim();

      if (!answer) {
        /* No speech detected — switch to text input immediately on first failure */
        noSpeechCountRef.current += 1;
        if (noSpeechCountRef.current <= 1 && convPhaseRef.current === "listening" && !useTextInput) {
          /* One retry: re-arm the mic for another window */
          setTimeout(() => {
            if (convPhaseRef.current === "listening") {
              transcriptRef.current = "";
              setLiveTranscript("");
              startListening(interviewLangRef.current);
            }
          }, 400);
        } else {
          /* Switch to text input for THIS question only — voice re-arms next question.
           * Show the same reassurance notice mobile gets, so desktop candidates
           * aren't left wondering why the mic "gave up" (#15). */
          setMicFallbackNotice(true);
          enableTextInput("nospeech");
        }
        return;
      }

      /* Speech was captured — reset the no-speech counter. */
      noSpeechCountRef.current = 0;

      /* ── Work-authorization answer (SEPARATE, NON-SCORED) ────────────────────
         If we're in the work-auth window, route this answer to /work-auth — NOT
         save-turn — so it never enters session.answers and can never be scored.
         Then proceed to the real closing using the assessed transcript only (the
         work-auth exchange is intentionally excluded from the closing). */
      if (workAuthActiveRef.current) {
        workAuthActiveRef.current = false;
        setWorkAuthActive(false);
        workAuthDoneRef.current   = true;
        try {
          await apiFetch(`/interviews/${sessionId}/work-auth`, {
            method: "POST",
            body: JSON.stringify({ answerText: answer }),
          });
        } catch {}
        setLiveTranscript("");
        setTextAnswer("");
        transcriptRef.current = "";
        /* Close the interview from the pre-work-auth transcript so the logistics
           exchange never reaches the closing conversation or the saved record. */
        const closeHist = histBeforeWorkAuthRef.current;
        setHistory(closeHist);
        historyRef.current = closeHist;
        await aiTurn(closeHist, questionNumRef.current + 1);
        return;
      }

      const qNum    = questionNumRef.current;
      const curHist = historyRef.current;
      const aiQ     = [...curHist].reverse().find(h => h.role === "ai")?.text ?? "";

      /* Persist the turn in the BACKGROUND so it never sits between the
         candidate's answer and Lexy's reply. converse() receives the full
         history below and does not depend on this DB write.
         Saves are CHAINED (not "latest wins") so two writes can never overlap —
         the backend's save-turn does a non-atomic read/append/write, and a
         chain keeps them ordered. The closing path awaits the chain before /end
         so every turn is persisted before background scoring reads answers. */
      const prevSave = pendingSaveTurnRef.current ?? Promise.resolve();
      pendingSaveTurnRef.current = prevSave
        .catch(() => {})
        .then(() => apiFetch(`/interviews/${sessionId}/save-turn`, {
          method: "POST",
          body: JSON.stringify({ questionText: aiQ, answerText: answer, turnNumber: qNum }),
        }))
        .catch(() => {});

      const newHist = [...curHist, { role: "candidate" as const, text: answer }];
      setHistory(newHist);
      historyRef.current = newHist;
      setLiveTranscript("");
      setTextAnswer("");
      transcriptRef.current = "";

      const nextQ = qNum + 1;
      setQuestionNumber(nextQ);
      questionNumRef.current = nextQ;

      await aiTurn(newHist, nextQ);
    } finally {
      /* Always release both guards together — even if STT flush, save-turn, or
         aiTurn throws — so the Send button can never get stuck disabled. */
      doneInFlightRef.current = false;
      setFinalizing(false);
    }
  }, [sessionId, useTextInput, textAnswer, stopListening, aiTurn]);

  /* Keep doneSpeakingRef current so the silence timer can call it */
  useEffect(() => { doneSpeakingRef.current = handleDoneSpeaking; }, [handleDoneSpeaking]);

  /* Skip the optional work-auth question — fire a no-op POST (empty answer = null persisted)
     then advance directly to the normal closing flow from the pre-work-auth transcript. */
  const handleSkipWorkAuth = useCallback(async () => {
    if (!workAuthActiveRef.current) return;
    stopListening();
    workAuthActiveRef.current = false;
    setWorkAuthActive(false);
    workAuthDoneRef.current = true;
    try {
      await apiFetch(`/interviews/${sessionId}/work-auth`, {
        method: "POST",
        body: JSON.stringify({ answerText: "" }),
      });
    } catch {}
    setLiveTranscript("");
    setTextAnswer("");
    transcriptRef.current = "";
    const closeHist = histBeforeWorkAuthRef.current;
    setHistory(closeHist);
    historyRef.current = closeHist;
    await aiTurn(closeHist, questionNumRef.current + 1);
  }, [sessionId, stopListening, aiTurn]);

  /* ── Loading ──────────────────────────────────────────────────────────── */
  if (phase === "loading") return (
    <RoomLayout overlay={stepUpOverlay}>
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
        <p className="text-sm text-muted-foreground">Loading your interview session…</p>
      </div>
    </RoomLayout>
  );

  /* ── Programming start screen ─────────────────────────────────────────── */
  if (phase === "start" && consentRequired === false && plan?.interviewType === "programming") {
    const challenges = (plan?.questions as any[]) ?? [];
    return (
      <RoomLayout overlay={stepUpOverlay}>
        <div className="flex h-full items-center justify-center p-6">
          <Card className="w-full max-w-2xl border-border/60 animate-in fade-in duration-500">
            <CardContent className="pt-8 pb-6 space-y-6">
              <div className="text-center space-y-2">
                <div className="w-16 h-16 rounded-2xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center mx-auto">
                  <Code2 className="w-8 h-8 text-orange-400" />
                </div>
                <h1 className="text-2xl font-black">{plan?.title ?? "Programming Interview"}</h1>
                <p className="text-sm text-muted-foreground">
                  {pluralize(challenges.length, "coding challenge")} · in-browser code editor · AI evaluation
                </p>
              </div>

              <div className="bg-orange-500/5 border border-orange-500/20 rounded-xl p-4 space-y-2">
                <p className="text-xs font-bold text-orange-400 uppercase tracking-wider">How it works</p>
                <ul className="space-y-1.5 text-sm text-muted-foreground">
                  <li className="flex gap-2"><span className="text-orange-400 shrink-0">→</span>You will be given coding challenges to solve in the browser</li>
                  <li className="flex gap-2"><span className="text-orange-400 shrink-0">→</span>Choose your preferred language: JavaScript, TypeScript, or Python</li>
                  <li className="flex gap-2"><span className="text-orange-400 shrink-0">→</span>Starter code is provided — modify it to solve the problem</li>
                  <li className="flex gap-2"><span className="text-orange-400 shrink-0">→</span>Submit each solution — AI will evaluate correctness, complexity, and quality</li>
                </ul>
              </div>

              {challenges.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Challenges</p>
                  <div className="space-y-1.5">
                    {challenges.map((c: any, i: number) => (
                      <div key={c.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-card/40 border border-border/40">
                        <div className="w-6 h-6 rounded-full bg-orange-500/15 border border-orange-500/30 flex items-center justify-center flex-shrink-0">
                          <span className="text-[10px] font-bold text-orange-400">{i + 1}</span>
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold truncate">{c.title}</p>
                          <p className="text-xs text-muted-foreground">~{c.estimatedMinutes ?? 20} min</p>
                        </div>
                        <Badge variant="outline" className="text-[9px] flex-shrink-0" style={{ color: c.difficulty === "easy" ? "#4ade80" : c.difficulty === "hard" ? "#f87171" : "#fb923c", borderColor: "currentColor" }}>
                          {c.difficulty ?? "medium"}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <Button
                onClick={handleBeginProgramming}
                size="lg"
                className="w-full gap-2 font-bold text-base bg-orange-500 hover:bg-orange-600 text-white border-0"
              >
                <Code2 className="w-5 h-5" /> Begin Coding Challenges
              </Button>
            </CardContent>
          </Card>
        </div>
      </RoomLayout>
    );
  }

  /* ── Session ended (server returned 410) ─────────────────────────────── */
  if (sessionEnded) return (
    <RoomLayout overlay={stepUpOverlay}>
      <div className="flex flex-col items-center justify-center h-full gap-6 px-6">
        <div className="w-20 h-20 rounded-2xl bg-muted/30 border border-border/40 flex items-center justify-center">
          <AlertTriangle className="w-10 h-10 text-yellow-400" />
        </div>
        <div className="text-center space-y-3 max-w-sm">
          <h1 className="text-2xl font-black">
            {sessionEnded.reason === "expired" ? "This interview link has expired" : "Interview already completed"}
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {sessionEnded.reason === "expired"
              ? `Interview links are valid for ${durationHours} hours after you first open them. Please contact the recruiter to request a new link.`
              : "This interview has already been submitted. If you believe this is a mistake, please contact the recruiter."}
          </p>
        </div>
      </div>
    </RoomLayout>
  );

  /* ── AI + biometric (BIPA) consent gate ───────────────────────────────────
     Shown before the start screen whenever the candidate has not yet consented
     to the current disclosure version. The camera is not requested until this
     resolves, so no biometric capture occurs before consent. */
  const submitConsent = async () => {
    if (!aiAgreed || !bioAgreed) return;
    setConsentSaving(true);
    setConsentError(null);
    try {
      await apiFetch(`/interviews/${sessionId}/consent`, {
        method: "POST",
        body: JSON.stringify({ consent: true, biometricConsent: true }),
      });
      setConsentRequired(false);
    } catch (e: any) {
      setConsentError(e?.message || "Could not save your consent. Please try again.");
    } finally {
      setConsentSaving(false);
    }
  };

  if (phase === "start" && consentRequired !== false) {
    const d = consentDisclosure;
    const bio = d?.biometric;
    return (
      <RoomLayout overlay={stepUpOverlay}>
        <div className="flex h-full items-center justify-center p-6 overflow-y-auto">
          <Card className="w-full max-w-lg border-border/60 animate-in fade-in duration-500 my-6">
            <CardContent className="pt-8 pb-6 space-y-6">
              {consentLoadError ? (
                <div className="space-y-4 py-8 text-center">
                  <AlertTriangle className="w-8 h-8 text-yellow-400 mx-auto" />
                  <p className="text-sm text-muted-foreground">
                    We couldn't load the consent form. You must review and accept it before the interview can start.
                  </p>
                  <Button onClick={() => void loadConsentStatus()} size="lg" className="w-full font-bold">
                    Retry
                  </Button>
                </div>
              ) : consentRequired === null ? (
                <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin" /> Loading…
                </div>
              ) : (
                <>
                  <div className="text-center space-y-2">
                    <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto">
                      <CheckCircle2 className="w-8 h-8 text-primary" />
                    </div>
                    <h1 className="text-2xl font-black">Before you begin</h1>
                    <p className="text-sm text-muted-foreground">
                      This is an AI-conducted interview. Please review and consent below — it takes a moment and is required to start.
                    </p>
                  </div>

                  <div className="space-y-4 text-sm">
                    <div>
                      <p className="text-xs font-bold text-primary uppercase tracking-wider mb-1">AI interview</p>
                      <p className="text-muted-foreground leading-relaxed">
                        {d?.intendedUse ?? "Your responses are evaluated by AI to assist a human recruiter. A human makes the final hiring decision. You may request a copy or deletion of your data, and withdraw consent at any time."}
                      </p>
                    </div>

                    {bio && (
                      <div>
                        <p className="text-xs font-bold text-primary uppercase tracking-wider mb-1">Biometric data — webcam proctoring &amp; recording</p>
                        <p className="text-muted-foreground leading-relaxed mb-2">
                          This interview is proctored and recorded. Lexy collects the following biometric identifiers and biometric information:
                        </p>
                        <ul className="space-y-1.5 mb-2">
                          {(bio.identifiersCollected ?? []).map((t: string, i: number) => (
                            <li key={i} className="flex gap-2 text-muted-foreground"><span className="text-primary shrink-0">•</span><span>{t}</span></li>
                          ))}
                        </ul>
                        <p className="text-muted-foreground leading-relaxed mb-2">{bio.purpose}</p>
                        <p className="text-muted-foreground leading-relaxed mb-2">
                          <span className="text-foreground font-semibold">Retention &amp; destruction:</span> {bio.retentionSchedule}
                        </p>
                        <p className="text-muted-foreground leading-relaxed">{bio.notSoldOrShared}</p>
                      </div>
                    )}
                  </div>

                  <div className="border-t border-border pt-5 space-y-4">
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input type="checkbox" checked={aiAgreed} onChange={(e) => setAiAgreed(e.target.checked)} className="mt-1 w-4 h-4 rounded border-border" />
                      <span className="text-sm">
                        I have read the information above and consent to participating in an AI-conducted interview. I understand my consent is voluntary and I may withdraw it at any time.
                      </span>
                    </label>
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input type="checkbox" checked={bioAgreed} onChange={(e) => setBioAgreed(e.target.checked)} className="mt-1 w-4 h-4 rounded border-border" />
                      <span className="text-sm">
                        I separately authorise the collection, storage, and use of my biometric identifiers and biometric information (facial geometry, gaze, voice, and the interview recording) for the purposes and on the retention/destruction schedule described above.
                      </span>
                    </label>

                    {consentError && <p className="text-sm text-red-500">{consentError}</p>}

                    <Button onClick={submitConsent} disabled={!aiAgreed || !bioAgreed || consentSaving} size="lg" className="w-full gap-2 font-bold">
                      {consentSaving ? <Loader2 className="w-5 h-5 animate-spin" /> : "I consent — continue"}
                    </Button>
                    {d?.version && <p className="text-xs text-muted-foreground text-center">Consent version: {d.version}</p>}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </RoomLayout>
    );
  }

  /* ── Start screen ─────────────────────────────────────────────────────── */
  if (phase === "start") return (
    <RoomLayout overlay={stepUpOverlay}>
      <div className="flex h-full items-center justify-center p-6">
        <Card className="w-full max-w-lg border-border/60 animate-in fade-in duration-500">
          <CardContent className="pt-8 pb-6 space-y-6">
            <div className="text-center space-y-2">
              <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto">
                <Brain className="w-8 h-8 text-primary" />
              </div>
              <h1 className="text-2xl font-black">{plan?.title ?? "AI Video Interview"}</h1>
              <p className="text-sm text-muted-foreground">
                ~30 min · {totalQuestions} questions · conversational AI · video recorded
              </p>
            </div>

            {/* Recruiter "smooth handover" intro — a recorded greeting from the
                recruiter who owns this role, shown before Lexy takes over. Only
                rendered when a ready recruiter video is actually on file. */}
            {intro?.mode === "video" && intro?.video_url && (
              <div className="space-y-2">
                <p className="text-xs font-bold text-primary uppercase tracking-wider text-center">
                  A message from your recruiter
                </p>
                <div className="relative aspect-video rounded-xl overflow-hidden bg-zinc-900 border border-border/60">
                  <video
                    ref={introVideoRef}
                    src={/^https?:\/\//.test(intro.video_url) ? intro.video_url : `${BASE}${intro.video_url}`}
                    poster={intro.fallback_image_url ? (/^https?:\/\//.test(intro.fallback_image_url) ? intro.fallback_image_url : `${BASE}${intro.fallback_image_url}`) : undefined}
                    controls
                    autoPlay
                    muted={introMuted}
                    playsInline
                    onCanPlay={handleIntroCanPlay}
                    onEnded={() => setIntroEnded(true)}
                    className="w-full h-full object-cover"
                  />
                  {introMuted && (
                    <button
                      type="button"
                      onClick={handleIntroUnmute}
                      className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/40 text-white transition-opacity hover:bg-black/30"
                      aria-label="Unmute recruiter message"
                    >
                      <span className="flex items-center justify-center w-12 h-12 rounded-full bg-white/15 backdrop-blur-sm border border-white/30">
                        <VolumeX className="w-6 h-6" />
                      </span>
                      <span className="text-xs font-semibold drop-shadow">Tap to unmute</span>
                    </button>
                  )}
                </div>
                {introEnded && (
                  <button
                    type="button"
                    onClick={() => startBtnRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
                    className="w-full flex flex-col items-center gap-1 text-emerald-400 hover:text-emerald-300 transition-colors"
                  >
                    <span className="text-xs font-semibold">
                      Ready when you are — scroll down and press Start to begin with Lexy.
                    </span>
                    <ChevronDown className="w-5 h-5 animate-bounce" />
                  </button>
                )}
              </div>
            )}

            {/* 24h availability banner — shown before the candidate begins so
                they understand the link's lifetime up front. */}
            <div className="flex items-start gap-3 bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4">
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-bold text-foreground">You have {durationHours} hours to complete this interview</p>
                <p className="text-xs text-muted-foreground mt-1">
                  The {durationHours}-hour timer starts when you press <span className="font-bold">Start</span>. You can refresh or reopen this link from the same browser if you get disconnected — your progress is saved automatically.
                </p>
              </div>
            </div>

            <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 space-y-2">
              <p className="text-xs font-bold text-primary uppercase tracking-wider">How it works</p>
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                <li className="flex gap-2"><span className="text-primary shrink-0">→</span>Lexy will speak — just listen and respond naturally when ready</li>
                <li className="flex gap-2"><span className="text-primary shrink-0">→</span>Your mic is always on — no buttons to press, just talk</li>
                <li className="flex gap-2"><span className="text-primary shrink-0">→</span>Lexy detects when you've finished and responds automatically</li>
                <li className="flex gap-2"><span className="text-primary shrink-0">→</span>Tap the mic any time to interrupt Lexy and speak immediately</li>
              </ul>
            </div>

            {/* Webcam preview */}
            {!camError && liveStream && (
              <div className="relative aspect-video rounded-xl overflow-hidden bg-zinc-900">
                <WebcamView stream={liveStream} isRecording={false} />
                <div className="absolute inset-0 flex items-end justify-end p-3 gap-2">
                  <Button size="icon" variant="ghost" aria-label={camEnabled ? "Turn camera off" : "Turn camera on"} aria-pressed={camEnabled} className="h-8 w-8 bg-black/50 hover:bg-black/70" onClick={toggleCamera}>
                    {camEnabled ? <Camera className="w-4 h-4 text-white" /> : <CameraOff className="w-4 h-4 text-white/50" />}
                  </Button>
                  <Button size="icon" variant="ghost" aria-label={micEnabled ? "Mute microphone" : "Unmute microphone"} aria-pressed={micEnabled} className="h-8 w-8 bg-black/50 hover:bg-black/70" onClick={toggleMic}>
                    {micEnabled ? <Mic className="w-4 h-4 text-white" /> : <MicOff className="w-4 h-4 text-white/50" />}
                  </Button>
                </div>
              </div>
            )}

            {camError && (
              <div className="flex items-center gap-2 p-3 bg-yellow-500/5 border border-yellow-500/20 rounded-lg text-xs text-yellow-400">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                Camera access denied — interview will proceed without video recording.
              </div>
            )}

            {!sttAvailable && (
              <div className="flex items-center gap-2 p-3 bg-blue-500/5 border border-blue-500/20 rounded-lg text-xs text-blue-400">
                <MicOff className="w-3.5 h-3.5 shrink-0" />
                Your browser doesn't support voice input — you'll type your answers instead.
              </div>
            )}

            {/* Screen recording is a desktop-only browser capability — phones and
                tablets can't share their whole screen, so we record the webcam
                only there. Make that explicit instead of silently skipping it. */}
            {isMobileDevice() && (
              <div className="flex items-center gap-2 p-3 bg-blue-500/5 border border-blue-500/20 rounded-lg text-xs text-blue-400">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                Screen recording isn't available on mobile — your camera and audio will be recorded. For full-screen recording, open this link on a computer.
              </div>
            )}

            <Button ref={startBtnRef} onClick={handleBegin} size="lg" className="w-full gap-2 font-bold text-base">
              <Play className="w-5 h-5" /> Start Interview with Lexy
            </Button>
          </CardContent>
        </Card>
      </div>
    </RoomLayout>
  );

  /* ── Uploading ────────────────────────────────────────────────────────── */
  if (phase === "uploading") return (
    <RoomLayout overlay={stepUpOverlay}>
      <div className="flex flex-col items-center justify-center h-full gap-6">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
          <Upload className="w-8 h-8 text-primary animate-bounce" />
        </div>
        <div className="text-center space-y-2 w-72">
          <p className="font-bold text-lg">Saving your interview</p>
          <p className="text-sm text-muted-foreground">Uploading recording · Generating AI evaluation…</p>
          <div className="w-full bg-muted/40 rounded-full h-2 overflow-hidden">
            <div className="h-2 rounded-full bg-primary transition-all duration-700" style={{ width: `${Math.max(10, uploadProgress)}%` }} />
          </div>
          <div className="flex items-start gap-2 text-left rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 mt-1">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-200/90">
              Please keep this window open until the upload finishes — closing it now will lose your recording.
            </p>
          </div>
        </div>
      </div>
    </RoomLayout>
  );

  /* ── Done ─────────────────────────────────────────────────────────────── */
  if (phase === "done") return (
    <RoomLayout overlay={stepUpOverlay}>
      <div className="flex flex-col items-center justify-center h-full gap-6 animate-in fade-in duration-500 px-6">
        <div className="w-20 h-20 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
          <CheckCircle2 className="w-10 h-10 text-emerald-400" />
        </div>
        <div className="text-center space-y-3 max-w-sm">
          <h1 className="text-2xl font-black">You're all done!</h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Your interview has been submitted to the hiring team. They'll be in touch soon.
          </p>
          <p className="text-xs text-muted-foreground/60">
            Your recording is finishing uploading in the background — please keep this window open for a few more seconds before closing it.
          </p>
        </div>
      </div>
    </RoomLayout>
  );

  /* ── Interview ────────────────────────────────────────────────────────── */
  const avatarState: "idle" | "thinking" | "speaking" | "listening" =
    convPhase === "thinking"  ? "thinking"  :
    convPhase === "speaking"  ? "speaking"  :
    convPhase === "listening" ? "listening" : "idle";

  /* ── Programming interview phase ─────────────────────────────────────── */
  if (plan?.interviewType === "programming") {
    const challenges = (plan?.questions as any[]) ?? [];
    const challenge = challenges[progChallengeIdx];
    const currentCode = challenge ? (progCode[challenge.id] ?? challenge.starterCode?.[progLang] ?? challenge.starterCode?.javascript ?? "// Write your solution here\n") : "";
    const challengeProgressPct = challenges.length > 0 ? Math.round(((progChallengeIdx) / challenges.length) * 100) : 0;

    return (
      <RoomLayout overlay={stepUpOverlay}>
        <div className="h-full flex flex-col bg-background">
          {/* Header */}
          <div className="shrink-0 px-4 py-2 flex items-center gap-3 border-b border-border/40">
            <div className="flex items-center gap-2">
              <Code2 className="w-4 h-4 text-orange-400" />
              <span className="text-sm font-bold">Programming Interview</span>
            </div>
            <div className="flex-1 h-1.5 bg-muted/40 rounded-full overflow-hidden">
              <div className="h-full bg-orange-500 rounded-full transition-all duration-700" style={{ width: `${challengeProgressPct}%` }} />
            </div>
            <span className="text-xs text-muted-foreground shrink-0">
              {progChallengeIdx + 1} / {challenges.length}
            </span>
          </div>

          {/* Split layout: challenge description + code editor */}
          <div className="flex-1 min-h-0 flex gap-0">
            {/* Left: challenge description */}
            <div className="w-[42%] shrink-0 border-r border-border/40 overflow-y-auto p-4 space-y-4">
              {challenge ? (
                <>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-[9px]" style={{ color: "#fb923c", borderColor: "#fb923c44" }}>
                        Challenge {progChallengeIdx + 1}
                      </Badge>
                      {challenge.difficulty && (
                        <Badge variant="outline" className="text-[9px]" style={{
                          color: challenge.difficulty === "easy" ? "#4ade80" : challenge.difficulty === "hard" ? "#f87171" : "#fb923c",
                          borderColor: "currentColor",
                        }}>
                          {challenge.difficulty}
                        </Badge>
                      )}
                      {challenge.estimatedMinutes && (
                        <span className="text-[10px] text-muted-foreground">~{challenge.estimatedMinutes} min</span>
                      )}
                    </div>
                    <h2 className="text-lg font-black">{challenge.title}</h2>
                  </div>

                  <div className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
                    {challenge.description}
                  </div>

                  {challenge.examples?.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Examples</p>
                      {challenge.examples.map((ex: any, i: number) => (
                        <div key={i} className="rounded-lg bg-card/60 border border-border/40 p-3 space-y-1.5 text-xs font-mono">
                          <div><span className="text-muted-foreground">Input: </span><span className="text-primary">{ex.input}</span></div>
                          <div><span className="text-muted-foreground">Output: </span><span className="text-emerald-400">{ex.output}</span></div>
                          {ex.explanation && <div className="text-muted-foreground/70 font-sans italic">{ex.explanation}</div>}
                        </div>
                      ))}
                    </div>
                  )}

                  {challenge.constraints?.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Constraints</p>
                      <ul className="space-y-1">
                        {challenge.constraints.map((c: string, i: number) => (
                          <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                            <span className="text-orange-400 shrink-0 mt-0.5">·</span>{c}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex items-center justify-center h-32">
                  <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
                </div>
              )}
            </div>

            {/* Right: code editor */}
            <div className="flex-1 min-w-0 flex flex-col">
              {/* Editor toolbar */}
              <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border/40 bg-card/20">
                <Terminal className="w-3.5 h-3.5 text-muted-foreground" />
                <Select value={progLang} onValueChange={lang => {
                  setProgLang(lang);
                  if (challenge && !progCode[challenge.id + "_" + lang]) {
                    const starter = challenge.starterCode?.[lang] ?? challenge.starterCode?.javascript ?? "// Write your solution here\n";
                    setProgCode(prev => ({ ...prev, [challenge.id]: starter }));
                  }
                }}>
                  <SelectTrigger className="h-7 w-36 text-xs border-border/40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="javascript">JavaScript</SelectItem>
                    <SelectItem value="typescript">TypeScript</SelectItem>
                    <SelectItem value="python">Python</SelectItem>
                  </SelectContent>
                </Select>
                <div className="flex-1" />
                <button
                  onClick={() => {
                    if (challenge) {
                      const starter = challenge.starterCode?.[progLang] ?? challenge.starterCode?.javascript ?? "";
                      setProgCode(prev => ({ ...prev, [challenge.id]: starter }));
                    }
                  }}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  title="Reset to starter code"
                >
                  <RotateCcw className="w-3 h-3" /> Reset
                </button>
              </div>

              {/* Code textarea */}
              <div className="flex-1 min-h-0 relative">
                <Textarea
                  value={currentCode}
                  onChange={e => {
                    if (challenge) setProgCode(prev => ({ ...prev, [challenge.id]: e.target.value }));
                  }}
                  className="absolute inset-0 resize-none rounded-none border-0 focus-visible:ring-0 font-mono text-sm bg-[#0d1117] text-[#e6edf3] leading-relaxed p-4"
                  placeholder="// Write your solution here..."
                  spellCheck={false}
                />
              </div>

              {/* Evaluation result */}
              {progLastEval && (
                <div className={cn(
                  "shrink-0 mx-3 my-2 p-3 rounded-xl border text-xs space-y-2 animate-in fade-in slide-in-from-bottom-2",
                  progLastEval.passed
                    ? "bg-emerald-500/5 border-emerald-500/30"
                    : "bg-red-500/5 border-red-500/30",
                )}>
                  <div className="flex items-center justify-between">
                    <span className={cn("font-bold", progLastEval.passed ? "text-emerald-400" : "text-red-400")}>
                      {progLastEval.passed ? "✓ Solution Accepted" : "✗ Needs Work"}
                    </span>
                    <div className="flex gap-2 text-muted-foreground">
                      {progLastEval.timeComplexity && <span>Time: {progLastEval.timeComplexity}</span>}
                      {progLastEval.spaceComplexity && <span>Space: {progLastEval.spaceComplexity}</span>}
                    </div>
                  </div>
                  <p className="text-muted-foreground leading-relaxed">{progLastEval.feedback}</p>
                  {progLastEval.suggestions?.length > 0 && (
                    <ul className="space-y-1">
                      {progLastEval.suggestions.map((s: string, i: number) => (
                        <li key={i} className="text-muted-foreground/70 flex items-start gap-1.5">
                          <ChevronRight className="w-3 h-3 text-primary shrink-0 mt-0.5" />{s}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* Submit / Next buttons */}
              <div className="shrink-0 flex gap-2 p-3 border-t border-border/40">
                {!progLastEval ? (
                  <Button
                    className="flex-1 gap-2 bg-orange-500 hover:bg-orange-600 text-white border-0 font-semibold"
                    onClick={() => challenge && handleSubmitCode(challenge.id, currentCode)}
                    disabled={progSubmitting || !currentCode.trim()}
                  >
                    {progSubmitting ? <><Loader2 className="w-4 h-4 animate-spin" />Evaluating…</> : <><ChevronRight className="w-4 h-4" />Submit Solution</>}
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      className="gap-2"
                      onClick={() => setProgLastEval(null)}
                    >
                      <RotateCcw className="w-3.5 h-3.5" /> Resubmit
                    </Button>
                    <Button
                      className="flex-1 gap-2 font-semibold"
                      onClick={handleNextChallenge}
                    >
                      {progChallengeIdx + 1 >= challenges.length
                        ? <><CheckCircle2 className="w-4 h-4" />Finish Interview</>
                        : <><ChevronRight className="w-4 h-4" />Next Challenge</>
                      }
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </RoomLayout>
    );
  }

  const progressPct = Math.round(((questionNumber - 1) / totalQuestions) * 100);

  return (
    <RoomLayout overlay={stepUpOverlay}>
      {/* Keyframe styles */}
      <style>{`
        @keyframes soundBar {
          0%, 100% { transform: scaleY(0.4); }
          50%       { transform: scaleY(1); }
        }
      `}</style>

      <div className="flex flex-col">
        {/* Progress bar + PROCTORED badge */}
        <div className="shrink-0 px-4 pt-2 pb-0 flex items-center gap-3">
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            Q {Math.min(questionNumber, totalQuestions)}/{totalQuestions}
          </span>
          <div className="flex-1 h-1.5 bg-muted/40 rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all duration-700" style={{ width: `${progressPct}%` }} />
          </div>
          {/* Proctoring badge */}
          <button
            onClick={() => setShowProctorLog(v => !v)}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold border transition-colors",
              proctorEvents.some(e => ["tab_switch","copy","paste","right_click"].includes(e.type))
                ? "bg-red-500/15 text-red-400 border-red-500/30"
                : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
            )}
          >
            <span className={cn("w-1.5 h-1.5 rounded-full inline-block", proctorEvents.some(e => ["tab_switch","copy","paste","right_click"].includes(e.type)) ? "bg-red-400" : "bg-emerald-400")} />
            PROCTORED {proctorEvents.length > 0 && `· ${proctorEvents.length}`}
          </button>
        </div>

        {/* Proctoring event log panel */}
        {showProctorLog && (
          <div className="mx-4 mt-2 bg-card/80 border border-border/60 rounded-xl p-3 text-xs space-y-1.5 max-h-40 overflow-y-auto">
            <div className="flex items-center justify-between mb-1">
              <span className="font-semibold text-[11px] text-muted-foreground uppercase tracking-wider">Proctoring Events</span>
              <span className="text-muted-foreground">{proctorEvents.length} logged</span>
            </div>
            {proctorEvents.length === 0 && (
              <p className="text-muted-foreground text-center py-1">No violations detected</p>
            )}
            {[...proctorEvents].reverse().map((ev, i) => (
              <div key={i} className={cn(
                "flex items-start gap-2 p-1.5 rounded-lg",
                ev.type === "tab_switch"  ? "bg-red-500/10 text-red-300" :
                ev.type === "copy"        ? "bg-orange-500/10 text-orange-300" :
                ev.type === "paste"       ? "bg-orange-500/10 text-orange-300" :
                ev.type === "right_click" ? "bg-yellow-500/10 text-yellow-300" :
                                            "bg-muted/30 text-muted-foreground"
              )}>
                <span className="shrink-0">
                  {ev.type === "tab_switch"  ? "🔴" :
                   ev.type === "copy"        ? "🟠" :
                   ev.type === "paste"       ? "🟠" :
                   ev.type === "right_click" ? "🟡" : "📸"}
                </span>
                <div className="min-w-0">
                  <span className="font-semibold capitalize">{ev.type.replace(/_/g, " ")}</span>
                  <span className="mx-1 text-muted-foreground">·</span>
                  <span className="opacity-70">{new Date(ev.ts).toLocaleTimeString()}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Main video area */}
        <div className="grid grid-cols-2 gap-3 px-3 pt-2" style={{ height: "min(60vh, 420px)" }}>
          {/* AI panel */}
          <div className="bg-card/40 border border-border/40 rounded-2xl overflow-hidden">
            <AIAvatar state={avatarState} />
          </div>

          {/* Candidate webcam */}
          <div className="rounded-2xl overflow-hidden">
            <WebcamView stream={liveStream} isRecording={isRecording} />
          </div>
        </div>

        {/* Transcript + controls */}
        <div className="shrink-0 px-3 pb-3 space-y-2">
          {/* Conversation transcript */}
          <div ref={scrollRef} className="max-h-32 overflow-y-auto space-y-2 px-1">
            {history.slice(-6).map((h, i) => (
              <TranscriptBubble key={i} role={h.role} text={h.text} />
            ))}
            {convPhase === "listening" && liveTranscript && (
              <TranscriptBubble role="candidate" text={liveTranscript} live />
            )}
          </div>

          {/* ── Controls bar ── always present during interview */}
          <div className="flex items-center gap-3">

            {/* Left: status indicator */}
            <div className={cn(
              "flex-1 min-w-0 flex items-center gap-3 rounded-xl px-4 py-2.5 border transition-all duration-300",
              convPhase === "speaking"  ? "bg-primary/5 border-primary/25"   :
              convPhase === "listening" ? "bg-emerald-500/5 border-emerald-500/25" :
                                          "bg-muted/20 border-border/30",
            )}>
              {/* Waveform / pulse */}
              {convPhase === "speaking" && (
                <div className="flex items-end gap-0.5 h-4 shrink-0">
                  {[3, 6, 4, 8, 5].map((h, i) => (
                    <div key={i} className="w-0.5 bg-primary rounded-full"
                      style={{ height: `${h}px`, animation: "soundBar 0.8s ease-in-out infinite", animationDelay: `${i * 0.1}s` }} />
                  ))}
                </div>
              )}
              {convPhase === "listening" && !useTextInput && (
                /* Real-time mic level bars — shows candidate their voice is being picked up */
                <div className="flex items-end gap-[2px] h-5 shrink-0" title="Mic input level">
                  {[0.08, 0.22, 0.40, 0.60, 0.80].map((threshold, i) => {
                    const normalised = Math.min(micLevel / 55, 1); /* 55 ≈ comfortable speaking RMS */
                    const active = normalised > threshold;
                    return (
                      <div key={i}
                        className={cn(
                          "w-[3px] rounded-full transition-all duration-75",
                          active
                            ? i < 3 ? "bg-emerald-400" : i === 3 ? "bg-yellow-400" : "bg-red-400"
                            : "bg-muted-foreground/20",
                        )}
                        style={{ height: `${6 + i * 4}px` }}
                      />
                    );
                  })}
                </div>
              )}
              {convPhase === "listening" && useTextInput && (
                <div className="w-2.5 h-2.5 rounded-full shrink-0 bg-emerald-500/30 animate-ping" />
              )}
              {convPhase === "thinking" && (
                <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin shrink-0" />
              )}

              {/* Status text / live transcript */}
              <p className={cn(
                "text-sm flex-1 truncate",
                convPhase === "speaking"  ? "text-primary font-medium" :
                convPhase === "listening" ? (liveTranscript ? "text-foreground" : "text-muted-foreground") :
                                            "text-muted-foreground",
              )}>
                {convPhase === "speaking"  ? "Lexy is speaking…" : ""}
                {convPhase === "thinking"  ? "Lexy is thinking…" : ""}
                {convPhase === "listening" ? (liveTranscript || (useTextInput ? "Type your answer and press Enter…" : "Speak now — mic is open")) : ""}
              </p>

              {/* Work-auth skip affordance — candidate can always opt out of this optional question */}
              {convPhase === "listening" && workAuthActive && (
                <button
                  onClick={handleSkipWorkAuth}
                  className="shrink-0 flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-muted-foreground border border-border/40 hover:border-border/70 rounded-full px-3 py-0.5 transition-colors"
                  title="Skip this optional question">
                  Skip question
                </button>
              )}

              {/* 7-second silence warning — candidate hasn't spoken yet */}
              {convPhase === "listening" && showSilenceWarning && (
                <span className="shrink-0 flex items-center gap-1.5 text-xs text-amber-300 bg-amber-500/10 border border-amber-400/30 rounded-full px-3 py-0.5 animate-pulse">
                  🎤 Still there? Take your time…
                </span>
              )}

              {/* Silence countdown badge — only shown in final 5s so it's a gentle nudge, not pressure */}
              {convPhase === "listening" && silenceCountdown !== null && silenceCountdown <= 5 && (
                <span className="shrink-0 text-xs font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-2 py-0.5 animate-pulse">
                  Sending in {silenceCountdown}s…
                </span>
              )}
            </div>

            {/* Right: controls — always visible */}
            {useTextInput ? (
              /* text mode — send + toggle-back-to-mic */
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  onClick={() => { setMicFallbackNotice(false); disableTextInput(); noSpeechCountRef.current = 0; startListening(interviewLangRef.current); }}
                  size="icon" variant="outline"
                  className="h-10 w-10 rounded-xl border-border/50 text-muted-foreground hover:text-foreground"
                  title="Switch to microphone" aria-label="Switch to microphone">
                  <Mic className="w-4 h-4" />
                </Button>
                <Button onClick={handleDoneSpeaking} disabled={finalizing || !textAnswer.trim()} size="icon" aria-label="Submit answer"
                  className="h-10 w-10 rounded-xl">
                  {finalizing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                </Button>
              </div>
            ) : convPhase === "speaking" ? (
              /* interrupt button — tap to cut Lexy off and speak */
              <Button onClick={handleInterrupt} size="icon" variant="outline"
                className="h-12 w-12 shrink-0 rounded-xl border-primary/40 hover:bg-primary/10 hover:border-primary transition-all"
                title="Tap to interrupt and speak" aria-label="Interrupt and speak">
                <Mic className="w-5 h-5 text-primary" />
              </Button>
            ) : convPhase === "listening" ? (
              /* listening — show Type-instead toggle + send */
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  onClick={() => { setMicFallbackNotice(false); stopListening(); enableTextInput("sticky"); }}
                  size="icon" variant="outline"
                  className="h-12 w-12 rounded-xl border-border/50 text-muted-foreground hover:text-foreground hover:border-primary/40 transition-all"
                  title="Switch to typing" aria-label="Switch to typing">
                  <span className="text-base leading-none">⌨</span>
                </Button>
                <Button onClick={handleDoneSpeaking} disabled={finalizing} size="icon"
                  className="h-12 w-12 rounded-xl bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50"
                  title="Send answer now" aria-label="Send answer now">
                  {finalizing ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
                </Button>
              </div>
            ) : (
              <div className="h-12 w-12 shrink-0 rounded-xl bg-muted/30 border border-border/30 flex items-center justify-center">
                <Loader2 className="w-4 h-4 text-muted-foreground/40 animate-spin" />
              </div>
            )}
          </div>

          {/* One-time notice — explains why typing was auto-enabled after the mic
             couldn't be heard. Hidden when the candidate manually toggled typing. */}
          {useTextInput && convPhase === "listening" && micFallbackNotice && (
            <p className="flex items-center gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-400/30 rounded-lg px-3 py-2">
              🎤 We couldn't hear your mic, so you can type your answer instead.
            </p>
          )}

          {/* Text input fallback */}
          {useTextInput && convPhase === "listening" && (
            <Textarea
              value={textAnswer}
              onChange={e => setTextAnswer(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && textAnswer.trim()) { e.preventDefault(); handleDoneSpeaking(); } }}
              placeholder="Type your answer and press Enter…"
              className="min-h-[56px] max-h-28 resize-none text-sm"
            />
          )}
        </div>
      </div>
    </RoomLayout>
  );
}
