/**
 * pages/career-register.tsx — Candidate Self-Registration
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Allows candidates to create a portal account without receiving an invite
 * email first. Used when a candidate visits the platform directly (e.g. from
 * LinkedIn or a referral link).
 *
 * ─── Registration flow ───────────────────────────────────────────────────────
 *   1. Candidate fills in name, email, password, and optionally LinkedIn URL
 *   2. Optional: upload resume at registration time
 *   3. POST /api/public/auth/register → { token, user }
 *   4. Auto-login via useAuth().login(token, user)
 *   5. Redirect to /portal/onboarding-resume (if no resume uploaded yet)
 *      or /portal/career-interview (if resume was uploaded)
 *
 * ─── Validation ──────────────────────────────────────────────────────────────
 * Client-side: email format, password length (≥ 8), password confirmation match.
 * Server-side: duplicate email check returns 409 Conflict.
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /career-register  (public)
 */
import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/lib/auth-context";
import {
  Brain, Sparkles, Target, TrendingUp, Star,
  CheckCircle2, ArrowRight, Loader2, ChevronRight,
  Eye, EyeOff, Linkedin,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const features = [
  {
    icon: Brain,
    title: "10-minute AI interview",
    desc: "Have a natural conversation with our career advisor — conversational, no long forms.",
  },
  {
    icon: Target,
    title: "3 personalised career paths",
    desc: "Achievable, ambitious, and stretch options — each with milestones and salary benchmarks.",
  },
  {
    icon: TrendingUp,
    title: "Strengths & growth map",
    desc: "Understand what makes you stand out and where to focus next.",
  },
  {
    icon: Star,
    title: "AI career narrative",
    desc: "A compelling summary of your career story — ready to use in interviews.",
  },
];

export default function CareerRegister() {
  const [, navigate] = useLocation();
  const { login } = useAuth();

  const [firstName,   setFirstName]   = useState("");
  const [lastName,    setLastName]    = useState("");
  const [email,       setEmail]       = useState("");
  const [password,    setPassword]    = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [showPass,    setShowPass]    = useState(false);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState("");
  const [success,     setSuccess]     = useState(false);
  const [emailExists, setEmailExists] = useState(false);
  const [resetSent,   setResetSent]   = useState(false);
  const [resetSending, setResetSending] = useState(false);
  const [showLinkedInPrompt, setShowLinkedInPrompt] = useState(false);

  const linkedinRef = useRef<HTMLInputElement>(null);

  async function handleSendReset() {
    setResetSending(true);
    try {
      const res = await fetch(`${BASE}/api/public/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(friendlyApiError(data) || "Could not send reset link. Please try again.");
        return;
      }
      setResetSent(true);
      setError("");
    } catch {
      setError("Network error — please try again.");
    } finally {
      setResetSending(false);
    }
  }

  /* Mirror the server's password policy so the user gets instant, friendly
     feedback instead of a round-trip. The server remains the authority. */
  function passwordProblem(pw: string): string | null {
    if (pw.length < 12) return "Password must be at least 12 characters.";
    if (pw.length > 128) return "Password must be no more than 128 characters.";
    if (!/[A-Z]/.test(pw)) return "Password must include an uppercase letter.";
    if (!/[a-z]/.test(pw)) return "Password must include a lowercase letter.";
    if (!/[0-9]/.test(pw)) return "Password must include a number.";
    if (!/[^A-Za-z0-9]/.test(pw)) return "Password must include a symbol (e.g. ! @ # $ %).";
    return null;
  }

  function validate() {
    if (!firstName.trim() || !email.trim()) {
      setError("Please fill in your name and email.");
      return false;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Please enter a valid email address.");
      return false;
    }
    const pwProblem = passwordProblem(password);
    if (pwProblem) {
      setError(pwProblem);
      return false;
    }
    return true;
  }

  /* The API returns machine codes in `error` (e.g. PASSWORD_TOO_SHORT) with a
     human sentence in `message`. Never show a raw code to the user. */
  const ERROR_CODE_MESSAGES: Record<string, string> = {
    PASSWORD_TOO_SHORT: "Password must be at least 12 characters.",
    PASSWORD_TOO_LONG: "That password is too long.",
    PASSWORD_MISSING_UPPERCASE: "Password must include an uppercase letter.",
    PASSWORD_MISSING_LOWERCASE: "Password must include a lowercase letter.",
    PASSWORD_MISSING_DIGIT: "Password must include a number.",
    PASSWORD_MISSING_SYMBOL: "Password must include a symbol (e.g. ! @ # $ %).",
    PASSWORD_TOO_COMMON: "That password is too common — please choose something less guessable.",
  };

  function friendlyApiError(data: { error?: string; message?: string }): string {
    const isCode = (s: string) => /^[A-Z0-9_]+$/.test(s);
    for (const raw of [data.message, data.error]) {
      if (!raw) continue;
      if (ERROR_CODE_MESSAGES[raw]) return ERROR_CODE_MESSAGES[raw];
      if (!isCode(raw)) return raw; // a real human sentence
    }
    // Only machine codes (or nothing) available — never show them verbatim.
    return "Something went wrong. Please check your details and try again.";
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    // If LinkedIn is blank, prompt the user first
    if (!linkedinUrl.trim()) {
      setShowLinkedInPrompt(true);
      return;
    }

    await submitRegistration();
  }

  function handleSkipLinkedIn() {
    setShowLinkedInPrompt(false);
    submitRegistration();
  }

  function handleAddLinkedIn() {
    setShowLinkedInPrompt(false);
    // Small delay so the dialog closes before focusing
    setTimeout(() => linkedinRef.current?.focus(), 100);
  }

  async function submitRegistration() {
    setError("");
    setEmailExists(false);
    setResetSent(false);
    setLoading(true);

    try {
      const res = await fetch(`${BASE}/api/public/career-register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName:   firstName.trim(),
          lastName:    lastName.trim(),
          email:       email.trim().toLowerCase(),
          password,
          linkedinUrl: linkedinUrl.trim() || undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(friendlyApiError(data));
        return;
      }

      /* The API returns an identical "check your email" response whether or not
       * the address already has an account (account-enumeration guard). We no
       * longer receive a session token here — the user continues via the magic
       * link we email them — so show the check-your-inbox confirmation. */
      setSuccess(true);
    } catch {
      setError("Network error — please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen text-foreground flex flex-col">
      {/* LinkedIn prompt dialog */}
      <AlertDialog open={showLinkedInPrompt} onOpenChange={setShowLinkedInPrompt}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <div className="flex items-center gap-3 mb-1">
              <div className="w-10 h-10 rounded-xl bg-[#0a66c2]/10 border border-[#0a66c2]/20 flex items-center justify-center shrink-0">
                <Linkedin className="w-5 h-5 text-[#0a66c2]" />
              </div>
              <AlertDialogTitle className="text-lg leading-snug">
                Add your LinkedIn to keep your profile live
              </AlertDialogTitle>
            </div>
            <AlertDialogDescription className="text-sm leading-relaxed text-muted-foreground pt-1">
              Adding your LinkedIn helps recruiters see your full experience and
              makes your profile stand out — so you never miss an opportunity.
              Are you sure you want to skip it?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col sm:flex-row gap-2 mt-1">
            <AlertDialogCancel
              onClick={handleAddLinkedIn}
              className="flex-1 gap-2"
            >
              <Linkedin className="w-4 h-4" />
              Add my LinkedIn
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSkipLinkedIn}
              className="flex-1 bg-muted text-muted-foreground hover:bg-muted/80 border border-border/50"
            >
              Skip for now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Nav bar */}
      <header className="border-b border-border/40 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="font-black text-lg tracking-tight select-none">
            L<span style={{ color: "hsl(186 100% 48%)" }}>3</span>xy AI<span className="text-muted-foreground align-super" style={{ fontSize: "0.5em" }}>™</span>
          </span>
        </div>
        <span className="text-xs text-muted-foreground">AI Career Platform · Private &amp; Secure</span>
      </header>

      <main className="flex-1 flex flex-col lg:flex-row">
        {/* Left — Hero */}
        <div className="lg:flex-1 bg-gradient-to-br from-primary/5 via-background to-background flex flex-col justify-center px-8 py-16 lg:px-16">
          <div className="max-w-lg">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary border border-primary/20 rounded-full px-3 py-1 text-xs font-medium mb-6">
              <Sparkles className="w-3 h-3" />
              AI-Powered Career Intelligence
            </div>

            <h1 className="text-4xl lg:text-5xl font-black tracking-tight leading-tight mb-4">
              Discover where your{" "}
              <span className="text-primary">career is heading</span>
            </h1>

            <p className="text-lg text-muted-foreground mb-10 leading-relaxed">
              Have a 10-minute conversation with our AI career advisor.
              Get 3 personalised career paths, salary benchmarks, and a
              strengths map — completely free.
            </p>

            <div className="space-y-5">
              {features.map(({ icon: Icon, title, desc }) => (
                <div key={title} className="flex items-start gap-4">
                  <div className="w-9 h-9 bg-primary/10 text-primary rounded-xl flex items-center justify-center shrink-0 mt-0.5">
                    <Icon className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="font-semibold text-sm">{title}</p>
                    <p className="text-sm text-muted-foreground mt-0.5">{desc}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-10 flex items-center gap-6 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Resume optional</span>
              <span className="flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Takes ~10 minutes</span>
              <span className="flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Free</span>
            </div>
          </div>
        </div>

        {/* Right — Form */}
        <div className="lg:w-[480px] flex flex-col justify-center px-8 py-16 lg:pl-10 lg:pr-16 border-l border-border/40">
          <div className="max-w-sm w-full">
            {success ? (
              <div className="text-center space-y-4 py-8">
                <div className="w-16 h-16 bg-emerald-500/10 rounded-full flex items-center justify-center mx-auto">
                  <CheckCircle2 className="w-8 h-8 text-emerald-400" />
                </div>
                <h2 className="text-xl font-bold">Check your email</h2>
                <p className="text-muted-foreground text-sm">
                  If <span className="font-semibold text-foreground">{email}</span> can be used,
                  we've sent a link to continue and start your career interview.
                  Check your inbox (and spam folder) to pick up where you left off.
                </p>
              </div>
            ) : (
              <>
                <h2 className="text-2xl font-bold tracking-tight mb-1">
                  Build your career profile
                </h2>
                <p className="text-sm text-muted-foreground mb-8">
                  Free to join. Takes 10 minutes. No CV required.
                </p>

                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="firstName">First name *</Label>
                      <Input
                        id="firstName"
                        placeholder="Alex"
                        value={firstName}
                        onChange={e => setFirstName(e.target.value)}
                        disabled={loading}
                        autoFocus
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="lastName">Last name</Label>
                      <Input
                        id="lastName"
                        placeholder="Johnson"
                        value={lastName}
                        onChange={e => setLastName(e.target.value)}
                        disabled={loading}
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="email">Work email *</Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder="alex@company.com"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      disabled={loading}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="password">Password *</Label>
                    <div className="relative">
                      <Input
                        id="password"
                        type={showPass ? "text" : "password"}
                        placeholder="Min 12 characters"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        disabled={loading}
                        className="pr-10"
                        autoComplete="new-password"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPass(v => !v)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                        tabIndex={-1}
                      >
                        {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      At least 12 characters, with an uppercase letter, a lowercase letter, a number, and a symbol.
                    </p>
                  </div>

                  {/* LinkedIn URL — optional but encouraged */}
                  <div className="space-y-1.5">
                    <Label htmlFor="linkedinUrl" className="flex items-center gap-1.5">
                      <Linkedin className="w-3.5 h-3.5 text-[#0a66c2]" />
                      LinkedIn profile
                      <span className="text-muted-foreground font-normal text-xs ml-1">optional</span>
                    </Label>
                    <Input
                      id="linkedinUrl"
                      ref={linkedinRef}
                      type="url"
                      placeholder="https://linkedin.com/in/yourname"
                      value={linkedinUrl}
                      onChange={e => setLinkedinUrl(e.target.value)}
                      disabled={loading}
                    />
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      Helps recruiters see your full experience and makes your profile stand out.
                    </p>
                  </div>

                  {emailExists && !resetSent && (
                    <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-3 space-y-3">
                      <p className="text-sm text-amber-300">
                        An account with <span className="font-semibold">{email}</span> already exists.
                        Want us to email you a password reset link?
                      </p>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          className="flex-1 h-9 text-sm"
                          onClick={handleSendReset}
                          disabled={resetSending}
                        >
                          {resetSending ? (
                            <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Sending…</>
                          ) : (
                            <>Send reset link</>
                          )}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          className="flex-1 h-9 text-sm"
                          onClick={() => navigate("/login")}
                        >
                          Sign in instead
                        </Button>
                      </div>
                    </div>
                  )}

                  {emailExists && resetSent && (
                    <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-300">
                      <CheckCircle2 className="w-4 h-4 inline-block mr-1.5 -mt-0.5" />
                      We've sent a password reset link to <span className="font-semibold">{email}</span>.
                      Check your inbox (and spam folder) — the link expires in 1 hour.
                    </div>
                  )}

                  {error && (
                    <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
                      {error}
                    </p>
                  )}

                  <Button
                    type="submit"
                    className="w-full gap-2 h-11 text-base font-semibold"
                    disabled={loading || (emailExists && !resetSent)}
                  >
                    {loading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Creating your profile…
                      </>
                    ) : (
                      <>
                        Start my career interview
                        <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </Button>
                </form>

                <p className="text-xs text-muted-foreground text-center mt-5 leading-relaxed">
                  By creating an account you agree to our{" "}
                  <a href="/privacy" target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">Privacy Policy</a>
                  {" "}and{" "}
                  <a href="/terms" target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">Terms of Service</a>.
                  Your responses are used solely to generate your career insights. We never sell your data.
                  You may request deletion at any time via <a href="mailto:privacy@lexy.ai" className="text-primary underline underline-offset-2">privacy@lexy.ai</a>.
                </p>

                <div className="mt-6 pt-6 border-t border-border/40 text-center">
                  <p className="text-xs text-muted-foreground mb-3">Already have an account?</p>
                  <a
                    href={`${BASE}/portal/login`}
                    className="text-sm text-primary hover:underline flex items-center justify-center gap-1"
                  >
                    Sign in to your Career Hub <ChevronRight className="w-3.5 h-3.5" />
                  </a>
                </div>
              </>
            )}
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border/40 px-6 py-4 text-center text-xs text-muted-foreground">
        Powered by L3XY AI · Enterprise-grade security · SOC 2 ready
      </footer>
    </div>
  );
}
