/**
 * pages/careers/[id].tsx — Public Job Detail & Application Form
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Public job detail page and application form. Candidates can read the full
 * job description, see the company info, and submit an application with a
 * resume upload. No authentication required to apply.
 *
 * ─── Application form ────────────────────────────────────────────────────────
 *   Full name, email, phone (optional), LinkedIn URL (optional),
 *   cover note (optional), resume file upload (.pdf / .docx, max 10 MB).
 *   On submit: POST /api/public/jobs/:id/apply (multipart/form-data).
 *   On success: server sends a portal invite email to the candidate's email
 *   address; UI shows "Application submitted — check your email" confirmation.
 *
 * ─── Scroll-to-apply ─────────────────────────────────────────────────────────
 * If the URL contains ?apply=true (e.g. from a direct "Apply" button on the
 * /careers list), the page auto-scrolls to the application form on mount.
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /careers/:id  (public; no authentication required)
 */
import { useRef, useState, useEffect } from "react";
import { Link, useRoute, useSearch } from "wouter";
import { useAuth } from "@/lib/auth-context";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@workspace/react-hooks/use-toast";
import {
  MapPin, Briefcase, DollarSign, Clock, ArrowLeft, Zap,
  CheckCircle2, Upload, FileText, Loader2, AlertCircle,
  User, Mail, Phone, Linkedin, Building2, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiBase, apiFetch } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface PublicJob {
  id: string;
  title: string;
  department: string | null;
  location: string | null;
  workType: string;
  employmentType: string;
  salaryMin: number | null;
  salaryMax: number | null;
  description: string | null;
  createdAt: string;
}

function workTypeLabel(wt: string) {
  return { remote: "Remote", hybrid: "Hybrid", onsite: "On-site" }[wt] ?? wt;
}
function employmentLabel(et: string) {
  return { full_time: "Full-time", part_time: "Part-time", contract: "Contract", internship: "Internship" }[et] ?? et;
}
function salaryLabel(min: number | null, max: number | null) {
  if (!min && !max) return null;
  const fmt = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
  if (min && max) return `$${fmt(min)} – $${fmt(max)}`;
  if (min) return `From $${fmt(min)}`;
  return `Up to $${fmt(max!)}`;
}

/* ── Resume Uploader — uses server-side proxy to avoid S3 CORS issues ──── */
function ResumeUploader({
  objectPath,
  fileName,
  onUploaded,
  onCleared,
  isCandidate,
}: {
  objectPath: string | null;
  fileName: string | null;
  onUploaded: (path: string, name: string) => void;
  onCleared: () => void;
  isCandidate: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const { toast } = useToast();

  const handleFile = async (file: File) => {
    const allowed = ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
    if (!allowed.includes(file.type) && !file.name.match(/\.(pdf|doc|docx)$/i)) {
      toast({ title: "Invalid file type", description: "Please upload a PDF or Word document.", variant: "destructive" });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: "File too large", description: "Maximum resume size is 10 MB.", variant: "destructive" });
      return;
    }

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);

      // Public careers page: `isCandidate` can come from a stale cached user,
      // so a 401 here is expected (not a session-expiry signal) — opt out of
      // the global redirect-to-login interceptor.
      const uploadRes = await (isCandidate
        ? apiFetch(`${BASE}/api/storage/uploads/file`, { method: "POST", body: formData }, { allowUnauthenticated: true })
        : fetch(`${BASE}/api/storage/uploads/file`, { method: "POST", body: formData }));

      if (!uploadRes.ok) {
        const body = await uploadRes.json().catch(() => ({}));
        throw new Error(body.error ?? "Upload failed");
      }

      const { objectPath: newPath } = await uploadRes.json();
      if (!newPath) throw new Error("No file path returned");

      onUploaded(newPath, file.name);
      toast({ title: "Resume uploaded", description: `${file.name} attached to your application.` });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err?.message ?? "Please try again.", variant: "destructive" });
    } finally {
      setIsUploading(false);
    }
  };

  if (objectPath) {
    return (
      <div className="flex items-center gap-3 p-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5">
        <div className="w-9 h-9 rounded-lg bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0">
          <FileText className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-emerald-400">Resume attached</p>
          <p className="text-xs text-muted-foreground truncate">{fileName ?? "Your resume"}</p>
        </div>
        <button
          type="button"
          onClick={() => { onCleared(); if (fileInputRef.current) fileInputRef.current.value = ""; }}
          aria-label="Remove attached resume"
          className="text-muted-foreground hover:text-destructive transition-colors p-1"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div>
      <input
        ref={fileInputRef}
        id="resume-file-input"
        type="file"
        className="sr-only"
        accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        disabled={isUploading}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
      />
      <label
        htmlFor="resume-file-input"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
        className={cn(
          "flex flex-col items-center justify-center gap-2.5 p-7 rounded-xl border-2 border-dashed transition-all",
          isUploading ? "cursor-default pointer-events-none opacity-75 border-primary/40 bg-primary/5" : "border-border/50 hover:border-primary/50 hover:bg-muted/20 cursor-pointer",
        )}
      >
        {isUploading ? (
          <>
            <Loader2 className="w-7 h-7 text-primary animate-spin" />
            <p className="text-sm font-medium">Uploading…</p>
          </>
        ) : (
          <>
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <Upload className="w-5 h-5 text-primary" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium">Drop your resume here or <span className="text-primary">browse</span></p>
              <p className="text-xs text-muted-foreground mt-0.5">PDF, DOC, DOCX · Max 10 MB</p>
            </div>
          </>
        )}
      </label>
    </div>
  );
}

