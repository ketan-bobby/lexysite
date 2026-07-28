/**
 * pages/login.tsx — Recruiter / Staff Login Page
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Main login page for recruiter, tenant_admin, hiring_manager, interviewer,
 * and platform_admin users. On successful login, redirects to the appropriate
 * dashboard based on the user's role.
 *
 * ─── Layout ──────────────────────────────────────────────────────────────────
 * Split-panel: left panel shows the Lexy feature highlights (static marketing
 * copy); right panel contains the email + password form.
 *
 * ─── Auth flow ───────────────────────────────────────────────────────────────
 *   1. POST /api/auth/login → returns { token, user }
 *   2. useAuth().login(token, user) stores token in localStorage
 *   3. Redirect:
 *      platform_admin → /recruiter/platform-dashboard
 *      hiring_manager → /hiring/dashboard
 *      interviewer    → /interviewer/interviews
 *      recruiter / tenant_admin → /recruiter/dashboard
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /login  (also the default / redirect for unauthenticated recruiter routes)
 */
import { useState, useEffect, useRef } from "react";
import { Eye, EyeOff, Lock, Mail, Zap, Shield, Brain, Cpu, CheckCircle2 } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useLogin } from "@workspace/api-client-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Friendly copy for the ?sso_error=… codes set by the API callback. */
function ssoErrorMessage(code: string): string {
  switch (code) {
    case "not_configured":
      return "Microsoft sign-in isn't configured yet. Please use email and password, or contact your administrator.";
    case "staff_tenant_restricted":
      return "Microsoft sign-in for staff accounts is restricted to your organization's Microsoft tenant. Contact your administrator.";
    case "account_suspended":
      return "This account has been suspended. Please contact your administrator.";
    case "no_email":
      return "Your Microsoft account didn't share an email address, so we couldn't sign you in.";
    case "access_denied":
      return "Microsoft sign-in was cancelled.";
    default:
      return "We couldn't complete your Microsoft sign-in. Please try again.";
  }
}

/** Microsoft's four-square brand mark. */
function MicrosoftLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 21 21" className={className} aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

const features = [
  { icon: Brain,  label: "Role Intelligence",   desc: "AI builds the perfect ICP for every role"          },
  { icon: Zap,    label: "Autonomous Pipeline", desc: "10 agents run sourcing to offer, end-to-end"       },
  { icon: Shield, label: "Verified Candidates", desc: "Biometric proctor · credential checks · scoring"   },
];

