/**
 * hm-package.tsx — public, no-login hiring-manager candidate review.
 *
 * Reached at /hm/:token (NOT behind ProtectedRoute). Fetches the branded package
 * snapshot from `GET /api/public/hm-share/:token`, renders it read-only, and lets
 * the hiring manager submit a decision (advance / interview / pass + comment) via
 * `POST /api/public/hm-share/:token/decision`. No authentication — the unguessable,
 * expiring token is the sole credential.
 */
import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  ThumbsUp, CalendarClock, ThumbsDown, Download, CheckCircle2, Clock, ShieldCheck, FileText, Loader2,
} from "lucide-react";
import { buildEvaluationPdfDoc, type EvaluationPdfData } from "@/lib/evaluation-pdf";
import { bandBy } from "@/lib/score-band";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Brand = { name?: string; logoUrl?: string | null; primaryColor?: string | null };

type PackageResponse = {
  package: EvaluationPdfData | null;
  brand: Brand | null;
  message: string | null;
  recipientName: string | null;
  includeContact: boolean;
  includeResume: boolean;
  decision: "advance" | "interview" | "pass" | null;
  decisionComment: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  expiresAt: string;
};

const DECISIONS = [
  { key: "advance" as const, label: "Advance", icon: ThumbsUp, hint: "Move to the next stage" },
  { key: "interview" as const, label: "Request interview", icon: CalendarClock, hint: "I'd like to interview" },
  { key: "pass" as const, label: "Pass", icon: ThumbsDown, hint: "Not a fit right now" },
];

function scoreColor(score: number): string {
  return bandBy(score, { strong: "#16a34a", good: "#d97706", fair: "#dc2626" });
}