/* ── Main Page ──────────────────────────────────────────────────────────── */
export default function CareersJobPage() {
  const { user } = useAuth();
  const [, params] = useRoute("/careers/:id");
  const jobId = params?.id ?? "";
  const { toast } = useToast();
  const search = useSearch();
  const isEmbed = new URLSearchParams(search).get("embed") === "1";

  const isCandidate = user?.role === "candidate";

  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    currentTitle: "",
    currentCompany: "",
    linkedinUrl: "",
    message: "",
  });
  const [resumeObjectPath, setResumeObjectPath] = useState<string | null>(null);
  const [resumeFileName, setResumeFileName] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [profileLoaded, setProfileLoaded] = useState(false);

  /* Auto-populate from portal profile when logged in as candidate */
  useEffect(() => {
    if (!isCandidate) { setProfileLoaded(true); return; }

    Promise.all([
      // Probes on a public page — a logged-out visitor with a stale cached
      // user can legitimately get a 401 here; must NOT redirect to login.
      apiFetch(`${apiBase}/portal/candidate/me`, {}, { allowUnauthenticated: true }).then(r => r.json()).catch(() => null),
      apiFetch(`${apiBase}/portal/career-profile`, {}, { allowUnauthenticated: true }).then(r => r.json()).catch(() => null),
    ]).then(([meRes, profileRes]) => {
      const me = meRes?.data;
      const profile = profileRes?.data;

      if (me) {
        setForm(f => ({
          ...f,
          firstName:      me.firstName  || f.firstName,
          lastName:       me.lastName   || f.lastName,
          email:          me.email      || f.email,
          phone:          me.phone      || f.phone,
          currentTitle:   me.currentTitle   || profile?.currentTitle   || f.currentTitle,
          currentCompany: me.currentCompany || profile?.currentCompany || f.currentCompany,
          linkedinUrl:    me.linkedinUrl || f.linkedinUrl,
        }));
      }

      const existingResume = profile?.resumeUrl ?? me?.resumeUrl ?? null;
      if (existingResume) {
        setResumeObjectPath(existingResume);
        setResumeFileName("Resume on file");
      }
    }).finally(() => setProfileLoaded(true));
  }, [isCandidate]);

  const { data: jobData, isLoading, isError, error } = useQuery<{ data: PublicJob }, Error & { reason?: string }>({
    queryKey: ["public-job", jobId],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/public/jobs/${jobId}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(body.error ?? "Job not found") as Error & { reason?: string };
        err.reason = body.reason;
        throw err;
      }
      return res.json();
    },
    enabled: !!jobId,
    retry: false,
  });

  const job = jobData?.data;
  const errorReason = (error as any)?.reason as string | undefined;

  const applyMutation = useMutation({
    mutationFn: async (payload: typeof form & { resumeObjectPath: string | null }) => {
      const res = await fetch(`${BASE}/api/public/jobs/${jobId}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to submit application");
      }
      return data;
    },
    onSuccess: () => {
      setSubmitted(true);
    },
    onError: (err: Error) => {
      toast({ title: "Submission failed", description: err.message, variant: "destructive" });
    },
  });

  const field = (name: keyof typeof form) => ({
    value: form[name],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setForm(f => ({ ...f, [name]: e.target.value }));
      if (errors[name]) setErrors(e2 => { const n = { ...e2 }; delete n[name]; return n; });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.firstName.trim()) errs.firstName = "Required";
    if (!form.lastName.trim())  errs.lastName  = "Required";
    if (!form.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errs.email = "Valid email required";
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    applyMutation.mutate({ ...form, resumeObjectPath });
  };

  // ── Success State ──────────────────────────────────────────────────────
  if (submitted) {
    return (
      <div className="min-h-screen text-foreground flex flex-col">
        <header className="border-b border-border/50">
          <div className="max-w-3xl mx-auto px-6 py-4">
            <Link href={`${BASE}/careers`} className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-primary/15 flex items-center justify-center">
                <Zap className="w-3.5 h-3.5 text-primary" />
              </div>
              <span className="font-bold tracking-tight">L3XY</span>
              <span className="text-muted-foreground text-sm">Careers</span>
            </Link>
          </div>
        </header>
        <div className="flex-1 flex items-center justify-center px-6 py-24">
          <div className="text-center max-w-md">
            <div className="w-16 h-16 rounded-full bg-emerald-500/15 flex items-center justify-center mx-auto mb-6">
              <CheckCircle2 className="w-8 h-8 text-emerald-400" />
            </div>
            <h1 className="text-3xl font-bold mb-3">Application submitted!</h1>
            <p className="text-muted-foreground mb-2">
              Thanks, <strong>{form.firstName}</strong>! Your application for <strong>{job?.title}</strong> has been received.
            </p>
            <p className="text-sm text-muted-foreground mb-8">
              Our team will review your profile and be in touch via <strong>{form.email}</strong>.
            </p>
            <div className="flex flex-col gap-3 items-center">
              {isCandidate ? (
                <Link href={`${BASE}/portal/career`} className="w-full max-w-xs">
                  <Button className="w-full gap-2 shadow-lg shadow-primary/20">
                    <Zap className="w-4 h-4" /> Back to my portal
                  </Button>
                </Link>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    We've emailed you a link to your candidate portal — check your inbox to track this application.
                  </p>
                  <a href={`${BASE}/portal/login`} className="w-full max-w-xs">
                    <Button className="w-full gap-2 shadow-lg shadow-primary/20">
                      <Zap className="w-4 h-4" /> Sign in to candidate portal
                    </Button>
                  </a>
                </>
              )}
              <Link href={`${BASE}/careers`}>
                <Button variant="ghost" size="sm" className="text-muted-foreground">View other roles</Button>
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Loading / Error ────────────────────────────────────────────────────
  if (isLoading || (isCandidate && !profileLoaded)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }
  if (isError || !job) {
    const notYetPublished = errorReason === "not_yet_published";
    return (
      <div className="min-h-screen text-foreground flex flex-col items-center justify-center gap-4 px-6 text-center">
        <AlertCircle className={`w-10 h-10 ${notYetPublished ? "text-amber-500" : "text-destructive"}`} />
        <p className="text-lg font-semibold">
          {notYetPublished ? "This role isn't open for applications yet" : "This position is no longer available"}
        </p>
        {notYetPublished && (
          <p className="text-sm text-muted-foreground max-w-md">
            The hiring team is still preparing this work order. Check back soon, or browse other open roles below.
          </p>
        )}
        <Link href={`${BASE}/careers`}><Button variant="outline">View all open roles</Button></Link>
      </div>
    );
  }

  const salary = salaryLabel(job.salaryMin, job.salaryMax);

  return (
    <div className={isEmbed ? "text-foreground" : "min-h-screen text-foreground"}>
      {/* ── Header — hidden in embed mode ─────────────────────────────────── */}
      {!isEmbed && (
        <header className="border-b border-border/50 bg-background/80 backdrop-blur-sm sticky top-0 z-50">
          <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
            <Link href={`${BASE}/careers`} className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-primary/15 flex items-center justify-center">
                <Zap className="w-3.5 h-3.5 text-primary" />
              </div>
              <span className="font-bold tracking-tight">L3XY</span>
              <span className="text-muted-foreground text-sm">Careers</span>
            </Link>
            {isCandidate ? (
              <Link href={`${BASE}/portal/career`}>
                <Button size="sm" className="gap-1.5">My Portal</Button>
              </Link>
            ) : user ? (
              <Link href={`${BASE}/dashboard`}>
                <Button variant="outline" size="sm">Dashboard</Button>
              </Link>
            ) : (
              <Link href={`${BASE}/portal/login`}>
                <Button variant="outline" size="sm">Sign in</Button>
              </Link>
            )}
          </div>
        </header>
      )}

      <div className={isEmbed ? "px-4 py-6" : "max-w-5xl mx-auto px-6 py-8"}>
        {/* ── Back — hidden in embed mode ────────────────────────────────── */}
        {!isEmbed && (
          <Link href={`${BASE}/careers`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors mb-8">
            <ArrowLeft className="w-4 h-4" /> Back to all roles
          </Link>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-8">
          {/* ── Job Detail (left) ──────────────────────────────────────────── */}
          <div className="lg:col-span-3">
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                {job.department && <Badge variant="secondary" className="text-xs">{job.department}</Badge>}
                <Badge variant="outline" className="text-xs border-primary/30 text-primary bg-primary/5">{workTypeLabel(job.workType)}</Badge>
              </div>
              <h1 className="text-3xl font-bold tracking-tight mb-3">{job.title}</h1>
              <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                {job.location && (
                  <span className="flex items-center gap-1.5"><MapPin className="w-4 h-4" />{job.location}</span>
                )}
                <span className="flex items-center gap-1.5"><Clock className="w-4 h-4" />{employmentLabel(job.employmentType)}</span>
                {salary && (
                  <span className="flex items-center gap-1.5"><DollarSign className="w-4 h-4" />{salary}</span>
                )}
              </div>
            </div>

            {job.description ? (
              <div className="prose prose-invert prose-sm max-w-none space-y-4">
                {job.description.split("\n\n").map((para, i) => (
                  <p key={i} className="text-muted-foreground leading-relaxed whitespace-pre-line">{para}</p>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground italic">No description provided for this role.</p>
            )}
          </div>

          {/* ── Application Form (right) ───────────────────────────────────── */}
          <div className="lg:col-span-2">
            <div className="rounded-2xl border border-border/50 bg-card/50 p-6 sticky top-24">
              <h2 className="text-lg font-semibold mb-1">Apply for this role</h2>
              <p className="text-xs text-muted-foreground mb-5">
                Takes about 2 minutes · AI-screened within 24 hours
              </p>

              {isCandidate && (
                <div className="mb-4 p-3 rounded-lg bg-primary/5 border border-primary/20 flex items-center gap-2 text-xs text-primary">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  Your profile has been pre-filled from your portal
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="firstName" className="text-xs">First name <span className="text-destructive">*</span></Label>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                      <Input
                        id="firstName"
                        placeholder="Jane"
                        className={cn("pl-9 h-9 text-sm", errors.firstName && "border-destructive")}
                        {...field("firstName")}
                      />
                    </div>
                    {errors.firstName && <p className="text-xs text-destructive">{errors.firstName}</p>}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="lastName" className="text-xs">Last name <span className="text-destructive">*</span></Label>
                    <Input
                      id="lastName"
                      placeholder="Smith"
                      className={cn("h-9 text-sm", errors.lastName && "border-destructive")}
                      {...field("lastName")}
                    />
                    {errors.lastName && <p className="text-xs text-destructive">{errors.lastName}</p>}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="email" className="text-xs">Email address <span className="text-destructive">*</span></Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <Input
                      id="email"
                      type="email"
                      placeholder="jane@example.com"
                      className={cn("pl-9 h-9 text-sm", errors.email && "border-destructive")}
                      {...field("email")}
                    />
                  </div>
                  {errors.email && <p className="text-xs text-destructive">{errors.email}</p>}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="phone" className="text-xs">Phone <span className="text-muted-foreground">(optional)</span></Label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <Input
                      id="phone"
                      type="tel"
                      placeholder="+1 555 000 0000"
                      className="pl-9 h-9 text-sm"
                      {...field("phone")}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="currentTitle" className="text-xs">Current title</Label>
                    <div className="relative">
                      <Briefcase className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                      <Input
                        id="currentTitle"
                        placeholder="Software Engineer"
                        className="pl-9 h-9 text-sm"
                        {...field("currentTitle")}
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="currentCompany" className="text-xs">Company</Label>
                    <div className="relative">
                      <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                      <Input
                        id="currentCompany"
                        placeholder="Acme Corp"
                        className="pl-9 h-9 text-sm"
                        {...field("currentCompany")}
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="linkedinUrl" className="text-xs">LinkedIn profile</Label>
                  <div className="relative">
                    <Linkedin className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <Input
                      id="linkedinUrl"
                      placeholder="linkedin.com/in/yourprofile"
                      className="pl-9 h-9 text-sm"
                      {...field("linkedinUrl")}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">
                    Resume / CV
                    {isCandidate && resumeObjectPath && (
                      <span className="ml-1 text-emerald-400">(from your portal)</span>
                    )}
                  </Label>
                  <ResumeUploader
                    objectPath={resumeObjectPath}
                    fileName={resumeFileName}
                    onUploaded={(path, name) => { setResumeObjectPath(path); setResumeFileName(name); }}
                    onCleared={() => { setResumeObjectPath(null); setResumeFileName(null); }}
                    isCandidate={isCandidate}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="message" className="text-xs">Cover note <span className="text-muted-foreground">(optional)</span></Label>
                  <Textarea
                    id="message"
                    placeholder="Tell us why you're excited about this role…"
                    className="text-sm resize-none h-24"
                    {...field("message")}
                  />
                </div>

                <Button
                  type="submit"
                  className="w-full"
                  disabled={applyMutation.isPending}
                >
                  {applyMutation.isPending ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Submitting…</>
                  ) : (
                    "Submit application"
                  )}
                </Button>

                <p className="text-center text-xs text-muted-foreground">
                  Your application is screened by AI within 24 hours.
                </p>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
