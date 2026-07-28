/**
 * pages/portal/onboarding-resume.tsx — Candidate Onboarding: Resume Upload
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Step 1 of the candidate portal onboarding flow (after accepting an invite).
 * Asks the candidate to upload their resume so the AI can parse it and
 * pre-populate their career profile before the baseline interview.
 *
 * ─── Upload states ───────────────────────────────────────────────────────────
 *   idle       — drop zone shown with upload instructions
 *   uploading  — file being uploaded to S3 via presigned URL
 *   done       — resume parsed; shows "AI is analysing your resume..." message;
 *                auto-redirects to /portal/career-interview after 2 s
 *   error      — upload or parse failed; retry button shown
 *
 * ─── Upload flow ─────────────────────────────────────────────────────────────
 *   1. Candidate selects or drops a .pdf / .docx file (max 10 MB)
 *   2. POST /api/objects/upload-url → { uploadUrl, objectPath }
 *   3. PUT bytes directly to S3 presigned URL
 *   4. PATCH /api/candidates/me { resumeUrl: objectPath } → triggers AI parse
 *   5. Redirect to /portal/career-interview
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /portal/onboarding-resume
 */
import { useState, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { Brain, Upload, FileText, CheckCircle2, ArrowRight, X, Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiBase, apiFetch } from "@/lib/api";

type UploadState = "idle" | "uploading" | "done" | "error";

export default function OnboardingResume() {
  const [, navigate] = useLocation();
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skipping, setSkipping] = useState(false);
  const [checking, setChecking] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  /* If the candidate already has a resume on file, skip straight to Career Hub */
  useEffect(() => {
    apiFetch(`${apiBase}/portal/career-profile`)
      .then(r => r.json())
      .then(data => {
        if (data?.data?.resumeUrl) {
          navigate("/portal/career");
        } else {
          setChecking(false);
        }
      })
      .catch(() => setChecking(false));
  }, []);

  async function handleFile(file: File) {
    if (!file) return;
    const allowed = ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
    if (!allowed.includes(file.type)) {
      setError("Please upload a PDF or Word document (.pdf, .doc, .docx)");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("File must be under 10 MB");
      return;
    }

    setError(null);
    setUploadState("uploading");
    setFileName(file.name);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const uploadRes = await apiFetch(`${apiBase}/storage/uploads/file`, {
        method: "POST",
        body: formData,
      });
      if (!uploadRes.ok) {
        const body = await uploadRes.json().catch(() => ({}));
        throw new Error(body.error ?? "Upload failed");
      }
      const { objectPath } = await uploadRes.json();

      const saveRes = await apiFetch(`${apiBase}/portal/career-profile/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resumeObjectPath: objectPath }),
      });
      if (!saveRes.ok) throw new Error("Failed to save resume");

      setUploadState("done");
    } catch (err: any) {
      setUploadState("error");
      setError(err?.message ?? "Upload failed — please try again or skip for now.");
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  /* Next step in onboarding: the work-authorisation screening page. From there
   * the candidate optionally fills voluntary self-ID, then lands on the
   * career hub. Demographics are intentionally on their own surface, never
   * inside this resume step. */
  async function handleContinue() {
    navigate("/portal/onboarding/screening");
  }

  async function handleSkip() {
    setSkipping(true);
    navigate("/portal/onboarding/screening");
  }

  /* Show nothing while checking — avoids flashing the upload form before auto-redirect */
  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen text-foreground flex flex-col">
      {/* Header */}
      <header className="border-b border-border/40 px-6 py-4 flex items-center gap-2.5">
        <div className="w-8 h-8 bg-gradient-to-br from-primary to-cyan-700 rounded-lg flex items-center justify-center shadow-md shadow-primary/30">
          <Brain className="w-4 h-4 text-white" />
        </div>
        <span className="font-bold text-lg tracking-tight">
          L<span className="text-primary">3</span>XY
        </span>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-4 py-12">
        <div className="w-full max-w-lg space-y-8">

          {/* Profile generated banner */}
          <div className="text-center space-y-3">
            <div className="w-16 h-16 bg-emerald-500/10 rounded-full flex items-center justify-center mx-auto ring-4 ring-emerald-500/20">
              <CheckCircle2 className="w-8 h-8 text-emerald-400" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Your AI Career Profile is ready!</h1>
            <p className="text-muted-foreground text-sm max-w-sm mx-auto">
              We've analysed your interview and built your personalised career map — 3 paths, a strengths report, and salary benchmarks.
            </p>
          </div>

          {/* Divider with label */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs text-muted-foreground font-medium px-2">One optional step</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          {/* Resume upload card */}
          <div className="border border-border/60 rounded-2xl p-6 space-y-4 bg-card">
            <div className="flex items-start gap-3">
              <div className="p-2.5 bg-primary/10 rounded-xl text-primary shrink-0 mt-0.5">
                <FileText className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-semibold">Add your resume <span className="text-muted-foreground font-normal text-sm">(optional)</span></h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Supercharge your profile. Our AI will cross-reference your resume to surface more accurate role matches and fill in experience details automatically.
                </p>
              </div>
            </div>

            {uploadState === "done" ? (
              <div className="flex items-center gap-3 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-emerald-400">Resume uploaded</p>
                  <p className="text-xs text-muted-foreground truncate">{fileName}</p>
                </div>
                <button
                  onClick={() => { setUploadState("idle"); setFileName(null); }}
                  aria-label="Remove uploaded resume"
                  className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <>
                {/* Hidden input — always in DOM so label click reliably opens the picker */}
                <input
                  ref={fileRef}
                  id="onboarding-resume-input"
                  type="file"
                  accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  className="sr-only"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
                  disabled={uploadState === "uploading"}
                />
                <label
                  htmlFor="onboarding-resume-input"
                  onDrop={onDrop}
                  onDragOver={onDragOver}
                  className={`
                    block relative border-2 border-dashed rounded-xl p-8 flex flex-col items-center gap-3 text-center transition-all
                    ${uploadState === "uploading"
                      ? "border-primary/40 bg-primary/5 cursor-wait pointer-events-none"
                      : "border-border hover:border-primary/40 hover:bg-primary/5 cursor-pointer"}
                  `}
                >
                  {uploadState === "uploading" ? (
                    <>
                      <Loader2 className="w-8 h-8 text-primary animate-spin" />
                      <p className="text-sm font-medium">Uploading {fileName}…</p>
                      <p className="text-xs text-muted-foreground">Hang tight</p>
                    </>
                  ) : (
                    <>
                      <Upload className="w-8 h-8 text-muted-foreground/50" />
                      <div>
                        <p className="text-sm font-medium">Drop your resume here</p>
                        <p className="text-xs text-muted-foreground mt-0.5">or click to browse · PDF, DOC, DOCX · Max 10 MB</p>
                      </div>
                    </>
                  )}
                </label>
              </>
            )}

            {error && (
              <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
                {error}
              </p>
            )}
          </div>

          {/* Benefits of uploading */}
          {uploadState !== "done" && (
            <div className="grid grid-cols-3 gap-3 text-center text-xs text-muted-foreground">
              {[
                { icon: "🎯", text: "More accurate job matches" },
                { icon: "⚡", text: "Auto-fills your experience" },
                { icon: "🔒", text: "Private — never shared without consent" },
              ].map(b => (
                <div key={b.text} className="p-3 bg-card border border-border/40 rounded-xl space-y-1">
                  <div className="text-lg">{b.icon}</div>
                  <p>{b.text}</p>
                </div>
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex flex-col sm:flex-row gap-3">
            {uploadState === "done" ? (
              <Button
                onClick={handleContinue}
                className="flex-1 gap-2 h-12 text-base font-semibold"
              >
                <Sparkles className="w-4 h-4" />
                View My Career Hub
                <ArrowRight className="w-4 h-4" />
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={handleSkip}
                  disabled={skipping || uploadState === "uploading"}
                  className="flex-1 h-12"
                >
                  {skipping ? <Loader2 className="w-4 h-4 animate-spin" /> : "Skip for now"}
                </Button>
                <label
                  htmlFor="onboarding-resume-input"
                  className={`flex-1 flex items-center justify-center gap-2 h-12 font-semibold rounded-md bg-primary text-primary-foreground text-sm px-4 transition-colors hover:bg-primary/90 cursor-pointer ${uploadState === "uploading" ? "opacity-60 pointer-events-none" : ""}`}
                >
                  <Upload className="w-4 h-4" />
                  Upload Resume
                </label>
              </>
            )}
          </div>

          <p className="text-center text-xs text-muted-foreground/60">
            You can always upload or update your resume later from your Career Hub
          </p>
        </div>
      </main>
    </div>
  );
}
