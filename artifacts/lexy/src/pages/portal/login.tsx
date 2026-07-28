/**
 * pages/portal/login.tsx — Candidate Portal Login Page
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Login page specifically for the candidate portal (separate from the recruiter
 * login at /login). Candidates land here if they try to access /portal/* while
 * unauthenticated.
 *
 * ─── Flow ────────────────────────────────────────────────────────────────────
 *   1. Candidate enters email + password
 *   2. POST /api/auth/login → { token, user }
 *      (user.role must be "candidate" — other roles are redirected to /login)
 *   3. useAuth().login(token, user) → redirect to /portal
 *
 * ─── Extra links ─────────────────────────────────────────────────────────────
 *   "Forgot password" → POST /api/public/auth/forgot-password
 *   "Back to homepage" → /careers (public careers site)
 *   "Register" → /career-register (self-registration)
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /portal/login
 */
import { useState } from "react";
import { Link } from "wouter";
import { Zap, Mail, ArrowLeft, Loader2, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function CandidateLogin() {
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error,    setError]    = useState("");
  const [loading,  setLoading]  = useState(false);
  const [resetSending, setResetSending] = useState(false);
  const [resetSent,    setResetSent]    = useState(false);
  const { login } = useAuth();

  const handleSendReset = async () => {
    if (!email.trim()) {
      setError("Enter your email above first, then tap 'Forgot password?'");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Please enter a valid email address.");
      return;
    }
    setError("");
    setResetSending(true);
    try {
      const res = await fetch(`${BASE}/api/public/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not send reset link. Please try again.");
        return;
      }
      setResetSent(true);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setResetSending(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) { setError("Please enter your email address"); return; }
    if (!password)     { setError("Please enter your password"); return; }
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/auth/candidate-login`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ email: email.trim().toLowerCase(), password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "No candidate account found for this email.");
        return;
      }
      login(data.user, data.token);
      window.location.href = `${BASE}/portal`;
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };


  return (
    <div className="min-h-screen text-foreground flex flex-col">
      <header className="border-b border-border/50 px-6 py-4">
        <div className="max-w-md mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary/15 flex items-center justify-center">
              <Zap className="w-3.5 h-3.5 text-primary" />
            </div>
            <span className="font-bold tracking-tight">L3XY</span>
            <span className="text-muted-foreground text-sm">Candidate Portal</span>
          </div>
          <Link href="/login">
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
              <ArrowLeft className="w-3.5 h-3.5" /> Recruiter login
            </Button>
          </Link>
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm space-y-6">

          <div className="text-center space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">Candidate sign in</h1>
            <p className="text-sm text-muted-foreground">Access your application status and prep resources</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email address</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  className="pl-9"
                  value={email}
                  onChange={e => { setEmail(e.target.value); setError(""); }}
                  autoComplete="email"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                <button
                  type="button"
                  onClick={handleSendReset}
                  disabled={resetSending}
                  className="text-xs text-primary hover:underline disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {resetSending ? "Sending…" : "Forgot password?"}
                </button>
              </div>
              <div className="relative">
                <Input
                  id="password"
                  type={showPass ? "text" : "password"}
                  placeholder="Your password"
                  value={password}
                  onChange={e => { setPassword(e.target.value); setError(""); }}
                  autoComplete="current-password"
                  className="pr-10"
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
            </div>

            {resetSent && (
              <p className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-md px-3 py-2">
                Password reset link sent to <span className="font-semibold">{email}</span>. Check your inbox (and spam) — it expires in 1 hour.
              </p>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}

            <Button type="submit" className="w-full gap-2 shadow-lg shadow-primary/20" disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              {loading ? "Signing in…" : "Sign In"}
            </Button>
          </form>

          {/* ── Divider ─────────────────────────────────────────────────── */}
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-border/60" />
            <span className="text-[11px] uppercase tracking-widest text-muted-foreground">or</span>
            <div className="h-px flex-1 bg-border/60" />
          </div>

          {/* ── Microsoft Entra SSO ─────────────────────────────────────── */}
          <a
            href={`${BASE}/api/auth/microsoft/start`}
            className="w-full flex items-center justify-center gap-2.5 py-2.5 rounded-md font-semibold text-sm
              bg-white text-[#1b1b1b] hover:bg-white/90 transition-colors active:scale-[0.98] shadow-sm"
          >
            <svg viewBox="0 0 21 21" className="w-[18px] h-[18px]" aria-hidden="true">
              <rect x="1" y="1" width="9" height="9" fill="#f25022" />
              <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
              <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
              <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
            </svg>
            Sign in with Microsoft
          </a>

          <div className="text-center space-y-2">
            <p className="text-sm text-muted-foreground">
              New to L3XY?{" "}
              <Link href="/career-register" className="text-primary font-semibold underline underline-offset-2">
                Create your free account
              </Link>
            </p>
            <p className="text-xs text-muted-foreground">
              Applied via the careers portal?{" "}
              <Link href={`${BASE}/careers`} className="text-primary underline underline-offset-2">View open roles</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
