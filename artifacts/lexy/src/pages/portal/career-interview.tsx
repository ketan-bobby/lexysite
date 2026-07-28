/**
 * career-interview.tsx — AI-powered career baseline interview (the "Career Engine" chat).
 *
 * This is the core candidate onboarding experience. Lexy (our AI persona) leads
 * the candidate through a structured 9-question conversation that captures:
 *   - Current role, company, and experience level
 *   - Career goals and target industries
 *   - Dream companies and work preferences
 *   - Motivators and values
 *
 * At the end, the conversation is sent to the AI analysis pipeline which generates
 * career paths, skill gap analysis, strengths map, and growth recommendations.
 *
 * ── Key features ──
 *  - Voice mode   : Web Speech API (Chrome/Edge) with 2.5s silence debounce.
 *                   Uses continuous recognition so natural pauses don't trigger
 *                   premature sends.
 *  - Text mode    : Standard textarea with Enter-to-send (Shift+Enter = newline).
 *  - Resume upload: Optional at the start (pre-interview) or mid-interview.
 *                   Parsed via AI to pre-fill profile fields.
 *  - Language     : 10+ Indian languages + English; language selector before start.
 *  - Video        : Optional camera recording stored to S3 for later review.
 *  - Phase tracker: Progress bar showing which of the 4 interview phases the
 *                   candidate is in (based on message count).
 *
 * ── State flow ──
 *  showIntro → (resume upload → review?) → interview chat → isDone → analysis
 *
 * ── Critical patterns ──
 *  - `apiFetch` for all auth-gated calls; raw fetch only for S3 signed uploads.
 *  - `sendVoiceMessageRef` keeps the message-send closure fresh across re-renders
 *    so stale closures in the Web Speech API callbacks don't cause issues.
 *  - `silenceTimerRef` arms a 2.5s debounce timer after each speech result;
 *    resets on every new word so mid-thought pauses don't cut the user off.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { pluralize } from "@/lib/utils";
import { AppLayout } from "@/components/layout/AppLayout";
import LexyIntro from "@/components/LexyIntro";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useLocation } from "wouter";
import {
  Brain, Send, Sparkles, CheckCircle2, RotateCcw, User,
  Mic, MicOff, Volume2, VolumeX, Keyboard, AlertCircle, FileText, ArrowRight,
  Upload, Loader2, Paperclip, FileUp, Monitor, MonitorOff
} from "lucide-react";
import { apiBase, apiFetch } from "@/lib/api";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const OPENING_MESSAGE: Message = {
  role: "assistant",
  content: "Hi! I'm your Lexy career advisor 👋 This interview will take about 15 minutes, and I'll give you a heads-up about a minute before we wrap up. I'm here to build your personalised career profile and map out some exciting paths for you.\n\nLet's start simple — what's your current role and company?",
};

const HEADS_UP_MESSAGE = "Heads-up — we have about 1 minute left. Let's start wrapping up with any last thoughts you want to share.";

const PHASES = [
  { label: "Where you are",      range: [0, 2] },
  { label: "Where you're going", range: [3, 5] },
  { label: "Dream companies",    range: [6, 7] },
  { label: "What drives you",    range: [8, 9] },
];

function getPhase(userMsgCount: number) {
  for (const p of PHASES) {
    if (userMsgCount <= p.range[1]) return p.label;
  }
  return "Wrapping up";
}

function ProgressDots({ userMsgCount }: { userMsgCount: number }) {
  const total = 9;
  const pct = Math.min(100, Math.round((userMsgCount / total) * 100));
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{getPhase(userMsgCount)}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-1.5 bg-border rounded-full overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/* Animated waveform bars shown while Lexy is speaking */
function SpeakingWave() {
  return (
    <div className="flex items-center gap-[3px]">
      {[0, 1, 2, 3, 4].map(i => (
        <div
          key={i}
          className="w-[3px] rounded-full bg-primary animate-[soundwave_0.8s_ease-in-out_infinite]"
          style={{
            animationDelay: `${i * 0.1}s`,
            height: "16px",
          }}
        />
      ))}
    </div>
  );
}

/* Pulsing rings behind mic button while listening */
function ListeningRings() {
  return (
    <>
      <div className="absolute inset-0 rounded-full border-2 border-primary/40 animate-ping" />
      <div className="absolute inset-[-8px] rounded-full border border-primary/20 animate-ping"
        style={{ animationDelay: "0.3s" }} />
    </>
  );
}

const VOICE_NOT_SUPPORTED =
  typeof window !== "undefined" &&
  !("SpeechRecognition" in window) &&
  !("webkitSpeechRecognition" in window);

/* ── Lexy animated avatar — mirrors the recruiter interview room style ── */
type AvatarState = "idle" | "thinking" | "speaking" | "listening";

function LexyAvatar({ state }: { state: AvatarState }) {
  return (
    <div className="flex flex-col items-center gap-2">
      {/* Outer pulse rings */}
      <div className="relative flex items-center justify-center w-28 h-28">
        {state === "speaking" && (
          <>
            <div className="absolute w-28 h-28 rounded-full border-2 border-primary/30 animate-ping" style={{ animationDuration: "1.5s" }} />
            <div className="absolute w-32 h-32 rounded-full border border-primary/15 animate-ping" style={{ animationDuration: "2s", animationDelay: "0.3s" }} />
          </>
        )}
        {state === "listening" && (
          <div className="absolute w-28 h-28 rounded-full border border-emerald-400/30 animate-ping" style={{ animationDuration: "2s" }} />
        )}

        {/* Avatar circle */}
        <div className={[
          "w-24 h-24 rounded-full overflow-hidden border-4 transition-all duration-500 relative",
          state === "speaking"  ? "border-primary shadow-[0_0_30px_8px] shadow-primary/30" : "",
          state === "thinking"  ? "border-primary/40 opacity-75" : "",
          state === "listening" ? "border-emerald-400/60" : "",
          state === "idle"      ? "border-border/30" : "",
        ].join(" ")}>
          <img
            src="/lexy-avatar.jpeg"
            alt="Lexy"
            className="w-full h-full object-cover object-top"
          />
          {state === "thinking" && (
            <div className="absolute inset-0 bg-background/50 flex items-center justify-center">
              <div className="w-6 h-6 border-2 border-primary/40 border-t-primary rounded-full animate-spin" />
            </div>
          )}
        </div>
      </div>

      {/* Sound bars — only when speaking */}
      {state === "speaking" && (
        <div className="flex items-end gap-[2px] h-4">
          {[4, 7, 11, 8, 14, 9, 5, 12, 7, 4, 10, 6].map((h, i) => (
            <div
              key={i}
              className="w-[3px] bg-primary rounded-full"
              style={{
                height: `${h}px`,
                animation: "soundBar 0.9s ease-in-out infinite",
                animationDelay: `${i * 0.07}s`,
              }}
            />
          ))}
        </div>
      )}

      {/* Status label */}
      <p className={[
        "text-xs font-medium transition-all",
        state === "speaking"  ? "text-primary animate-pulse" : "",
        state === "thinking"  ? "text-muted-foreground/60 animate-pulse" : "",
        state === "listening" ? "text-emerald-400" : "",
        state === "idle"      ? "text-muted-foreground/40" : "",
      ].join(" ")}>
        {state === "speaking"  ? "Lexy is speaking…" : ""}
        {state === "thinking"  ? "Lexy is thinking…" : ""}
        {state === "listening" ? "Listening to you" : ""}
        {state === "idle"      ? "Lexy · Career Advisor" : ""}
      </p>
    </div>
  );
}