export default function HmPackagePage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const [state, setState] = useState<"loading" | "ready" | "notfound" | "expired" | "error">("loading");
  const [data, setData] = useState<PackageResponse | null>(null);

  const [choice, setChoice] = useState<"advance" | "interview" | "pass" | null>(null);
  const [comment, setComment] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<"advance" | "interview" | "pass" | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${BASE}/api/public/hm-share/${token}`);
        if (res.status === 404) { if (alive) setState("notfound"); return; }
        if (res.status === 410) { if (alive) setState("expired"); return; }
        if (!res.ok) { if (alive) setState("error"); return; }
        const json: PackageResponse = await res.json();
        if (!alive) return;
        setData(json);
        setName(json.recipientName ?? "");
        if (json.decision) setSubmitted(json.decision);
        setState("ready");
      } catch {
        if (alive) setState("error");
      }
    })();
    return () => { alive = false; };
  }, [token]);

  const accent = data?.brand?.primaryColor || "#7c3aed";
  const brandName = data?.brand?.name || "Lexy";
  const pkg = data?.package ?? null;
  const cand = pkg?.candidate;
  const candName = cand ? `${cand.firstName ?? ""} ${cand.lastName ?? ""}`.trim() : "Candidate";

  const handleDownloadPdf = async () => {
    if (!pkg) return;
    const { doc, fileName } = await buildEvaluationPdfDoc(pkg);
    doc.save(fileName);
  };

  const handleSubmit = async () => {
    if (!choice) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${BASE}/api/public/hm-share/${token}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: choice, comment: comment.trim() || undefined, name: name.trim() || undefined }),
      });
      const json = await res.json();
      if (res.status === 409) { setSubmitted(json.decision ?? choice); return; }
      if (!res.ok) throw new Error(json.error ?? "Failed to submit");
      setSubmitted(choice);
    } catch {
      /* keep the form open so the manager can retry */
    } finally {
      setSubmitting(false);
    }
  };

  if (state === "loading") {
    return (
      <div className="min-h-screen grid place-items-center bg-slate-100">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  if (state !== "ready" || !pkg) {
    const msg =
      state === "expired" ? "This review link has expired. Please ask the recruiter to send a new one."
      : state === "notfound" ? "This review link is invalid or no longer available."
      : "Something went wrong loading this candidate review.";
    return (
      <div className="min-h-screen grid place-items-center bg-slate-100 px-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-8 max-w-md text-center shadow-sm">
          <Clock className="w-8 h-8 mx-auto text-slate-400 mb-3" />
          <p className="text-slate-700">{msg}</p>
        </div>
      </div>
    );
  }

  const best = pkg.bestRole;
  const alreadyDecided = !!submitted;

  return (
    <div className="min-h-screen bg-slate-100 py-8 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Brand header */}
        <div className="text-center mb-5">
          {data?.brand?.logoUrl
            ? <img src={data.brand.logoUrl} alt={brandName} className="h-9 mx-auto" />
            : <span className="font-bold text-lg" style={{ color: accent }}>{brandName}</span>}
          <p className="text-xs text-slate-400 mt-1">Candidate review · shared by {brandName}</p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="h-1.5" style={{ background: accent }} />
          <div className="p-6 sm:p-8">
            {/* Candidate identity */}
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold text-slate-900">{candName}</h1>
                {(cand?.currentTitle || cand?.currentCompany) && (
                  <p className="text-slate-500 mt-0.5">
                    {cand?.currentTitle}{cand?.currentTitle && cand?.currentCompany ? " · " : ""}{cand?.currentCompany}
                  </p>
                )}
                {cand?.location && <p className="text-sm text-slate-400 mt-0.5">{cand.location}</p>}
                {cand?.email && <p className="text-sm text-slate-500 mt-1">{cand.email}</p>}
              </div>
              {best?.fitScore != null && (
                <div className="text-right shrink-0">
                  <div className="text-3xl font-black tabular-nums" style={{ color: scoreColor(best.fitScore) }}>
                    {Math.round(best.fitScore)}%
                  </div>
                  <div className="text-[11px] uppercase tracking-wide text-slate-400">Match</div>
                </div>
              )}
            </div>

            {/* Recruiter note */}
            {data?.message && (
              <div className="mt-5 p-4 rounded-lg text-sm text-slate-700 whitespace-pre-wrap"
                style={{ background: "#f8fafc", borderLeft: `3px solid ${accent}` }}>
                {data.message}
              </div>
            )}

            {/* Best role */}
            {best?.jobTitle && (
              <div className="mt-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">Best-fit role</p>
                <p className="text-slate-800 font-medium">{best.jobTitle}</p>
              </div>
            )}

            {/* Skills */}
            {!!cand?.skills?.length && (
              <div className="mt-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">Skills</p>
                <div className="flex flex-wrap gap-1.5">
                  {cand.skills.slice(0, 24).map((s) => (
                    <Badge key={s} variant="secondary" className="font-normal">{s}</Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Resume screen summary */}
            {pkg.resumeScreen && (pkg.resumeScreen.recruiterSummary || pkg.resumeScreen.screeningScore != null) && (
              <div className="mt-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1 flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5" /> Screening
                  {pkg.resumeScreen.screeningScore != null && (
                    <span className="ml-1 text-slate-600">· {Math.round(pkg.resumeScreen.screeningScore)}%</span>
                  )}
                </p>
                {pkg.resumeScreen.recruiterSummary && (
                  <p className="text-sm text-slate-600 leading-relaxed">{pkg.resumeScreen.recruiterSummary}</p>
                )}
              </div>
            )}

            {/* Interviews */}
            {!!pkg.interviews?.length && (
              <div className="mt-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">Interviews</p>
                <div className="space-y-1.5">
                  {pkg.interviews.map((iv, i) => (
                    <div key={i} className="flex items-center justify-between text-sm">
                      <span className="text-slate-600 capitalize">{iv.status ?? "interview"}</span>
                      <span className="font-medium text-slate-800">{iv.score != null ? `${Math.round(iv.score)}%` : "—"}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Verification */}
            {pkg.verification?.status && (
              <div className="mt-5 flex items-center gap-2 text-sm text-slate-600">
                <ShieldCheck className="w-4 h-4 text-emerald-600" />
                <span className="capitalize">Verification: {pkg.verification.status}</span>
              </div>
            )}

            {/* Downloads */}
            <div className="mt-6 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" className="gap-1.5" onClick={handleDownloadPdf}>
                <Download className="w-3.5 h-3.5" /> Download PDF
              </Button>
              {data?.includeResume && (
                <a href={`${BASE}/api/public/hm-share/${token}/resume`} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm" className="gap-1.5">
                    <FileText className="w-3.5 h-3.5" /> Download résumé
                  </Button>
                </a>
              )}
            </div>
          </div>

          {/* Decision panel */}
          <div className="border-t border-slate-200 bg-slate-50 p-6 sm:p-8">
            {alreadyDecided ? (
              <div className="text-center">
                <CheckCircle2 className="w-8 h-8 mx-auto mb-2" style={{ color: accent }} />
                <p className="font-semibold text-slate-800">
                  Decision recorded: {DECISIONS.find((d) => d.key === submitted)?.label}
                </p>
                <p className="text-sm text-slate-500 mt-1">Thanks — the recruiter has been notified.</p>
              </div>
            ) : (
              <>
                <p className="font-semibold text-slate-800 mb-1">Your decision</p>
                <p className="text-sm text-slate-500 mb-4">No login required. The recruiter is notified instantly.</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-4">
                  {DECISIONS.map((d) => {
                    const Icon = d.icon;
                    const active = choice === d.key;
                    return (
                      <button
                        key={d.key}
                        type="button"
                        onClick={() => setChoice(d.key)}
                        className="rounded-xl border-2 p-3.5 text-left transition-all hover:-translate-y-0.5 hover:shadow-md"
                        style={{
                          borderColor: active ? accent : "#cbd5e1",
                          background: active ? `${accent}1a` : "#fff",
                          boxShadow: active ? `0 0 0 1px ${accent}` : "none",
                          transform: active ? "translateY(-1px)" : undefined,
                        }}
                      >
                        <Icon className="w-5 h-5 mb-1.5" style={{ color: active ? accent : "#475569" }} />
                        <div className="text-sm font-bold text-slate-900">{d.label}</div>
                        <div className="text-[11px] text-slate-500">{d.hint}</div>
                      </button>
                    );
                  })}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                  <Input placeholder="Your name (optional)" value={name} onChange={(e) => setName(e.target.value)}
                    className="bg-white text-slate-900 placeholder:text-slate-400" />
                  <div className="sm:col-span-2" />
                </div>
                <Textarea
                  rows={3}
                  placeholder="Add a comment for the recruiter (optional)…"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  className="mb-3 bg-white text-slate-900 placeholder:text-slate-400"
                />
                <Button
                  onClick={handleSubmit}
                  disabled={!choice || submitting}
                  className="w-full sm:w-auto"
                  style={{ background: accent }}
                >
                  {submitting ? "Submitting…" : "Submit decision"}
                </Button>
              </>
            )}
          </div>
        </div>

        <p className="text-center text-xs text-slate-400 mt-4">
          Powered by {brandName}. This link expires on{" "}
          {data?.expiresAt ? new Date(data.expiresAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : ""}.
        </p>
      </div>
    </div>
  );
}
