/**
 * intro-video.tsx — "My Introduction Video" (recruiter self-service).
 *
 * Lets a logged-in staff member (tenant admin / recruiter / hiring manager /
 * interviewer) record a personal talking-avatar intro that candidates see
 * before a Lexy interview:
 *   1. Upload a clear head-and-shoulders photo
 *   2. Pick the spoken language, voice, and tone
 *   3. Confirm consent to create an AI likeness of themselves
 *   4. Preview the auto-generated script, then render the video (HeyGen)
 *
 * Backend contract (all under /api/recruiter-avatar, staff-gated):
 *   GET  /profile                     → current profile (or null)
 *   POST /profile                     → create/update profile
 *   POST /script/preview              → generate (not persist) a script
 *   POST /video-jobs                  → start (or reuse) a HeyGen render
 *   GET  /video-jobs/:id              → poll render status + final video URL
 * Photo upload reuses POST /api/storage/uploads/file → { objectPath }.
 */

import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@workspace/react-hooks/use-toast";
import {
  Video, Upload, Loader2, CheckCircle2, Sparkles, ShieldCheck,
  ImageIcon, Wand2, AlertCircle, RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { authHeaders as sharedAuthHeaders } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const LANGUAGES = [
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
  { value: "es-ES", label: "Spanish (Spain)" },
  { value: "es-MX", label: "Spanish (Mexico)" },
  { value: "fr-FR", label: "French" },
  { value: "de-DE", label: "German" },
  { value: "hi-IN", label: "Hindi" },
];

const TONES = [
  { value: "warm_professional", label: "Warm & professional" },
  { value: "friendly_casual", label: "Friendly & casual" },
  { value: "energetic", label: "Energetic & upbeat" },
  { value: "formal", label: "Formal & polished" },
];

const VOICES = [
  { value: "female", label: "Female voice" },
  { value: "male", label: "Male voice" },
];

interface Profile {
  id: string;
  avatarImageObjectPath: string | null;
  avatarImageUrl: string | null;
  hasHeygenTalkingPhoto: boolean;
  selectedVoiceId: string | null;
  voiceGender: string;
  primaryLanguage: string;
  tone: string;
  consentConfirmed: boolean;
  status: string;
  latestVideo?: VideoJob | null;
}

interface VideoJob {
  id: string;
  status: string;
  videoUrl: string | null;
  errorMessage: string | null;
}

/** Prepend the artifact base path only for relative serving URLs; pass
 *  already-absolute (http/https) URLs through untouched. */
function mediaUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  return /^https?:\/\//.test(u) ? u : `${BASE}${u}`;
}

function authHeaders(json = true): Record<string, string> {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...sharedAuthHeaders(),
  };
}