export default function CareerInterview() {
  const [, navigate] = useLocation();
  const [showIntro, setShowIntro] = useState(true);
  const [messages, setMessages] = useState<Message[]>([OPENING_MESSAGE]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [isHardComplete, setIsHardComplete] = useState(false); // safety cap fired — no "add more"

  /* Platform-discovery opt-in (onboarding surface). Explicit, logged consent
     — completing the interview no longer auto-promotes into the platform
     pool; this choice is the only door. `null` = undecided (show prompt). */
  const [discoveryChoice, setDiscoveryChoice] = useState<null | boolean>(null);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  async function chooseDiscovery(optIn: boolean) {
    if (discoveryBusy) return;
    setDiscoveryBusy(true);
    try {
      if (optIn) {
        const res = await apiFetch(`${apiBase}/portal/candidate/discovery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ consent: true, surface: "onboarding" }),
        });
        if (res.ok) setDiscoveryChoice(true);
      } else {
        setDiscoveryChoice(false); // stays hidden — nothing to record server-side
      }
    } finally {
      setDiscoveryBusy(false);
    }
  }
  const isCompleteRef = useRef(false); // ref so voice closures always see latest value
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Advisor / language selection (set on intro screen) */
  const [selectedPersona, setSelectedPersona] = useState("lexy");
  const [selectedLanguage, setSelectedLanguage] = useState("en-US");
  const advisorVoiceRef = useRef("nova");
  const selectedLanguageRef = useRef("en-US");

  /* Voice mode state */
  const [voiceMode, setVoiceMode] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [interimText, setInterimText] = useState("");
  const [micError, setMicError] = useState<string | null>(null);
  const [speechMuted, setSpeechMuted] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingAutoListen = useRef(false);
  const speechMutedRef = useRef(false);
  const voiceModeRef = useRef(false);
  const accumulatedTranscriptRef = useRef("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceWarningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showSilenceWarning, setShowSilenceWarning] = useState(false);
  // Always holds the latest sendVoiceMessage so startListening's closure never goes stale
  const sendVoiceMessageRef = useRef<(text: string) => void>(async () => {});
  // Ref mirror of isLoading — readable inside stale closures (e.g. recognition onend)
  const isLoadingRef = useRef(false);
  // Ref mirror of isSpeaking — readable inside stale closures and timer callbacks
  const isSpeakingRef = useRef(false);
  // Generation counter — incremented on every speakText call so stale callbacks are dropped
  const ttsGenerationRef = useRef(0);
  // Always holds the latest speakText so stale closures (timers, recognition handlers) can call it
  const speakTextRef = useRef<(text: string, onDone?: () => void) => void>(() => {});

  /* ── Screen recording + webcam ────────────────────────────────────────── */
  const [webcamActive, setWebcamActive] = useState(false);
  const [screenRecording, setScreenRecording] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [recordingSaved, setRecordingSaved] = useState(false);
  const [uploadedParts, setUploadedParts] = useState(0);
  const mediaRecorderRef      = useRef<MediaRecorder | null>(null);
  const streamRef             = useRef<MediaStream | null>(null);
  const micStreamRef          = useRef<MediaStream | null>(null);
  const audioCtxRef           = useRef<AudioContext | null>(null);
  const recordingDestRef      = useRef<MediaStreamAudioDestinationNode | null>(null);
  const webcamStreamRef       = useRef<MediaStream | null>(null);
  const webcamVideoRef        = useRef<HTMLVideoElement | null>(null);
  const interviewTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const headsUpTimerRef       = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isProcessingRef       = useRef(false);
  const recordingSessionIdRef = useRef<string>("");
  const partNumberRef         = useRef<number>(0);
  /* Promise chain — keeps chunk uploads sequential without blocking the UI */
  const uploadQueueRef        = useRef<Promise<void>>(Promise.resolve());
  const recordingStartRef     = useRef<number>(0);
  /* Mirrors of recording state so the page-unload handlers (which capture a
   * stale closure) always read the latest values. */
  const recordingSavedRef     = useRef(false);
  const isUploadingRef        = useRef(false);

  /* ── Pre-interview resume upload ───────────────────────────────────────── */
  const [resumePreUploading, setResumePreUploading] = useState(false);
  const [resumePreUploaded, setResumePreUploaded]   = useState(false);
  const [resumePreError, setResumePreError]         = useState<string | null>(null);
  const [resumePreFileName, setResumePreFileName]   = useState("");
  const resumePreFileRef = useRef<HTMLInputElement>(null);
  /* Ref so stale closures (voice callbacks, event handlers) always read the latest value */
  const resumePreUploadedRef = useRef(false);

  /* ── Resume parse & review ─────────────────────────────────────────────── */
  const [parsedResume, setParsedResume]               = useState<Record<string, any> | null>(null);
  const [showResumeReview, setShowResumeReview]       = useState(false);
  const [resumeParseNotice, setResumeParseNotice]     = useState<string | null>(null);
  const [resumeAutoParseLoading, setResumeAutoParseLoading] = useState(false);
  const parsedResumeRef = useRef<Record<string, any> | null>(null);
  const [reviewEdits, setReviewEdits] = useState({
    currentRole: "", yearsExperience: "", topSkills: "", industry: "", location: "",
  });
  /* true only when a resume was just freshly uploaded (triggers review screen);
     false when the parsed profile was loaded from DB (no review needed — already done) */
  const [resumeIsNew, setResumeIsNew] = useState(false);

  /* ── Post-interview resume upload (separate input since showIntro is false when isDone) */
  const postResumeFileRef = useRef<HTMLInputElement>(null);

  /* ── Mid-interview resume upload ───────────────────────────────────────── */
  const midResumeFileRef                            = useRef<HTMLInputElement>(null);
  const [midResumeUploading, setMidResumeUploading] = useState(false);
  const [midResumeDone, setMidResumeDone]           = useState(false);
  const [showMidPrompt, setShowMidPrompt]           = useState(true);

  const userMsgCount = messages.filter(m => m.role === "user").length;
  const MAX_Q = 9; // used only for the progress bar
  const isDone = isComplete; // API controls when to surface the "continue or analyze" choice

  /* Keep resumePreUploadedRef in sync so stale closures always read the latest value */
  useEffect(() => { resumePreUploadedRef.current = resumePreUploaded; }, [resumePreUploaded]);

  /* Keep isLoadingRef in sync — critical for voice-mode race condition guards */
  useEffect(() => { isLoadingRef.current = isLoading; }, [isLoading]);

  /* Keep isSpeakingRef in sync — checked in timer callbacks that can't read state */
  useEffect(() => { isSpeakingRef.current = isSpeaking; }, [isSpeaking]);

  /* ── Seed resume state from saved profile on mount ─────────────────────── */
  useEffect(() => {
    apiFetch(`${apiBase}/portal/career-profile`)
      .then(r => r.json())
      .then(async data => {
        const p = data.data;
        if (!p) return;

        if (p.resumeUrl) {
          setResumePreUploaded(true);
          resumePreUploadedRef.current = true;
        }

        if (p.resumeParsedProfile) {
          /* Already parsed — use it directly */
          const profile = p.resumeParsedProfile as Record<string, any>;
          setParsedResume(profile);
          parsedResumeRef.current = profile;
        } else if (p.resumeUrl) {
          /* Resume stored in S3 but never parsed — auto-parse now */
          setResumeAutoParseLoading(true);
          try {
            const parseRes = await apiFetch(`${apiBase}/portal/career-profile/resume/parse-existing`, { method: "POST" });
            const parseData = await parseRes.json();
            if (parseData.ok && parseData.profile) {
              setParsedResume(parseData.profile);
              parsedResumeRef.current = parseData.profile;
            }
            /* If parseError, silently continue — candidate can still do the interview */
          } catch {
            /* Network error — fail silently */
          } finally {
            setResumeAutoParseLoading(false);
          }
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading, interimText]);

  /* Keep muted ref in sync */
  useEffect(() => {
    speechMutedRef.current = speechMuted;
  }, [speechMuted]);

  /* Keep voiceMode ref in sync so stale closures always read the latest value */
  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);

  /* Clean up on unmount — stop mic, TTS, camera, webcam, and timers */
  useEffect(() => {
    return () => {
      stopListening();
      window.speechSynthesis?.cancel();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
        audioRef.current = null;
      }
      streamRef.current?.getTracks().forEach(t => t.stop());
      webcamStreamRef.current?.getTracks().forEach(t => t.stop());
      webcamStreamRef.current = null;
      if (interviewTimerRef.current) { clearTimeout(interviewTimerRef.current); interviewTimerRef.current = null; }
    };
  }, []);

  /* ── Screen recording functions ───────────────────────────────────────── */

  /**
   * Requests screen-capture via getDisplayMedia(), mixes in the mic, and
   * records in 10 s chunks uploaded live to S3:
   *   private/recordings/<sessionId>/part_<NNNN>.webm
   * Must be called (without await) inside a user-gesture handler so that
   * getDisplayMedia is still within the originating gesture.
   */
  async function startScreenRecording() {
    try {
      /* ── Step 1: screen capture + system audio ── */
      const displayStream = await (navigator.mediaDevices as any).getDisplayMedia({
        video: { displaySurface: "monitor", frameRate: { ideal: 15, max: 30 } },
        audio: true,
      });
      streamRef.current = displayStream;

      /* Stop recording if candidate clicks "Stop sharing" in the browser UI */
      displayStream.getVideoTracks()[0].onended = () => stopScreenRecording();

      /* ── Step 2: microphone ── */
      let micStream: MediaStream | null = null;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        micStreamRef.current = micStream;
      } catch { /* mic busy or denied — proceed without */ }

      /* ── Step 3: mix display audio + mic via AudioContext ── */
      let combinedStream: MediaStream;
      try {
        const audioCtx = new AudioContext();
        audioCtxRef.current = audioCtx;
        audioCtx.resume().catch(() => {});
        const dest = audioCtx.createMediaStreamDestination();
        recordingDestRef.current = dest;
        const dispAudio = displayStream.getAudioTracks();
        if (dispAudio.length > 0) audioCtx.createMediaStreamSource(new MediaStream(dispAudio)).connect(dest);
        if (micStream) audioCtx.createMediaStreamSource(micStream).connect(dest);
        combinedStream = new MediaStream([...displayStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
      } catch {
        combinedStream = new MediaStream([
          ...displayStream.getVideoTracks(),
          ...displayStream.getAudioTracks(),
          ...(micStream ? micStream.getAudioTracks() : []),
        ]);
      }

      const sessionId = crypto.randomUUID();
      recordingSessionIdRef.current = sessionId;
      partNumberRef.current = 0;
      uploadQueueRef.current = Promise.resolve();
      recordingStartRef.current = Date.now();
      setUploadedParts(0);
      setScreenRecording(true);

      const mimeType = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm",
      ].find(t => MediaRecorder.isTypeSupported(t)) ?? "video/webm";

      const recorder = new MediaRecorder(combinedStream, {
        mimeType,
        videoBitsPerSecond: 600_000,
        audioBitsPerSecond: 128_000,
      });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size === 0) return;
        const blob    = e.data;
        const partNum = ++partNumberRef.current;
        const sid     = recordingSessionIdRef.current;
        const pad     = String(partNum).padStart(4, "0");
        uploadQueueRef.current = uploadQueueRef.current.then(async () => {
          setIsUploading(true);
          try {
            const fd = new FormData();
            fd.append("file", blob, `part_${pad}.webm`);
            fd.append("sessionId", sid);
            fd.append("partNumber", String(partNum));
            const res = await apiFetch(`${apiBase}/storage/uploads/recording/part`, { method: "POST", body: fd });
            if (!res.ok) {
              console.error(`[screen-rec] part ${partNum} upload failed (${res.status})`);
            } else {
              setUploadedParts(partNum);
              console.info(`[screen-rec] part ${partNum} saved (${Math.round(blob.size / 1024)} KB)`);
            }
          } catch (err) {
            console.error(`[screen-rec] part ${partNum} network error:`, err);
          } finally {
            setIsUploading(false);
          }
        });
      };

      recorder.start(10_000);
      setIsRecording(true);
    } catch (err: any) {
      console.error("[screen-rec] recording failed:", err);
    }
  }

  /**
   * Stops the screen recording, waits for any in-flight chunk uploads to
   * finish, then saves the session ID to the candidate's career profile so
   * recruiters can locate all parts via:
   *   private/recordings/<sessionId>/part_0001.webm, part_0002.webm, …
   */
  async function stopScreenRecording() {
    const recorder  = mediaRecorderRef.current;
    const sessionId = recordingSessionIdRef.current;
    const startTime = recordingStartRef.current;

    setIsRecording(false);
    setScreenRecording(false);

    /* Stop recorder — triggers final ondataavailable before onstop */
    if (recorder && recorder.state !== "inactive") {
      await new Promise<void>(resolve => {
        recorder.onstop = () => resolve();
        recorder.stop();
      });
    }

    /* Stop all capture streams, webcam, and close AudioContext */
    streamRef.current?.getTracks().forEach(t => t.stop());
    micStreamRef.current?.getTracks().forEach(t => t.stop());
    micStreamRef.current = null;
    webcamStreamRef.current?.getTracks().forEach(t => t.stop());
    webcamStreamRef.current = null;
    if (webcamVideoRef.current) { webcamVideoRef.current.srcObject = null; }
    setWebcamActive(false);
    recordingDestRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;

    /* Wait for all queued part uploads to complete */
    setIsUploading(true);
    await uploadQueueRef.current.catch(() => {});
    setIsUploading(false);

    if (!sessionId) return;

    try {
      const durationSec = Math.round((Date.now() - startTime) / 1000);
      await apiFetch(`${apiBase}/portal/career-interview/save-recording`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordingSessionId: sessionId, durationSec }),
      });
      setRecordingSaved(true);
      console.info(`[screen-rec] session ${sessionId} saved (${partNumberRef.current} parts, ${durationSec}s)`);
    } catch (err) {
      console.error("[screen-rec] Failed to save recording metadata:", err);
    }
  }

  /* Wire webcam stream into the <video> element once it renders.
     setWebcamActive(true) triggers the render; this effect runs after. */
  useEffect(() => {
    if (webcamActive && webcamVideoRef.current && webcamStreamRef.current) {
      webcamVideoRef.current.srcObject = webcamStreamRef.current;
      webcamVideoRef.current.play().catch(() => {});
    }
  }, [webcamActive]);

  /* Keep the unload-handler mirrors in sync with the latest state. */
  useEffect(() => { recordingSavedRef.current = recordingSaved; }, [recordingSaved]);
  useEffect(() => { isUploadingRef.current = isUploading; }, [isUploading]);

  /* ── Don't-lose-the-recording guards ─────────────────────────────────────
   * If a candidate closes the tab mid-interview, two things must happen:
   *   (C) warn them with a native confirm so they don't lose footage; and
   *   (B) fire a best-effort save so the server records what we have.
   * The save uses keepalive fetch (NOT navigator.sendBeacon) because the
   * candidate session is authenticated via a Bearer token that only apiFetch
   * can attach — sendBeacon cannot set an Authorization header. */
  useEffect(() => {
    const recordingInProgress = () =>
      !!recordingSessionIdRef.current && !recordingSavedRef.current;

    const flushSave = () => {
      if (!recordingInProgress()) return;
      const sid = recordingSessionIdRef.current;
      const durationSec = recordingStartRef.current
        ? Math.round((Date.now() - recordingStartRef.current) / 1000)
        : 0;
      try {
        apiFetch(`${apiBase}/portal/career-interview/save-recording`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recordingSessionId: sid, durationSec }),
          keepalive: true,
        }).catch(() => {});
      } catch { /* keepalive payload too large or blocked — nothing else to do */ }
    };

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (recordingInProgress() || isUploadingRef.current) {
        e.preventDefault();
        // Legacy browsers require returnValue to be set to show the prompt.
        e.returnValue = "";
      }
    };
    const handlePageHide = () => flushSave();
    const handleVisibility = () => { if (document.visibilityState === "hidden") flushSave(); };

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  /* Keep isCompleteRef in sync so voice closures always see the latest value */
  useEffect(() => { isCompleteRef.current = isComplete; }, [isComplete]);

  /* Keep isProcessingRef in sync so the auto-complete timer can check it */
  useEffect(() => { isProcessingRef.current = isProcessing; }, [isProcessing]);

  /* Trigger final upload when interview completes */
  useEffect(() => {
    if (isComplete && isRecording) {
      stopScreenRecording();
    }
  }, [isComplete]);

  /* Auto-proceed when isComplete — wait up to 8 s for TTS farewell to finish,
     then call completeInterview() automatically so the candidate never has to
     click a button and the profile is built immediately. */
  useEffect(() => {
    if (!isComplete) return;
    const autoTimer = setTimeout(() => {
      if (!isProcessingRef.current) {
        completeInterview();
      }
    }, 8000);
    return () => clearTimeout(autoTimer);
  }, [isComplete]);

  /* ---------- TTS ---------- */
  const speakText = useCallback(async (text: string, onDone?: () => void) => {
    if (speechMutedRef.current) { onDone?.(); return; }

    /* Bump generation — every callback from a previous speakText call becomes a no-op.
       This is the core fix for the dual-voice bug: when we stop old audio by setting
       src="" or calling speechSynthesis.cancel(), browsers fire onerror/onend on the
       old element which would call the old onDone → old onDone starts the mic → mic
       captures the new TTS audio → second LLM call fires in parallel. */
    const generation = ++ttsGenerationRef.current;
    const isCurrent = () => ttsGenerationRef.current === generation;

    /* Mark speaking SYNCHRONOUSLY before the async TTS API call so that any
       pending 700 ms mic-restart timers (from a previous TTS callback) see the
       correct isSpeakingRef value and do NOT reopen the mic. */
    isSpeakingRef.current = true;
    setIsSpeaking(true);

    /* Safety timeout — if audio.onended / speechSynthesis.onend never fires
       (e.g. autoplay blocked, voices not loaded, browser bug), this ensures
       isSpeaking never gets permanently stuck blocking the mic.
       90 s is generous even for a very long AI response. */
    const safetyTimer = setTimeout(() => {
      if (!isCurrent()) return;
      isSpeakingRef.current = false;
      setIsSpeaking(false);
      onDone?.();
    }, 90_000);

    /* Kill any active mic session first — TTS audio must not feed back into STT */
    if (recognitionRef.current) {
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      try { rec.stop(); } catch {}
    }
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    if (silenceWarningTimerRef.current) { clearTimeout(silenceWarningTimerRef.current); silenceWarningTimerRef.current = null; }
    setShowSilenceWarning(false);
    setIsListening(false);

    /* Stop previous audio — nullify handlers BEFORE pausing so onerror/onended
       from the old element don't fire the old onDone and re-open the mic. */
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    /* Cancel any browser TTS — also nullify via generation guard since cancel()
       fires utterance.onend in Chrome which would call the old onDone. */
    window.speechSynthesis?.cancel();

    try {
      const resp = await apiFetch(`${apiBase}/portal/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice: advisorVoiceRef.current, language: selectedLanguageRef.current }),
      });

      if (!resp.ok) throw new Error("TTS API failed");

      /* Another speakText call may have fired while we were awaiting the API */
      if (!isCurrent()) return;

      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      /* Start muted — Chrome always allows muted autoplay regardless of user-gesture
       * recency. We unmute immediately after play() resolves so the candidate hears
       * the full audio. This bypasses the NotAllowedError that fires when play() is
       * called several async operations after the originating button click. */
      audio.muted = true;
      audioRef.current = audio;

      /* Route TTS audio through the recording AudioContext so Lexy's voice is
       * captured in the recording mix without relying on system-audio capture.
       * createMediaElementSource "hijacks" the element's output into the graph;
       * we connect to both the recording destination AND the default speakers. */
      let ttsSource: MediaElementAudioSourceNode | null = null;
      const audioCtx = audioCtxRef.current;
      const recordingDest = recordingDestRef.current;
      if (audioCtx && recordingDest) {
        try {
          if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
          ttsSource = audioCtx.createMediaElementSource(audio);
          ttsSource.connect(recordingDest);         /* → into recording stream */
          ttsSource.connect(audioCtx.destination);  /* → speakers              */
        } catch {
          ttsSource = null; /* AudioContext unavailable — fall back to plain Audio */
        }
      }

      const cleanupTts = () => {
        clearTimeout(safetyTimer);
        URL.revokeObjectURL(url);
        ttsSource?.disconnect();
        audioRef.current = null;
      };

      audio.onended = () => {
        cleanupTts();
        if (!isCurrent()) return; /* stale — a newer TTS call owns the session */
        isSpeakingRef.current = false;
        setIsSpeaking(false);
        onDone?.();
      };
      audio.onerror = () => {
        cleanupTts();
        if (!isCurrent()) return; /* stale */
        isSpeakingRef.current = false;
        setIsSpeaking(false);
        onDone?.();
      };

      await audio.play();
      audio.muted = false; /* unmute after play() — audio starts from the beginning audibly */
    } catch {
      if (!isCurrent()) return;
      /* Fall back to browser SpeechSynthesis if TTS API or audio.play() fails.
         Guard against missing speechSynthesis (rare) and the known Chrome bug
         where utterance.onend never fires when no voice has loaded yet —
         both cases must still clear isSpeaking so the mic can restart. */
      if (!window.speechSynthesis) {
        clearTimeout(safetyTimer);
        isSpeakingRef.current = false;
        setIsSpeaking(false);
        onDone?.();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(
        text.replace(/[\u{1F000}-\u{1FFFF}]/gu, "").replace(/[\u{2600}-\u{27BF}]/gu, "").trim()
      );
      utterance.rate = 1.05;
      const endFallback = () => {
        clearTimeout(safetyTimer);
        if (!isCurrent()) return;
        isSpeakingRef.current = false;
        setIsSpeaking(false);
        onDone?.();
      };
      utterance.onend   = endFallback;
      utterance.onerror = endFallback;
      window.speechSynthesis.speak(utterance);
    }
  }, []);

  /* ---------- STT ---------- */
  const STT_LANG_MAP: Record<string, string> = {
    "en-US": "en-US", "en-GB": "en-GB", "en-AU": "en-AU", "en-IN": "en-IN", "en-CA": "en-CA",
    "es-ES": "es-ES", "es-MX": "es-MX", "es-US": "es-US",
    fr: "fr-FR", de: "de-DE", it: "it-IT", pt: "pt-BR", "pt-BR": "pt-BR", "pt-PT": "pt-PT",
    nl: "nl-NL", ru: "ru-RU", tr: "tr-TR",
    zh: "zh-CN", ja: "ja-JP", ko: "ko-KR", ar: "ar-SA",
    hi: "hi-IN", bn: "bn-IN", ta: "ta-IN", te: "te-IN",
    mr: "mr-IN", gu: "gu-IN", pa: "pa-IN",
    fil: "fil-PH", tl: "fil-PH",
    id: "id-ID", ms: "ms-MY", th: "th-TH", vi: "vi-VN", he: "he-IL",
  };

  /* How long to wait after the last spoken word before auto-sending (ms).
     6.5 s gives a comfortable buffer for pauses, thinking, or taking a breath.
     The earlier 4 s was too aggressive — some candidates pause mid-thought. */
  const SILENCE_SEND_DELAY = 6500;

  function buildRecognition() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR();
    r.continuous = true;      // keep listening through natural pauses
    r.interimResults = true;
    r.lang = STT_LANG_MAP[selectedLanguageRef.current] ?? "en-US";
    return r;
  }

  const startListening = useCallback(() => {
    if (VOICE_NOT_SUPPORTED) {
      setMicError("Speech recognition requires Chrome or Edge.");
      return;
    }
    setMicError(null);
    setInterimText("");
    accumulatedTranscriptRef.current = "";
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    if (silenceWarningTimerRef.current) { clearTimeout(silenceWarningTimerRef.current); silenceWarningTimerRef.current = null; }
    setShowSilenceWarning(false);

    const r = buildRecognition();
    if (!r) return;
    recognitionRef.current = r;
    let fullTranscript = "";

    /* ── 7-second silence warning ─────────────────────────────────────────
       Fires if the candidate hasn't spoken at all (or hasn't spoken since
       the last speech result). In voice mode, Lexy speaks the prompt aloud
       and then re-opens the mic. In text mode, just shows the visual banner. */
    const SILENCE_WARN_MS = 7000;
    const armSilenceWarning = () => {
      if (silenceWarningTimerRef.current) clearTimeout(silenceWarningTimerRef.current);
      silenceWarningTimerRef.current = setTimeout(() => {
        silenceWarningTimerRef.current = null;
        setShowSilenceWarning(true);

        if (voiceModeRef.current && !isLoadingRef.current) {
          /* Speak the "still there?" prompt, then re-open the mic */
          speakTextRef.current("Are you still there? Take your time, I'm listening.", () => {
            setShowSilenceWarning(false);
            setTimeout(() => {
              if (
                voiceModeRef.current &&
                !recognitionRef.current &&
                !isLoadingRef.current &&
                !isSpeakingRef.current &&
                !isCompleteRef.current
              ) {
                startListening();
              }
            }, 500);
          });
        } else {
          /* Text mode — just re-arm the visual banner */
          armSilenceWarning();
        }
      }, SILENCE_WARN_MS);
    };
    armSilenceWarning();

    const armSilenceTimer = () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(() => {
        silenceTimerRef.current = null;
        /* Silence threshold reached — stop and send */
        if (recognitionRef.current) {
          const rec = recognitionRef.current;
          recognitionRef.current = null;
          try { rec.stop(); } catch {}
        }
        if (silenceWarningTimerRef.current) { clearTimeout(silenceWarningTimerRef.current); silenceWarningTimerRef.current = null; }
        setShowSilenceWarning(false);
        if (fullTranscript.trim()) {
          setIsListening(false);
          setInterimText("");
          sendVoiceMessageRef.current(fullTranscript.trim());
        } else {
          setIsListening(false);
          setInterimText("");
        }
      }, SILENCE_SEND_DELAY);
    };

    r.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          fullTranscript += e.results[i][0].transcript;
        } else {
          interim += e.results[i][0].transcript;
        }
      }
      setInterimText(fullTranscript + interim);
      /* Speech detected — dismiss warning and reset both timers */
      setShowSilenceWarning(false);
      armSilenceWarning();
      armSilenceTimer();
    };

    r.onend = () => {
      /* ── Manual cancel or silence-timer stop ─────────────────────────────
         The silence timer and stopListening() both clear recognitionRef BEFORE
         calling rec.stop(), so recognitionRef is null here — just clean up. */
      if (!recognitionRef.current) {
        if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
        if (silenceWarningTimerRef.current) { clearTimeout(silenceWarningTimerRef.current); silenceWarningTimerRef.current = null; }
        setShowSilenceWarning(false);
        return;
      }

      /* ── Browser closed the session unexpectedly ─────────────────────────
         This fires routinely in continuous mode (natural pauses, browser
         timeouts, etc.) even while the candidate is mid-sentence.
         IMPORTANT: do NOT send here — the silence timer is the only gate to
         sending. Instead, restart recognition immediately so we keep listening
         and accumulating the full answer. */
      recognitionRef.current = null;

      if (voiceModeRef.current && !isLoadingRef.current && !isCompleteRef.current) {
        /* Restart seamlessly — candidate may just be pausing mid-thought */
        const nr = buildRecognition();
        if (nr) {
          recognitionRef.current = nr;
          nr.onresult = r.onresult;   // same closure → fullTranscript accumulates
          nr.onend    = r.onend;
          nr.onerror  = r.onerror;
          try { nr.start(); } catch { setIsListening(false); }
        }
        /* Leave the silence timer running — it will fire after SILENCE_SEND_DELAY
           of true silence and call sendVoiceMessageRef with the full transcript. */
      } else {
        /* Not in voice mode (text mode) or loading — send what we have */
        if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
        if (silenceWarningTimerRef.current) { clearTimeout(silenceWarningTimerRef.current); silenceWarningTimerRef.current = null; }
        setShowSilenceWarning(false);
        setIsListening(false);
        setInterimText("");
        if (fullTranscript.trim()) {
          sendVoiceMessageRef.current(fullTranscript.trim());
        }
      }
    };

    r.onerror = (e: any) => {
      if (e.error === "not-allowed") {
        recognitionRef.current = null;
        setIsListening(false);
        setMicError("Microphone access denied. Please allow mic in your browser settings.");
      } else if (e.error === "aborted") {
        /* Intentional stop via stopListening() — onend handles cleanup */
      } else if (e.error !== "no-speech") {
        setMicError("Mic error: " + e.error);
      }
    };

    r.start();
    setIsListening(true);
  }, []);

  function stopListening() {
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    if (silenceWarningTimerRef.current) { clearTimeout(silenceWarningTimerRef.current); silenceWarningTimerRef.current = null; }
    setShowSilenceWarning(false);
    if (recognitionRef.current) {
      const r = recognitionRef.current;
      recognitionRef.current = null; // clear first so onend knows it's manual cancel
      try { r.stop(); } catch {}
    }
    setIsListening(false);
    setInterimText("");
    accumulatedTranscriptRef.current = "";
  }

  function toggleMic() {
    if (isListening) {
      stopListening();
    } else {
      /* If TTS is currently playing, interrupt it before opening the mic.
         Bumping the generation counter invalidates all in-flight TTS callbacks
         so onDone / onend handlers from the old audio don't re-open the mic
         after we've manually started it here. */
      if (isSpeakingRef.current) {
        ttsGenerationRef.current++;
        if (audioRef.current) {
          audioRef.current.onended = null;
          audioRef.current.onerror = null;
          audioRef.current.pause();
          audioRef.current.src = "";
          audioRef.current = null;
        }
        window.speechSynthesis?.cancel();
        isSpeakingRef.current = false;
        setIsSpeaking(false);
      }
      startListening();
    }
  }

  /* ---------- Send helpers ---------- */
  function handleContinueSharing() {
    // Don't allow re-entry if the safety cap already fired — every subsequent message
    // would immediately re-trigger isComplete and produce another closing message.
    if (isHardComplete) return;
    setIsComplete(false);
    pendingAutoListen.current = false;
    if (voiceMode) {
      setTimeout(() => {
        if (voiceModeRef.current && !recognitionRef.current && !isLoadingRef.current && !isSpeakingRef.current) {
          startListening();
        }
      }, 400);
    }
  }

  /* Keep speakTextRef in sync — lets timers / recognition handlers call the live speakText */
  useEffect(() => { speakTextRef.current = speakText; }, [speakText]);

  // Keep sendVoiceMessageRef in sync on every render so startListening's closure
  // always dispatches through the latest version (with current `messages` state).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { sendVoiceMessageRef.current = sendVoiceMessage; });

  async function sendVoiceMessage(text: string) {
    if (!text || isLoadingRef.current) return;
    // Never send messages once the interview is complete — stops the goodbye loop.
    // Use the ref so even mid-async voice closures see the latest value.
    if (isCompleteRef.current) return;
    /* Hard-stop the mic immediately — no more results while LLM processes */
    if (recognitionRef.current) {
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      try { rec.stop(); } catch {}
    }
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    if (silenceWarningTimerRef.current) { clearTimeout(silenceWarningTimerRef.current); silenceWarningTimerRef.current = null; }
    setShowSilenceWarning(false);
    setIsListening(false);
    setInterimText("");
    setError(null);
    const history = messages;
    const next: Message[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setIsLoading(true);

    try {
      const resp = await apiFetch(`${apiBase}/portal/career-interview/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history,
          language: selectedLanguageRef.current,
          persona: selectedPersona,
          resumeProfile: parsedResumeRef.current ?? null,
          hasResumeUrl: resumePreUploadedRef.current,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error ?? "Failed");

      if (data.voice) advisorVoiceRef.current = data.voice;
      const reply = data.reply as string;
      // Only add a bubble if the reply is non-empty (API no-op guard returns "")
      if (reply) setMessages(prev => [...prev, { role: "assistant", content: reply }]);

      // Client-side farewell guard: if the reply contains farewell language
      // and the API didn't already mark isComplete, treat it as complete anyway.
      const replyLower = reply.toLowerCase();
      // Only unambiguous closing phrases — avoid broad matches like "have a great" or "all the best"
      // that can appear in normal mid-interview acknowledgements.
      const farewellKeywords = ["take care!", "good luck!", "best of luck!", "goodbye!", "goodbye.", "goodbye,"];
      const looksLikeFarewell = farewellKeywords.some(f => replyLower.includes(f));
      const effectivelyComplete = data.isComplete || looksLikeFarewell;

      if (effectivelyComplete) {
        // Update ref SYNCHRONOUSLY so any pending 700ms timer sees it immediately
        isCompleteRef.current = true;
        setIsComplete(true);
        if (data.hardComplete) setIsHardComplete(true);
        // Kill mic immediately — no further voice input after goodbye
        pendingAutoListen.current = false;
        if (recognitionRef.current) {
          try { recognitionRef.current.stop(); } catch {}
          recognitionRef.current = null;
        }
        setIsListening(false);
        speakText(reply);
      } else if (voiceModeRef.current) {
        speakText(reply, () => {
          if (pendingAutoListen.current) {
            pendingAutoListen.current = false;
            /* 700ms gap so speaker audio fully decays before mic opens —
               prevents residual TTS echo from being captured as user speech */
            setTimeout(() => {
              /* Five-way guard — any one of these blocks mic restart:
                 1. voice mode was turned off
                 2. recognition already open (concurrent start)
                 3. another LLM call is already in flight
                 4. another TTS is now playing (new question queued)
                 5. interview is complete (isCompleteRef updated synchronously) */
              if (
                voiceModeRef.current &&
                !recognitionRef.current &&
                !isLoadingRef.current &&
                !isSpeakingRef.current &&
                !isCompleteRef.current
              ) startListening();
            }, 700);
          }
        });
        pendingAutoListen.current = true;
      }
    } catch {
      setError("Oops — something went wrong. Please try again.");
      setMessages(history);
    } finally {
      setIsLoading(false);
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || isLoading) return;
    // Never send messages once the interview is complete — stops the goodbye loop
    if (isComplete) return;
    setInput("");
    setError(null);
    const history = messages;
    const next: Message[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setIsLoading(true);

    try {
      const resp = await apiFetch(`${apiBase}/portal/career-interview/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history,
          language: selectedLanguageRef.current,
          persona: selectedPersona,
          resumeProfile: parsedResumeRef.current ?? null,
          hasResumeUrl: resumePreUploadedRef.current,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error ?? "Failed");

      if (data.voice) advisorVoiceRef.current = data.voice;
      const reply = data.reply as string;
      if (reply) setMessages(prev => [...prev, { role: "assistant", content: reply }]);

      // Client-side farewell guard: catch any slip-through farewell language
      // Only unambiguous closing phrases — no broad terms that appear in normal replies.
      const replyLower2 = reply.toLowerCase();
      const farewellKeywords2 = [
        "take care!", "take care,", "take care.",
        "good luck!", "best of luck!", "best of luck,", "best of luck.",
        "goodbye!", "goodbye.", "goodbye,",
        "career journey", "exciting career", "feel free to reach out",
      ];
      const looksLikeFarewell2 = farewellKeywords2.some(f => replyLower2.includes(f));

      if (data.isComplete || looksLikeFarewell2) {
        // Update ref SYNCHRONOUSLY before the async state update
        isCompleteRef.current = true;
        setIsComplete(true);
        if (data.hardComplete) setIsHardComplete(true);
      }
    } catch {
      setError("Oops — something went wrong. Please try again.");
      setMessages(history);
    } finally {
      setIsLoading(false);
    }
  }

  async function completeInterview() {
    if (isProcessingRef.current) return; // guard against double-calls from auto-timer + button
    setIsProcessing(true);
    isProcessingRef.current = true;
    setError(null);
    window.speechSynthesis?.cancel();
    if (interviewTimerRef.current) { clearTimeout(interviewTimerRef.current); interviewTimerRef.current = null; }
    try {
      const resp = await apiFetch(`${apiBase}/portal/career-interview/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history: messages, language: selectedLanguageRef.current }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error ?? "Failed to save profile");
      /* Skip the resume onboarding step if they already uploaded one */
      if (resumePreUploadedRef.current) {
        navigate("/portal/career");
      } else {
        navigate("/portal/onboarding/resume");
      }
    } catch {
      setError("Failed to save your career profile. Please try again.");
      setIsProcessing(false);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function restart() {
    stopListening();
    window.speechSynthesis?.cancel();
    pendingAutoListen.current = false;
    setMessages([OPENING_MESSAGE]);
    setInput("");
    setIsComplete(false);
    setError(null);
    setInterimText("");
    setIsSpeaking(false);
    setIsListening(false);
  }

  /* When switching TO voice mode, speak the last assistant message */
  function activateVoiceMode() {
    setVoiceMode(true);
    setInput("");
    const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
    if (lastAssistant && !isDone) {
      speakText(lastAssistant.content, () => {
        setTimeout(() => {
          if (voiceModeRef.current && !recognitionRef.current && !isLoadingRef.current && !isSpeakingRef.current && !isCompleteRef.current) {
            startListening();
          }
        }, 700);
      });
    }
  }

  function deactivateVoiceMode() {
    stopListening();
    window.speechSynthesis?.cancel();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    pendingAutoListen.current = false;
    setIsSpeaking(false);
    setVoiceMode(false);
  }

  /* ---------- Pre-interview resume upload + parse ---------- */
  async function handlePreResumeFile(file: File) {
    const allowed = ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
    if (!allowed.includes(file.type)) { setResumePreError("PDF or Word only (.pdf, .doc, .docx)"); return; }
    if (file.size > 10 * 1024 * 1024) { setResumePreError("Max 10 MB"); return; }
    setResumePreError(null);
    setResumeParseNotice(null);
    setResumePreUploading(true);
    try {
      /* 1. Upload file to storage */
      const formData = new FormData();
      formData.append("file", file);
      const uploadRes = await apiFetch(`${apiBase}/storage/uploads/file`, { method: "POST", body: formData });
      if (!uploadRes.ok) throw new Error("Upload failed");
      const { objectPath } = await uploadRes.json();

      /* 2. Save resume URL to candidate profile */
      await apiFetch(`${apiBase}/portal/career-profile/resume`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resumeObjectPath: objectPath }),
      });

      /* 3. Parse resume into structured profile */
      const parseFormData = new FormData();
      parseFormData.append("file", file);
      const parseRes = await apiFetch(`${apiBase}/portal/career-profile/resume/parse`, {
        method: "POST", body: parseFormData,
      });
      const parseData = await parseRes.json();

      if (parseData.parseError) {
        /* Parse failed — if we already have parsed data from a previous upload,
           keep using it silently with no warning (interview is still personalised).
           Only show the notice when there is truly no existing profile data at all. */
        if (!parsedResumeRef.current) {
          setResumeParseNotice("Couldn't fully read your resume, but you can still continue with the interview.");
        }
        setResumePreUploaded(true);
        setResumePreFileName(file.name);
        return;
      }

      /* Success — show review screen */
      const profile = parseData.profile as Record<string, any>;
      setParsedResume(profile);
      parsedResumeRef.current = profile;
      setReviewEdits({
        currentRole:     profile.likely_role       ?? "",
        yearsExperience: profile.total_years_experience != null ? String(profile.total_years_experience) : "",
        topSkills:       (profile.core_skills ?? []).join(", "),
        industry:        (profile.industries   ?? []).join(", "),
        location:        profile.location       ?? "",
      });
      setResumePreUploaded(true);
      setResumePreFileName(file.name);
      setResumeIsNew(true);
      setShowResumeReview(true);
    } catch {
      setResumePreError("Upload failed — try again.");
    } finally {
      setResumePreUploading(false);
    }
  }

  /* ---------- Mid-interview resume upload ---------- */
  async function handleMidResumeFile(file: File) {
    const allowed = ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
    if (!allowed.includes(file.type)) return;
    if (file.size > 10 * 1024 * 1024) return;
    setMidResumeUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const uploadRes = await apiFetch(`${apiBase}/storage/uploads/file`, { method: "POST", body: formData });
      if (!uploadRes.ok) throw new Error();
      const { objectPath } = await uploadRes.json();
      await apiFetch(`${apiBase}/portal/career-profile/resume`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resumeObjectPath: objectPath }),
      });
      const parseFormData = new FormData();
      parseFormData.append("file", file);
      const parseRes = await apiFetch(`${apiBase}/portal/career-profile/resume/parse`, {
        method: "POST", body: parseFormData,
      });
      const parseData = await parseRes.json();
      if (!parseData.parseError && parseData.profile) {
        parsedResumeRef.current = parseData.profile;
        setParsedResume(parseData.profile);
      }
      setMidResumeDone(true);
    } catch {
      setMidResumeDone(true); // fail silently — interview continues
    } finally {
      setMidResumeUploading(false);
    }
  }

  /* ---------- Start interview — fetches opening greeting in selected language ---------- */
  async function handleStart(editedProfile?: Record<string, any> | null) {
    /* ── 0. AI + biometric (BIPA) consent gate ─────────────────────────────
       Route the candidate to the disclosure / permission page BEFORE turning
       on the webcam or starting any recording. The backend __start__ branch
       enforces the same gate (412 AI_CONSENT_REQUIRED) as a hard backstop. */
    try {
      const cr = await apiFetch(`${apiBase}/portal/candidate/ai-consent`);
      const cj = await cr.json();
      if (!cj?.active) {
        navigate(`/portal/interview-consent?returnTo=${encodeURIComponent(window.location.pathname)}`);
        return;
      }
    } catch { /* network hiccup — fall through; the backend 412 backstops below */ }

    /* ── 1. Webcam preview + mic pre-authorisation ─────────────────────────
       Request camera AND audio together so the browser grants both in one
       prompt. The stream is stored for the PiP preview; mic permission is
       cached so SpeechRecognition never triggers a second dialog mid-interview.
       The <video> element is muted so there is no audio feedback.  */
    try {
      const webcamStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      webcamStreamRef.current = webcamStream;
      setWebcamActive(true);
      if (webcamVideoRef.current) {
        webcamVideoRef.current.srcObject = webcamStream;
        webcamVideoRef.current.play().catch(() => {});
      }
    } catch { /* no webcam — continue without preview */ }

    /* ── 2. Screen recording (getDisplayMedia) — still within user gesture ─
       Called without await so the interview API call proceeds in parallel.
       The browser's native screen-picker dialog will appear once.           */
    startScreenRecording();

    /* ── 3. 15-minute hard wall-clock cap + 14-min heads-up ────────────────
       No interview should run longer than 15 minutes regardless of AI state.
       At the 14-minute mark, inject a heads-up message (and TTS-speak it in
       voice mode) so the candidate knows they have ~1 minute left. */
    if (interviewTimerRef.current) clearTimeout(interviewTimerRef.current);
    if (headsUpTimerRef.current) clearTimeout(headsUpTimerRef.current);
    headsUpTimerRef.current = setTimeout(() => {
      if (isCompleteRef.current) return;
      setMessages(prev => [...prev, { role: "assistant", content: HEADS_UP_MESSAGE }]);
      if (voiceModeRef.current) {
        try { speakTextRef.current(HEADS_UP_MESSAGE); } catch { /* ignore TTS errors */ }
      }
    }, 14 * 60 * 1000);
    interviewTimerRef.current = setTimeout(() => {
      if (!isCompleteRef.current) {
        isCompleteRef.current = true;
        setIsComplete(true);
        setIsHardComplete(true);
      }
    }, 15 * 60 * 1000);

    /* Merge any review edits back into parsedResume before starting */
    let activeProfile = editedProfile ?? parsedResumeRef.current;
    if (activeProfile && reviewEdits.currentRole) {
      activeProfile = {
        ...activeProfile,
        likely_role: reviewEdits.currentRole || activeProfile.likely_role,
        total_years_experience: reviewEdits.yearsExperience ? parseInt(reviewEdits.yearsExperience) || activeProfile.total_years_experience : activeProfile.total_years_experience,
        core_skills: reviewEdits.topSkills ? reviewEdits.topSkills.split(",").map((s: string) => s.trim()).filter(Boolean) : activeProfile.core_skills,
        industries: reviewEdits.industry ? reviewEdits.industry.split(",").map((s: string) => s.trim()).filter(Boolean) : activeProfile.industries,
        location: reviewEdits.location || activeProfile.location,
      };
      parsedResumeRef.current = activeProfile;
      setParsedResume(activeProfile);
    }

    advisorVoiceRef.current = "shimmer";
    selectedLanguageRef.current = selectedLanguage;
    setMessages([]);
    setShowIntro(false);
    setShowResumeReview(false);
    setIsLoading(true);
    try {
      const resp = await apiFetch(`${apiBase}/portal/career-interview/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "__start__", history: [], language: selectedLanguage, persona: "lexy", resumeProfile: activeProfile ?? null, hasResumeUrl: resumePreUploadedRef.current }),
      });
      const data = await resp.json();
      if (resp.status === 412 && data?.error === "AI_CONSENT_REQUIRED") {
        navigate(`/portal/interview-consent?returnTo=${encodeURIComponent(window.location.pathname)}`);
        return;
      }
      if (resp.ok && data.reply) {
        setMessages([{ role: "assistant", content: data.reply }]);
      } else {
        setMessages([{ role: "assistant", content: "Hi! I'm Lexy, your personal career advisor. This interview will take about 15 minutes, and I'll give you a heads-up about a minute before we wrap up. I'm here to build your personalised career profile and map out some exciting paths for you.\n\nLet's start simple — what's your current role and company?" }]);
      }
    } catch {
      setMessages([{ role: "assistant", content: "Hi! I'm Lexy, your personal career advisor. This interview will take about 15 minutes, and I'll give you a heads-up about a minute before we wrap up. I'm here to build your personalised career profile and map out some exciting paths for you.\n\nLet's start simple — what's your current role and company?" }]);
    } finally {
      setIsLoading(false);
    }
  }

  /* ---------- Resume review screen (shown only after a fresh upload, before interview) ---------- */
  if (showIntro && showResumeReview && resumeIsNew && parsedResume) {
    const r = parsedResume;
    return (
      <AppLayout>
        <div className="max-w-xl mx-auto flex flex-col gap-6">
          {/* Header */}
          <div className="text-center space-y-1">
            <div className="flex items-center justify-center gap-2 text-emerald-400 mb-2">
              <CheckCircle2 className="w-5 h-5" />
              <span className="text-sm font-medium">Resume uploaded</span>
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Here's what I understood about your background</h1>
            <p className="text-sm text-muted-foreground">Review and correct anything before we start — I'll skip the basics and go straight to deeper questions.</p>
          </div>

          {/* Profile summary card */}
          <div className="bg-card border border-border/60 rounded-2xl p-5 space-y-4">
            {/* Auto-parsed chips */}
            {(r.core_skills?.length || r.tools?.length || r.certifications?.length) && (
              <div className="flex flex-wrap gap-1.5">
                {(r.core_skills ?? []).slice(0, 6).map((s: string) => (
                  <span key={s} className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-medium">{s}</span>
                ))}
                {(r.tools ?? []).slice(0, 4).map((t: string) => (
                  <span key={t} className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-xs">{t}</span>
                ))}
                {(r.certifications ?? []).map((c: string) => (
                  <span key={c} className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 text-xs">{c}</span>
                ))}
              </div>
            )}

            {r.career_summary && (
              <p className="text-sm text-muted-foreground leading-relaxed border-l-2 border-primary/30 pl-3 italic">{r.career_summary}</p>
            )}

            {/* Editable fields */}
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground font-medium">Current role</label>
                <input
                  value={reviewEdits.currentRole}
                  onChange={e => setReviewEdits(p => ({ ...p, currentRole: e.target.value }))}
                  placeholder={r.likely_role ?? "e.g. Software Engineer"}
                  className="w-full bg-background border border-border/60 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground font-medium">Years of experience</label>
                <input
                  value={reviewEdits.yearsExperience}
                  onChange={e => setReviewEdits(p => ({ ...p, yearsExperience: e.target.value }))}
                  placeholder={r.total_years_experience != null ? String(r.total_years_experience) : "e.g. 5"}
                  className="w-full bg-background border border-border/60 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground font-medium">Top skills (comma-separated)</label>
                <input
                  value={reviewEdits.topSkills}
                  onChange={e => setReviewEdits(p => ({ ...p, topSkills: e.target.value }))}
                  placeholder={(r.core_skills ?? []).join(", ") || "e.g. React, Python, SQL"}
                  className="w-full bg-background border border-border/60 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground font-medium">Industry</label>
                <input
                  value={reviewEdits.industry}
                  onChange={e => setReviewEdits(p => ({ ...p, industry: e.target.value }))}
                  placeholder={(r.industries ?? []).join(", ") || "e.g. FinTech, SaaS"}
                  className="w-full bg-background border border-border/60 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
                />
              </div>
              {(r.location || reviewEdits.location) && (
                <div className="col-span-2 space-y-1">
                  <label className="text-xs text-muted-foreground font-medium">Location</label>
                  <input
                    value={reviewEdits.location}
                    onChange={e => setReviewEdits(p => ({ ...p, location: e.target.value }))}
                    placeholder={r.location ?? "e.g. Mumbai, India"}
                    className="w-full bg-background border border-border/60 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
                  />
                </div>
              )}
            </div>

            {r.education && (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5 pt-1">
                <FileText className="w-3.5 h-3.5 shrink-0" />
                {r.education}
              </p>
            )}
          </div>

          {/* Signal label */}
          <p className="text-xs text-center text-muted-foreground/50">
            Resume data is marked as <span className="text-muted-foreground">self-reported</span>. The interview validates and builds on it.
          </p>

          {/* CTA */}
          <div className="flex flex-col items-center gap-3">
            <Button size="lg" className="gap-2 px-10 py-6 text-base font-semibold w-full" onClick={() => handleStart()}>
              <Sparkles className="w-5 h-5" />
              Start tailored interview
              <ArrowRight className="w-4 h-4" />
            </Button>
            <button
              onClick={() => { setShowResumeReview(false); setParsedResume(null); parsedResumeRef.current = null; }}
              className="text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            >
              Skip — start without resume
            </button>
            <div className="flex items-start gap-2.5 bg-muted/30 border border-border/40 rounded-xl px-4 py-3 max-w-sm mx-auto text-left">
              <div className="flex gap-1.5 shrink-0 mt-0.5">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary/70"><path d="M15 10l4.553-2.069A1 1 0 0 1 21 8.82v6.36a1 1 0 0 1-1.447.889L15 14"/><rect x="1" y="6" width="14" height="12" rx="2"/></svg>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary/70"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Your camera and microphone will activate automatically when the interview starts. Your browser may prompt you once the very first time on this device.
              </p>
            </div>
          </div>
        </div>
      </AppLayout>
    );
  }

  /* ---------- Intro screen ---------- */
  if (showIntro) {
    const LANGUAGES = [
      { code: "en-US", label: "English (US)", flag: "🇺🇸" },
      { code: "en-GB", label: "English (UK)", flag: "🇬🇧" },
      { code: "en-AU", label: "English (AU)", flag: "🇦🇺" },
      { code: "en-IN", label: "English (IN)", flag: "🇮🇳" },
      { code: "en-CA", label: "English (CA)", flag: "🇨🇦" },
      { code: "es-ES", label: "Español (España)", flag: "🇪🇸" },
      { code: "es-MX", label: "Español (México)", flag: "🇲🇽" },
      { code: "es-US", label: "Español (US)", flag: "🇺🇸" },
      { code: "fr",    label: "Français",          flag: "🇫🇷" },
      { code: "de",    label: "Deutsch",            flag: "🇩🇪" },
      { code: "it",    label: "Italiano",           flag: "🇮🇹" },
      { code: "pt-BR", label: "Português (Brasil)",   flag: "🇧🇷" },
      { code: "pt-PT", label: "Português (Portugal)", flag: "🇵🇹" },
      { code: "nl",    label: "Nederlands",         flag: "🇳🇱" },
      { code: "ru",    label: "Русский",            flag: "🇷🇺" },
      { code: "zh",    label: "中文",               flag: "🇨🇳" },
      { code: "ja",    label: "日本語",              flag: "🇯🇵" },
      { code: "ko",    label: "한국어",              flag: "🇰🇷" },
      { code: "ar",    label: "العربية",            flag: "🇸🇦" },
      { code: "tr",    label: "Türkçe",             flag: "🇹🇷" },
      { code: "hi",    label: "हिन्दी",              flag: "🇮🇳" },
      { code: "bn",    label: "বাংলা",              flag: "🇧🇩" },
      { code: "ta",    label: "தமிழ்",              flag: "🇮🇳" },
      { code: "te",    label: "తెలుగు",             flag: "🇮🇳" },
      { code: "mr",    label: "मराठी",              flag: "🇮🇳" },
      { code: "gu",    label: "ગુજરાતી",            flag: "🇮🇳" },
      { code: "pa",    label: "ਪੰਜਾਬੀ",            flag: "🇮🇳" },
      { code: "fil",   label: "Filipino",           flag: "🇵🇭" },
      { code: "id",    label: "Bahasa Indonesia",   flag: "🇮🇩" },
      { code: "ms",    label: "Bahasa Melayu",      flag: "🇲🇾" },
      { code: "th",    label: "ไทย",                flag: "🇹🇭" },
      { code: "vi",    label: "Tiếng Việt",         flag: "🇻🇳" },
      { code: "he",    label: "עברית",              flag: "🇮🇱" },
    ];

    const activeLang = LANGUAGES.find(l => l.code === selectedLanguage) ?? LANGUAGES[0];

    return (
      <AppLayout>
        <div className="max-w-2xl mx-auto flex flex-col items-center gap-6">
          {/* Title */}
          <div className="text-center space-y-1">
            <h1 className="text-3xl font-bold tracking-tight">Meet Lexy</h1>
            <p className="text-muted-foreground">Your AI career advisor — ready to map out your next move</p>
          </div>

          {/* Lexy intro video */}
          <div className="w-full rounded-2xl overflow-hidden border border-border/50 shadow-xl shadow-black/40" style={{ aspectRatio: "16/9" }}>
            <LexyIntro />
          </div>

          {/* Language selector */}
          <div className="w-full max-w-sm space-y-2">
            <label className="text-sm font-medium text-foreground flex items-center gap-2">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary">
                <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
              </svg>
              Interview language
            </label>
            <div className="relative">
              <select
                value={selectedLanguage}
                onChange={e => setSelectedLanguage(e.target.value)}
                className="w-full appearance-none bg-card border border-border/60 rounded-xl px-4 py-3 pr-10 text-sm text-foreground focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30 cursor-pointer"
              >
                {LANGUAGES.map(l => (
                  <option key={l.code} value={l.code}>{l.flag}  {l.label}</option>
                ))}
              </select>
              <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>
            </div>
            {selectedLanguage !== "en-US" && (
              <p className="text-xs text-primary/80 flex items-center gap-1.5">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                Lexy will conduct the entire interview in {activeLang.label}
              </p>
            )}
          </div>

          {/* CTA */}
          <div className="w-full space-y-4">
            <input
              ref={resumePreFileRef} type="file" accept=".pdf,.doc,.docx" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handlePreResumeFile(f); e.target.value = ""; }}
            />

            {resumePreUploading ? (
              /* Uploading state */
              <div className="w-full flex flex-col items-center gap-3 p-5 rounded-2xl border border-primary/20 bg-primary/5">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
                <p className="text-sm text-muted-foreground">Reading your resume…</p>
              </div>
            ) : resumePreUploaded ? (
              /* Resume already on file */
              <div className="w-full flex flex-col items-center gap-3 p-5 rounded-2xl border border-emerald-400/30 bg-emerald-400/5">
                <div className="flex items-center gap-2">
                  {resumeAutoParseLoading
                    ? <Loader2 className="w-4 h-4 animate-spin text-emerald-400 shrink-0" />
                    : <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  }
                  <span className="text-sm font-semibold text-emerald-400">
                    {resumeAutoParseLoading ? "Reading your resume…" : "Resume uploaded — interview will be personalised"}
                  </span>
                </div>
                {!resumeAutoParseLoading && parsedResume && (
                  <p className="text-xs text-emerald-400/70">
                    ✓ Lexy has read your resume and will personalise the interview
                  </p>
                )}
                {!resumeAutoParseLoading && resumeParseNotice && <p className="text-xs text-amber-400/80">{resumeParseNotice}</p>}
                <button
                  onClick={() => resumePreFileRef.current?.click()}
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                >
                  Replace resume
                </button>
                <Button size="lg" className="w-full gap-2 py-6 text-base font-semibold" onClick={() => handleStart()}>
                  <Sparkles className="w-5 h-5" />
                  Start My Interview
                </Button>
              </div>
            ) : (
              /* No resume — show the two-option card */
              <div className="w-full rounded-2xl border border-border/50 bg-card overflow-hidden">
                <div className="p-5 space-y-2">
                  <p className="text-sm font-semibold text-foreground">Make it more personal (optional)</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Upload your resume and Lexy will tailor every question to your background — skipping basics she already knows and going deeper on what matters.
                  </p>
                  {resumePreError && <p className="text-xs text-red-400">{resumePreError}</p>}
                </div>
                <div className="flex border-t border-border/40">
                  <button
                    onClick={() => resumePreFileRef.current?.click()}
                    className="flex-1 flex items-center justify-center gap-2 py-3.5 text-sm font-semibold text-primary hover:bg-primary/8 transition-colors border-r border-border/40"
                  >
                    <FileUp className="w-4 h-4" />
                    Upload Resume
                  </button>
                  <button
                    onClick={() => handleStart()}
                    className="flex-1 flex items-center justify-center gap-2 py-3.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                  >
                    Skip for now
                  </button>
                </div>
              </div>
            )}

            {!resumePreUploaded && !resumePreUploading && (
              <p className="text-center text-xs text-muted-foreground/40">~15 minutes · Voice or Text · Private & secure</p>
            )}
            <div className="flex items-start gap-2.5 bg-muted/30 border border-border/40 rounded-xl px-4 py-3 max-w-sm mx-auto text-left">
              <div className="flex gap-1.5 shrink-0 mt-0.5">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary/70"><path d="M15 10l4.553-2.069A1 1 0 0 1 21 8.82v6.36a1 1 0 0 1-1.447.889L15 14"/><rect x="1" y="6" width="14" height="12" rx="2"/></svg>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary/70"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Your camera and microphone will activate automatically when the interview starts. Your browser may prompt you once the very first time on this device.
              </p>
            </div>
          </div>
        </div>
      </AppLayout>
    );
  }

  /* ---------- Interview screen ---------- */
  return (
    <AppLayout>
      <style>{`
        @keyframes soundwave {
          0%, 100% { height: 4px; }
          50% { height: 20px; }
        }
        @keyframes micpulse {
          0%, 100% { opacity: 0.6; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.04); }
        }
        @keyframes recpulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        @keyframes soundBar {
          0%, 100% { transform: scaleY(0.4); }
          50% { transform: scaleY(1); }
        }
      `}</style>

      {/* ── Webcam PiP overlay — candidate sees their own face ── */}
      {webcamActive && (
        <div className="fixed bottom-6 left-6 z-50 flex flex-col items-start gap-1">
          <div className="relative rounded-2xl overflow-hidden border-2 border-primary/40 shadow-2xl shadow-black/60 bg-black"
            style={{ width: 160, height: 120 }}>
            <video
              ref={webcamVideoRef}
              autoPlay
              muted
              playsInline
              style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }}
            />
            {/* live indicator dot */}
            <div className="absolute top-2 right-2 flex items-center gap-1 bg-black/50 rounded-full px-1.5 py-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            </div>
          </div>
        </div>
      )}

      {/* ── Screen recording status overlay ── */}
      {(screenRecording || isUploading || recordingSaved) && (
        <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2">
          {/* Active recording badge */}
          {screenRecording && (
            <div className="flex items-center gap-2 bg-black/80 border border-red-500/40 rounded-xl px-3 py-2 text-xs text-white shadow-xl backdrop-blur-sm">
              <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" style={{ animation: "recpulse 1.2s ease-in-out infinite" }} />
              <Monitor className="w-3.5 h-3.5 text-red-400 shrink-0" />
              <span className="font-medium">Screen recording</span>
              {uploadedParts > 0 && (
                <span className="text-white/50">· {pluralize(uploadedParts, "part")} saved</span>
              )}
            </div>
          )}
          {/* Uploading a chunk */}
          {isUploading && (
            <div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 text-xs text-muted-foreground shadow-lg">
              <svg className="w-3 h-3 animate-spin text-primary" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25"/>
                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
              </svg>
              Uploading part {partNumberRef.current}…
            </div>
          )}
          {/* All done */}
          {recordingSaved && !isUploading && (
            <div className="flex items-center gap-1.5 bg-green-950/80 border border-green-700/40 rounded-lg px-3 py-2 text-xs text-green-400 shadow-lg">
              <CheckCircle2 className="w-3 h-3" />
              Recording saved ({pluralize(uploadedParts, "part")})
            </div>
          )}
        </div>
      )}


      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl overflow-hidden border-2 border-primary/30 flex-shrink-0">
                <img src="/lexy-avatar.jpeg" alt="Lexy" className="w-full h-full object-cover object-top" />
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight">
                  Lexy
                  <span className="text-muted-foreground font-normal"> · Career Interview</span>
                </h1>
                <p className="text-sm text-muted-foreground">~15 minutes · Builds your Career Hub</p>
              </div>
            </div>

            {/* Mode toggle + camera */}
            {!isDone && (
              <div className="flex items-center gap-2">
                {/* Text / Voice toggle */}
                <div className="flex items-center gap-0.5 bg-card border border-border/50 rounded-xl p-1">
                  <button
                    onClick={deactivateVoiceMode}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      !voiceMode
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Keyboard className="w-3.5 h-3.5" />
                    Text
                  </button>
                  <button
                    onClick={activateVoiceMode}
                    disabled={VOICE_NOT_SUPPORTED}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                      voiceMode
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Mic className="w-3.5 h-3.5" />
                    Voice
                  </button>
                </div>

                {/* Screen recording indicator / stop button.
                    Recording auto-starts when the interview begins.
                    Button is only shown once the interview is active so
                    the recruiter / candidate can stop it if needed.
                    Clicking when not recording retries the permission. */}
                {screenRecording ? (
                  <button
                    onClick={stopScreenRecording}
                    title="Stop screen recording"
                    className="relative flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-medium transition-all bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                    <MonitorOff className="w-3.5 h-3.5" />
                  </button>
                ) : screenError ? (
                  /* Recording was denied / failed — offer a retry */
                  <button
                    onClick={() => { setScreenError(null); startScreenRecording(); }}
                    title="Retry screen recording"
                    className="relative flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-medium transition-all bg-amber-500/10 border-amber-500/30 text-amber-400 hover:bg-amber-500/20"
                  >
                    <Monitor className="w-3.5 h-3.5" />
                    <span>Retry</span>
                  </button>
                ) : null}
              </div>
            )}
          </div>
          <ProgressDots userMsgCount={userMsgCount} />
        </div>

        {/* Lexy animated avatar */}
        {!isDone && (
          <div className="flex justify-center mb-5">
            <LexyAvatar
              state={
                isLoading   ? "thinking"  :
                isSpeaking  ? "speaking"  :
                isListening ? "listening" :
                "idle"
              }
            />
          </div>
        )}

        {/* Chat window */}
        <Card className="mb-4 border-border/50">
          <CardContent className="p-0">
            <div className="h-[400px] overflow-y-auto p-5 space-y-4">
              {messages.map((msg, i) => (
                <div key={i} className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}>
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                    msg.role === "assistant"
                      ? "bg-primary/10 text-primary"
                      : "bg-secondary text-muted-foreground"
                  }`}>
                    {msg.role === "assistant"
                      ? <Sparkles className="w-4 h-4" />
                      : <User className="w-4 h-4" />}
                  </div>
                  <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    msg.role === "assistant"
                      ? "bg-card border border-border/50 text-foreground rounded-tl-sm"
                      : "bg-primary text-primary-foreground rounded-tr-sm"
                  }`}>
                    {msg.content.split("\n").map((line, j) => (
                      <span key={j}>{line}{j < msg.content.split("\n").length - 1 && <br />}</span>
                    ))}
                  </div>
                </div>
              ))}

              {/* Loading typing indicator */}
              {isLoading && (
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
                    <Sparkles className="w-4 h-4" />
                  </div>
                  <div className="bg-card border border-border/50 rounded-2xl rounded-tl-sm px-4 py-3">
                    <div className="flex gap-1">
                      {[0,1,2].map(i => (
                        <div key={i} className="w-2 h-2 rounded-full bg-muted-foreground/50 animate-bounce"
                          style={{ animationDelay: `${i * 0.15}s` }} />
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Live interim transcript bubble in voice mode */}
              {voiceMode && interimText && (
                <div className="flex gap-3 flex-row-reverse">
                  <div className="w-8 h-8 rounded-full bg-secondary text-muted-foreground flex items-center justify-center shrink-0">
                    <User className="w-4 h-4" />
                  </div>
                  <div className="max-w-[85%] rounded-2xl rounded-tr-sm px-4 py-3 text-sm leading-relaxed bg-primary/20 border border-primary/30 text-primary-foreground/80 italic">
                    {interimText}
                    <span className="inline-block w-1 h-3 bg-primary ml-1 animate-pulse rounded-sm" />
                  </div>
                </div>
              )}

              {/* ── Mid-interview resume upload prompt ──
                  Only show when: 3+ messages in, no resume on file yet (neither the async flag
                  nor the already-loaded parsedResume), not already dismissed, and interview
                  not yet complete. This avoids the race condition where resumePreUploaded
                  hasn't been set yet but parsedResume already loaded from the profile. */}
              {userMsgCount >= 3 && !resumePreUploaded && !parsedResume && !midResumeDone && showMidPrompt && !isDone && (
                <div className="border border-dashed border-border/50 rounded-xl p-3 flex items-center gap-3 bg-card/40">
                  <input
                    ref={midResumeFileRef} type="file" accept=".pdf,.doc,.docx" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleMidResumeFile(f); }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-muted-foreground">
                      Want to speed this up?{" "}
                      <button
                        onClick={() => midResumeFileRef.current?.click()}
                        disabled={midResumeUploading}
                        className="text-primary underline underline-offset-2 hover:text-primary/80 disabled:opacity-50"
                      >
                        {midResumeUploading ? "Uploading…" : "Upload your resume"}
                      </button>
                      {" "}and I'll tailor the rest of the interview.
                    </p>
                  </div>
                  <button
                    onClick={() => setShowMidPrompt(false)}
                    className="text-muted-foreground/40 hover:text-muted-foreground text-xs shrink-0"
                  >✕</button>
                </div>
              )}

              <div ref={bottomRef} />
            </div>
          </CardContent>
        </Card>

        {/* Error */}
        {error && (
          <div className="mb-3 text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-2">
            {error}
          </div>
        )}
        {micError && (
          <div className="mb-3 flex items-start gap-2 text-sm text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-lg px-4 py-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            {micError}
          </div>
        )}

        {/* ---- Completion CTA ---- */}
        {isDone ? (
          <Card className="border-primary/20 bg-gradient-to-b from-primary/8 to-primary/3">
            <CardContent className="p-6 space-y-5">
              {/* Completion icon + title */}
              <div className="flex flex-col items-center text-center gap-3 pt-1">
                <div className="w-12 h-12 rounded-full bg-primary/15 ring-4 ring-primary/10 flex items-center justify-center">
                  <CheckCircle2 className="w-6 h-6 text-primary" />
                </div>
                <div className="space-y-1.5">
                  <h3 className="text-lg font-bold text-foreground tracking-tight">
                    Your interview is complete.
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed max-w-sm mx-auto">
                    We've analyzed how you think, communicate, and perform. Now let's turn that into real career insights.
                  </p>
                </div>
              </div>

              {/* Primary CTA */}
              <button
                onClick={completeInterview}
                disabled={isProcessing}
                className="w-full flex items-center justify-center gap-2.5 px-5 py-3.5 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 active:scale-[0.98] transition-all shadow-lg shadow-primary/25 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isProcessing ? (
                  <>
                    <div className="w-4 h-4 border-2 border-primary-foreground/40 border-t-primary-foreground rounded-full animate-spin" />
                    Building your insights…
                  </>
                ) : (
                  <>
                    See My Career Insights
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>

              {/* Secondary CTA — hidden when the safety cap has already fired */}
              {!isHardComplete && (
                <div className="text-center">
                  <button
                    onClick={handleContinueSharing}
                    disabled={isProcessing}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2 decoration-muted-foreground/40 disabled:opacity-50"
                  >
                    Add more details to improve accuracy
                  </button>
                </div>
              )}

              {/* Post-interview resume upload — prominent card when no resume on file */}
              {!resumePreUploaded && (
                <div className="rounded-xl border border-border/50 bg-muted/20 overflow-hidden">
                  <input
                    ref={postResumeFileRef} type="file" accept=".pdf,.doc,.docx" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handlePreResumeFile(f); e.target.value = ""; }}
                  />
                  <div className="px-4 pt-4 pb-3 space-y-1">
                    <p className="text-sm font-semibold text-foreground">Want even deeper insights?</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Upload your resume and we'll cross-reference it with your interview to build a richer career profile.
                    </p>
                  </div>
                  <div className="border-t border-border/40">
                    {resumePreUploading ? (
                      <div className="w-full flex items-center justify-center gap-2 py-3 text-sm text-muted-foreground">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Reading resume…
                      </div>
                    ) : (
                      <button
                        onClick={() => postResumeFileRef.current?.click()}
                        className="w-full flex items-center justify-center gap-2 py-3 text-sm font-medium text-primary hover:bg-primary/8 transition-colors"
                      >
                        <FileUp className="w-4 h-4" />
                        Upload Resume
                      </button>
                    )}
                  </div>
                  {resumePreError && (
                    <p className="text-xs text-red-400 text-center pb-3">{resumePreError}</p>
                  )}
                </div>
              )}
              {resumePreUploaded && (
                <div className="flex items-center justify-center gap-2 py-1">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-xs text-emerald-400">Resume uploaded — profile will be enhanced</span>
                </div>
              )}

              {/* Platform-discovery opt-in — the explicit consent choice.
                  Your profile stays private to you (and any company you
                  applied to) unless you say yes here or in Settings. */}
              <div className="rounded-xl border border-border/50 bg-muted/20 px-4 py-4 space-y-3">
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-foreground">Want other companies to discover you?</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    If you opt in, recruiters at licensed companies on Lexy can find your profile
                    (name, title, skills, experience) and contact you about matching roles. Your interview
                    recordings, scores, and evaluations are never shared. This is off by default — your
                    choice is recorded, and you can change it anytime in Settings.
                  </p>
                </div>
                {discoveryChoice === true ? (
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-xs text-emerald-400">You're discoverable — manage this in Settings anytime.</span>
                  </div>
                ) : discoveryChoice === false ? (
                  <p className="text-xs text-muted-foreground">Staying private. You can opt in later from Settings.</p>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={() => chooseDiscovery(true)}
                      disabled={discoveryBusy}
                      className="flex-1 py-2 rounded-lg bg-primary/15 text-primary text-xs font-semibold hover:bg-primary/25 transition-colors disabled:opacity-50"
                    >
                      Yes, make me discoverable
                    </button>
                    <button
                      onClick={() => chooseDiscovery(false)}
                      disabled={discoveryBusy}
                      className="flex-1 py-2 rounded-lg border border-border/50 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                    >
                      Not now
                    </button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

        ) : voiceMode ? (
          /* ---- VOICE INPUT UI ---- */
          <div className="flex flex-col items-center gap-5 py-2">
            {/* Lexy speaking indicator */}
            <div className={`flex items-center gap-3 text-sm transition-all duration-300 ${
              isSpeaking ? "opacity-100" : "opacity-0 pointer-events-none"
            }`}>
              <SpeakingWave />
              <span className="text-primary font-medium">Lexy is speaking…</span>
              <SpeakingWave />
            </div>

            {/* 7-second silence warning — shown when mic is on but candidate hasn't spoken */}
            {showSilenceWarning && isListening && (
              <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-400/30 text-amber-300 rounded-xl px-4 py-2 text-sm animate-pulse max-w-xs text-center">
                <span className="text-base">🎤</span>
                <span>Still there? Take your time — I'm listening.</span>
              </div>
            )}

            {/* Big mic button */}
            <div className="relative flex items-center justify-center">
              {isListening && <ListeningRings />}
              <button
                onClick={toggleMic}
                disabled={isLoading}
                className={`relative z-10 w-20 h-20 rounded-full flex items-center justify-center transition-all duration-200 shadow-lg disabled:opacity-40 disabled:cursor-not-allowed ${
                  isListening
                    ? "bg-red-500 hover:bg-red-600 shadow-red-500/30"
                    : "bg-primary hover:bg-primary/90 shadow-primary/30"
                }`}
                style={isListening ? { animation: "micpulse 1.5s ease-in-out infinite" } : {}}
              >
                {isListening
                  ? <MicOff className="w-8 h-8 text-white" />
                  : <Mic className="w-8 h-8 text-primary-foreground" />
                }
              </button>
            </div>

            {/* Status text */}
            <p className="text-sm text-muted-foreground text-center">
              {isLoading
                ? "Lexy is thinking…"
                : isSpeaking
                  ? "Tap mic to interrupt and reply"
                  : isListening
                    ? "Listening… speak naturally, pausing sends"
                    : "Tap the mic to speak"}
            </p>

            {/* Mute TTS toggle */}
            <button
              onClick={() => setSpeechMuted(m => !m)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {speechMuted
                ? <><VolumeX className="w-3.5 h-3.5" /> Voice responses off</>
                : <><Volume2 className="w-3.5 h-3.5" /> Voice responses on</>
              }
            </button>
          </div>

        ) : (
          /* ---- TEXT INPUT UI ---- */
          <div className="flex gap-3 items-end">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Type your answer… (Enter to send)"
              className="min-h-[56px] max-h-[140px] resize-none text-sm"
              rows={2}
              disabled={isLoading}
            />
            <Button
              size="icon"
              aria-label="Send message"
              onClick={sendMessage}
              disabled={isLoading || !input.trim()}
              className="h-14 w-14 shrink-0"
            >
              {isLoading
                ? <div className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                : <Send className="w-4 h-4" />
              }
            </Button>
          </div>
        )}

        <div className="mt-4 flex items-center gap-4 text-xs text-muted-foreground">
          <Badge variant="outline" className="text-xs">{Math.min(userMsgCount, MAX_Q)}/{MAX_Q} responses</Badge>
          <span>Your answers are private and used only to build your career profile</span>
        </div>
      </div>
    </AppLayout>
  );
}