export default function Login() {
  const [email, setEmail]               = useState("");
  const [password, setPassword]         = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isCandidate, setIsCandidate]   = useState(false);
  const [resetSending, setResetSending] = useState(false);
  const [resetSent,    setResetSent]    = useState(false);
  const [resetError,   setResetError]   = useState("");
  const { login } = useAuth();

  const handleForgotPassword = async () => {
    setResetSent(false);
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) {
      setResetError("Enter your email above first, then click 'Forgot password?'");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setResetError("Please enter a valid email address.");
      return;
    }
    setResetError("");
    setResetSending(true);
    try {
      const res = await fetch(`${BASE}/api/public/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResetError(data.error ?? "Could not send reset link. Please try again.");
        return;
      }
      setResetSent(true);
    } catch {
      setResetError("Network error — please try again.");
    } finally {
      setResetSending(false);
    }
  };

  const loginMutation = useLogin({
    mutation: {
      onSuccess: (data) => {
        login(data.user, data.token);
        const dest =
          data.user.role === "candidate"    ? "portal"    :
          data.user.role === "platform_admin" ? "platform" :
          "dashboard";
        window.location.href = import.meta.env.BASE_URL + dest;
      },
    },
  });

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    loginMutation.mutate({ data: { email, password } });
  };

  /* ── Trial-flow error display ─────────────────────────────────────────────
   * The /api/plans/start-trial/verify endpoint redirects here with a
   * ?trial_error=... query param when the magic link is invalid, expired, or
   * the email already has an account. We DO NOT support an autologin param —
   * a successful trial verification redirects to /auth/trial-exchange which
   * exchanges a one-time loginToken for a session via /api/auth/exchange-trial-token.
   */
  const [autoLoginError, setAutoLoginError] = useState("");
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const trialError = params.get("trial_error");
    if (trialError === "invalid") {
      setAutoLoginError("Your trial verification link is invalid or expired. Please request a new one.");
    } else if (trialError === "already_registered") {
      const e = params.get("email") ?? "";
      if (e) setEmail(e);
      setAutoLoginError("An account with this email already exists. Please sign in below.");
    } else if (trialError === "exchange_failed") {
      setAutoLoginError("Couldn't sign you in automatically. Please use Forgot Password to set a password and sign in.");
    }
    const ssoError = params.get("sso_error");
    if (ssoError) setAutoLoginError(ssoErrorMessage(ssoError));
  }, []);

  const setDemo = (email: string, isCandidate = false) => {
    setEmail(email); setPassword("password123");
    setIsCandidate(isCandidate);
    loginMutation.mutate({ data: { email, password: "password123" } });
  };

  return (
    <div className="min-h-screen flex">

      {/* ── Left hero panel ───────────────────────────────────────────────── */}
      <div className="hidden lg:block lg:w-[48%] overflow-hidden relative" style={{ background: "#000" }}>

        {/* Person photo — anchored to left, natural width */}
        <img
          src={`${import.meta.env.BASE_URL}images/hero-person.png`}
          alt="Lexy AI professional"
          className="absolute top-0 left-0 h-full select-none pointer-events-none"
          style={{ width: "auto", objectFit: "cover", objectPosition: "left top" }}
          draggable={false}
        />

        {/* Gradient overlay ON the image — fades image into black at the right */}
        <div
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{ right: "58%", width: "80px", background: "linear-gradient(to right, transparent, #000)", zIndex: 5 }}
        />

        {/* Solid black content block — no gradient inside, purely opaque */}
        <div
          className="absolute right-0 top-0 bottom-0 flex flex-col px-7 py-8"
          style={{ width: "58%", background: "#000000", zIndex: 10 }}
        >

          {/* Centered content — sits in the vertical middle between the image and the right panel */}
          <div className="flex-1 flex flex-col justify-center gap-5">

          {/* Brand */}
          <div className="flex items-center">
            <img src={`${import.meta.env.BASE_URL}lexy-logo.png`} alt="Lexy AI" className="h-14 w-auto object-contain" />
          </div>

          {/* Headline block */}
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 mb-4 border border-primary/20 bg-primary/10">
              <span className="w-1 h-1 rounded-full bg-primary animate-pulse shrink-0" />
              <span className="text-primary text-[9px] font-bold tracking-widest uppercase">Intelligence Layer Active</span>
            </div>

            <h1 className="text-white text-2xl font-extrabold leading-[1.15] mb-2 font-display">
              The AI{" "}
              <span style={{
                background: "linear-gradient(90deg, #c084fc 0%, #818cf8 100%)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
              }}>
                Hiring Brain
              </span>
            </h1>
            <p className="text-white/35 text-xs mb-5 leading-relaxed">
              The Intelligence Layer for Human Potential
            </p>

            {/* Feature cards — compact */}
            <div className="flex flex-col gap-2">
              {features.map((f) => (
                <div key={f.label} className="flex items-center gap-2.5 bg-white/4 border border-white/6 rounded-lg px-3 py-2">
                  <div className="w-6 h-6 rounded-md bg-primary/20 flex items-center justify-center shrink-0">
                    <f.icon className="w-3 h-3 text-primary" />
                  </div>
                  <div>
                    <p className="text-white text-[11px] font-semibold leading-none">{f.label}</p>
                    <p className="text-white/35 text-[10px] mt-0.5 leading-tight">{f.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          </div>{/* end centered group */}

          {/* Footer */}
          <p className="text-[9px] text-white/20 tracking-widest uppercase">
            SOC 2 Ready · 256-bit TLS · Biometric Proctor
          </p>
        </div>
      </div>

      {/* ── Right: Login form ─────────────────────────────────────────────── */}
      <div className="flex-1 flex items-center justify-center px-8 py-12 relative overflow-hidden">

        <div className="w-full max-w-[400px] relative z-10">

          {/* Mobile brand */}
          <div className="lg:hidden mb-8 flex items-center">
            <img src={`${import.meta.env.BASE_URL}lexy-logo.png`} alt="Lexy AI" className="h-8 w-auto object-contain" />
          </div>

          {/* Portal tag */}
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2 h-2 rounded-full bg-primary shadow-[0_0_8px_2px] shadow-primary/60 animate-pulse flex-shrink-0" />
            <span className="text-[11px] font-bold tracking-[0.15em] text-primary uppercase">
              {isCandidate ? "Candidate Portal" : "L3XY Platform"}
            </span>
          </div>

          <h2 className="text-[2rem] font-extrabold text-foreground leading-tight mb-2 font-display">
            {isCandidate ? "Candidate Login" : "Sign In to L3XY"}
          </h2>
          <p className="text-muted-foreground text-sm mb-8">
            {isCandidate ? "Access your interview prep and applications." : "Sign in to run your AI hiring engine."}
          </p>

          <form onSubmit={handleLogin} className="space-y-5">

            {/* Email */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-sm font-semibold text-foreground/90">
                  Email <span className="text-primary">*</span>
                </label>
                <a
                  href={`${import.meta.env.BASE_URL}portal/login`}
                  className="text-xs font-semibold text-primary hover:opacity-80 transition-opacity"
                >
                  Candidate login →
                </a>
              </div>
              <div className="relative">
                <input
                  type="email"
                  placeholder="Enter email address"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (resetSent) setResetSent(false);
                    if (resetError) setResetError("");
                  }}
                  required
                  autoComplete="email"
                  className="w-full rounded-xl px-4 py-3.5 pr-11 text-sm text-foreground placeholder:text-muted-foreground/50
                    bg-white/5 border border-white/10 focus:border-primary/50 focus:ring-2 focus:ring-primary/15
                    focus:outline-none transition-all"
                />
                <Mail className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/40 pointer-events-none" />
              </div>
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-sm font-semibold text-foreground/90">
                  Password <span className="text-primary">*</span>
                </label>
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  disabled={resetSending}
                  className="text-xs font-semibold text-primary hover:opacity-80 transition-opacity disabled:opacity-50"
                >
                  {resetSending ? "Sending…" : "Forgot password?"}
                </button>
              </div>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  placeholder="Enter password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="w-full rounded-xl px-4 py-3.5 pr-20 text-sm text-foreground placeholder:text-muted-foreground/50
                    bg-white/5 border border-white/10 focus:border-primary/50 focus:ring-2 focus:ring-primary/15
                    focus:outline-none transition-all"
                />
                <div className="absolute right-3.5 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
                  <Lock className="w-4 h-4 text-muted-foreground/40" />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>

            {/* Forgot-password feedback */}
            {resetSent && (
              <div
                role="status"
                aria-live="polite"
                className="flex items-center gap-2 text-sm text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-3 py-2.5"
              >
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                If an account exists for that email, a reset link has been sent. Check your inbox.
              </div>
            )}
            {resetError && (
              <div
                role="alert"
                aria-live="assertive"
                className="flex items-center gap-2 text-sm text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2.5"
              >
                <Shield className="w-4 h-4 shrink-0" />
                {resetError}
              </div>
            )}

            {/* Trial-flow error message */}
            {autoLoginError && (
              <div className="flex items-center gap-2 text-sm text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2.5">
                <Shield className="w-4 h-4 shrink-0" />
                {autoLoginError}
              </div>
            )}

            {/* Error message */}
            {loginMutation.isError && (
              <div className="flex items-center gap-2 text-sm text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2.5">
                <Shield className="w-4 h-4 shrink-0" />
                Invalid credentials. Please try again.
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loginMutation.isPending || !email || !password}
              className="relative w-full py-3.5 rounded-xl font-bold text-[15px] transition-all
                disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98] overflow-hidden"
              style={{
                color: "hsl(0 0% 100%)",
                background: "linear-gradient(135deg, hsl(210 74% 47%) 0%, hsl(210 75% 37%) 100%)",
                boxShadow: "0 0 28px hsl(210 71% 54% / 0.50)",
              }}
            >
              <div className="absolute inset-x-0 top-0 h-px bg-white/20" />
              {loginMutation.isPending ? (
                <span className="flex items-center justify-center gap-2">
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Signing in…
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  <Zap className="w-4 h-4" />
                  Sign In
                </span>
              )}
            </button>
          </form>

          {/* ── Divider ─────────────────────────────────────────────────── */}
          <div className="flex items-center gap-3 my-5">
            <div className="h-px flex-1 bg-white/10" />
            <span className="text-[11px] uppercase tracking-widest text-muted-foreground/40">or</span>
            <div className="h-px flex-1 bg-white/10" />
          </div>

          {/* ── Microsoft Entra SSO ─────────────────────────────────────── */}
          <a
            href={`${BASE}/api/auth/microsoft/start`}
            className="w-full flex items-center justify-center gap-2.5 py-3.5 rounded-xl font-semibold text-[15px]
              bg-white text-[#1b1b1b] hover:bg-white/90 transition-colors active:scale-[0.98]"
          >
            <MicrosoftLogo className="w-[18px] h-[18px]" />
            Sign in with Microsoft
          </a>

          {/* Security note */}
          <p className="text-center text-[11px] text-muted-foreground/40 mt-5">
            Enterprise-grade security · SOC 2 ready · 256-bit encryption
          </p>

        </div>
      </div>
    </div>
  );
}