export default function IntroVideoPage() {
  const { user } = useAuth() as any;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Local form state (seeded from the fetched profile) ──────────────────
  const [language, setLanguage] = useState("en-US");
  const [tone, setTone] = useState("warm_professional");
  const [voiceGender, setVoiceGender] = useState("female");
  const [consent, setConsent] = useState(false);
  const [seeded, setSeeded] = useState(false);

  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const [scriptText, setScriptText] = useState("");

  const [job, setJob] = useState<VideoJob | null>(null);
  const [renderStartedAt, setRenderStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // ── Fetch existing profile ──────────────────────────────────────────────
  const { data: profile, isLoading } = useQuery<Profile | null>({
    queryKey: ["recruiter-avatar-profile"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/recruiter-avatar/profile`, {
        credentials: "include",
        headers: authHeaders(false),
      });
      if (!res.ok) throw new Error(`Failed to load profile (${res.status})`);
      return res.json();
    },
  });

  // Seed the editable form once, from the saved profile.
  useEffect(() => {
    if (profile && !seeded) {
      setLanguage(profile.primaryLanguage || "en-US");
      setTone(profile.tone || "warm_professional");
      setVoiceGender(profile.voiceGender || "female");
      setConsent(!!profile.consentConfirmed);
      // Re-surface the recruiter's last completed render so the preview
      // persists across reloads (the saved video lives on the profile payload).
      if (profile.latestVideo?.status === "completed" && profile.latestVideo.videoUrl) {
        setJob(profile.latestVideo);
      }
      setSeeded(true);
    }
  }, [profile, seeded]);

  // ── Save profile (settings + consent) ───────────────────────────────────
  const saveProfile = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const res = await fetch(`${BASE}/api/recruiter-avatar/profile`, {
        credentials: "include",
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || `Save failed (${res.status})`);
      }
      return res.json() as Promise<Profile>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recruiter-avatar-profile"] });
    },
  });

  // ── Photo upload ────────────────────────────────────────────────────────
  const handlePhoto = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast({ title: "Invalid file", description: "Please upload an image (JPG or PNG).", variant: "destructive" });
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast({ title: "File too large", description: "Maximum photo size is 8 MB.", variant: "destructive" });
      return;
    }
    setIsUploading(true);
    setUploadProgress(20);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const up = await fetch(`${BASE}/api/storage/uploads/image`, { method: "POST", body: fd });
      setUploadProgress(70);
      if (!up.ok) {
        const b = await up.json().catch(() => ({}));
        throw new Error(b.error || "Upload failed");
      }
      const { objectPath } = await up.json() as { objectPath: string };
      await saveProfile.mutateAsync({ avatarImageObjectPath: objectPath });
      setUploadProgress(100);
      toast({ title: "Photo saved", description: "Your intro photo has been updated." });
    } catch (err) {
      const e = err instanceof Error ? err : new Error("Upload failed");
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setIsUploading(false);
    }
  };

  // ── Save settings + consent ─────────────────────────────────────────────
  const onSaveSettings = async () => {
    try {
      await saveProfile.mutateAsync({
        primaryLanguage: language,
        tone,
        voiceGender,
        consentConfirmed: consent,
      });
      toast({ title: "Settings saved", description: "Your voice and language preferences are up to date." });
    } catch (err) {
      const e = err instanceof Error ? err : new Error("Save failed");
      toast({ title: "Could not save", description: e.message, variant: "destructive" });
    }
  };

  // ── Script preview ──────────────────────────────────────────────────────
  const previewScript = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${BASE}/api/recruiter-avatar/script/preview`, {
        credentials: "include",
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ language, tone, recruiterName: user?.name }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || `Preview failed (${res.status})`);
      }
      return res.json() as Promise<{ scriptText: string }>;
    },
    onSuccess: (data) => setScriptText(data.scriptText || ""),
    onError: (err) => toast({
      title: "Could not generate script",
      description: err instanceof Error ? err.message : "Try again.",
      variant: "destructive",
    }),
  });

  // ── Generate video (start render) ───────────────────────────────────────
  const generateVideo = useMutation({
    mutationFn: async () => {
      // Send the same script context as the preview so the rendered video's
      // narration matches what the recruiter just previewed. The backend
      // builds the script + resolves the voice from the request body (not the
      // saved profile), so tone AND voiceGender must be passed here — otherwise
      // a changed voice/tone is ignored and the dedupe key matches the old
      // render, returning the previous video instead of a fresh one.
      const res = await fetch(`${BASE}/api/recruiter-avatar/video-jobs`, {
        credentials: "include",
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ language, tone, voiceGender, recruiterName: user?.name }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok || b.ok === false) {
        const reason = b.reason as string | undefined;
        const msg =
          reason === "disabled" ? "Video generation is currently unavailable. Please try again later."
          : reason === "no_avatar" || reason === "no_profile" ? "Upload a photo and confirm consent first."
          : "Could not start the render. Please try again.";
        throw new Error(msg);
      }
      return b.job as VideoJob;
    },
    onSuccess: (j) => {
      setJob(j);
      setRenderStartedAt(Date.now());
      setElapsed(0);
      toast({ title: "Rendering started", description: "Your intro video is being generated — this usually takes 1–2 minutes." });
    },
    onError: (err) => toast({
      title: "Could not start",
      description: err instanceof Error ? err.message : "Try again.",
      variant: "destructive",
    }),
  });

  // ── Tick a live elapsed counter while a render is in flight ─────────────
  useEffect(() => {
    if (!renderStartedAt || !job || job.status === "completed" || job.status === "failed") return;
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - renderStartedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [renderStartedAt, job]);

  // ── Poll the active render until it completes or fails ───────────────────
  useEffect(() => {
    if (!job || job.status === "completed" || job.status === "failed") return;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`${BASE}/api/recruiter-avatar/video-jobs/${job.id}`, {
          credentials: "include",
          headers: authHeaders(false),
        });
        if (!res.ok) return;
        const next = await res.json() as VideoJob;
        setJob(next);
        if (next.status === "failed") {
          toast({ title: "Render failed", description: next.errorMessage || "Please try again.", variant: "destructive" });
        } else if (next.status === "completed") {
          toast({ title: "Video ready", description: "Your introduction video is ready to preview." });
        }
      } catch { /* keep polling */ }
    }, 4000);
    return () => clearInterval(id);
  }, [job, user?.id, toast]);

  const photoUrl = mediaUrl(profile?.avatarImageUrl);
  const hasPhoto = !!profile?.avatarImageObjectPath;
  const isReady = profile?.status === "ready";
  const isRendering = !!job && job.status !== "completed" && job.status !== "failed";
  const canGenerate = hasPhoto && consent && !isRendering;

  return (
    <AppLayout>
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-2xl bg-primary/15 text-primary flex items-center justify-center shrink-0">
            <Video className="w-6 h-6" />
          </div>
          <div className="flex-1">
            <h1 className="page-title">My Introduction Video</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Record a personal AI avatar intro that candidates see before their Lexy interview.
            </p>
          </div>
          {isReady && (
            <Badge className="gap-1.5 bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
              <CheckCircle2 className="w-3.5 h-3.5" /> Ready
            </Badge>
          )}
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : (
          <>
            {/* Step 1 — Photo */}
            <Card className="p-6 space-y-4">
              <div className="flex items-center gap-2">
                <ImageIcon className="w-4 h-4 text-primary" />
                <h2 className="font-semibold">1. Your photo</h2>
              </div>
              <p className="text-sm text-muted-foreground">
                Upload a clear, well-lit head-and-shoulders photo facing the camera. This becomes your talking avatar.
              </p>
              <div className="flex items-center gap-5">
                <div className="w-28 h-28 rounded-2xl overflow-hidden border border-border bg-muted/30 flex items-center justify-center shrink-0">
                  {photoUrl ? (
                    <img src={photoUrl} alt="Your intro avatar" className="w-full h-full object-cover" />
                  ) : (
                    <ImageIcon className="w-8 h-8 text-muted-foreground/40" />
                  )}
                </div>
                <div className="flex-1 space-y-3">
                  <Button
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading}
                    className="gap-2"
                  >
                    {isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                    {hasPhoto ? "Replace photo" : "Upload photo"}
                  </Button>
                  {isUploading && <Progress value={uploadProgress} className="w-full max-w-xs h-1.5" />}
                  <p className="text-xs text-muted-foreground">JPG or PNG · Max 8 MB</p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/jpg,image/webp"
                    className="hidden"
                    /* Clear the value on open so picking the SAME file again
                       still fires onChange (otherwise re-selecting does nothing). */
                    onClick={(e) => { (e.target as HTMLInputElement).value = ""; }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handlePhoto(f);
                    }}
                  />
                </div>
              </div>
            </Card>

            {/* Step 2 — Voice & language */}
            <Card className="p-6 space-y-5">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-primary" />
                <h2 className="font-semibold">2. Voice &amp; language</h2>
              </div>
              <div className="grid sm:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Language</Label>
                  <Select value={language} onValueChange={setLanguage}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {LANGUAGES.map(l => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Voice</Label>
                  <Select value={voiceGender} onValueChange={setVoiceGender}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {VOICES.map(v => <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Tone</Label>
                  <Select value={tone} onValueChange={setTone}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TONES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Consent */}
              <label className="flex items-start gap-3 p-4 rounded-xl border border-border bg-muted/20 cursor-pointer">
                <Checkbox
                  checked={consent}
                  onCheckedChange={(v) => setConsent(v === true)}
                  className="mt-0.5"
                />
                <span className="text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                    <ShieldCheck className="w-3.5 h-3.5 text-primary" /> I consent to creating an AI likeness
                  </span>
                  <br />
                  I confirm this is my own photo and authorize Lexy to generate an AI avatar and voice of me
                  for candidate introductions.
                </span>
              </label>

              <div className="flex justify-end">
                <Button onClick={onSaveSettings} disabled={saveProfile.isPending} className="gap-2">
                  {saveProfile.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                  Save settings
                </Button>
              </div>
            </Card>

            {/* Step 3 — Script + generate */}
            <Card className="p-6 space-y-5">
              <div className="flex items-center gap-2">
                <Wand2 className="w-4 h-4 text-primary" />
                <h2 className="font-semibold">3. Preview &amp; create your video</h2>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Intro script</Label>
                  <Button
                    variant="ghost" size="sm"
                    className="gap-1.5 text-xs h-7"
                    onClick={() => previewScript.mutate()}
                    disabled={previewScript.isPending}
                  >
                    {previewScript.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                    Generate preview
                  </Button>
                </div>
                <Textarea
                  value={scriptText}
                  readOnly
                  placeholder="Click “Generate preview” to see the script your avatar will speak."
                  className="min-h-[120px] resize-none bg-muted/20"
                />
                <p className="text-xs text-muted-foreground">
                  The script is generated automatically from your name, company, and tone. Preview is read-only.
                </p>
              </div>

              {!canGenerate && !isRendering && (
                <div className="flex items-center gap-2 text-xs text-amber-400/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>Upload a photo and confirm consent above before creating your video.</span>
                </div>
              )}

              <Button
                onClick={() => generateVideo.mutate()}
                disabled={!canGenerate || generateVideo.isPending}
                className="gap-2 w-full sm:w-auto"
              >
                {isRendering || generateVideo.isPending
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <Video className="w-4 h-4" />}
                {isRendering ? "Rendering…" : "Create introduction video"}
              </Button>

              {/* Render result */}
              {isRendering && (
                <div className="flex items-center gap-3 p-4 rounded-xl border border-primary/20 bg-primary/5">
                  <Loader2 className="w-5 h-5 animate-spin text-primary shrink-0" />
                  <div className="text-sm">
                    <p className="font-medium">
                      Generating your video…
                      {elapsed > 0 && (
                        <span className="ml-1.5 font-normal text-muted-foreground">
                          {elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`} elapsed
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      This usually takes 1–2 minutes. You can stay on this page — it will appear automatically when ready.
                    </p>
                  </div>
                </div>
              )}

              {job?.status === "completed" && job.videoUrl && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-sm text-emerald-400">
                    <CheckCircle2 className="w-4 h-4" /> Your introduction video is ready
                  </div>
                  <video
                    src={mediaUrl(job.videoUrl) ?? undefined}
                    controls
                    className="w-full rounded-xl border border-border bg-black"
                  />
                  <Button
                    variant="outline" size="sm" className="gap-1.5"
                    onClick={() => { setJob(null); generateVideo.mutate(); }}
                    disabled={!canGenerate}
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Regenerate
                  </Button>
                </div>
              )}

              {job?.status === "failed" && (
                <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>{job.errorMessage || "The render failed. Please try again."}</span>
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </AppLayout>
  );
}
