/**
 * pages/trial-setup.tsx — Trial password-setup landing page
 *
 * The /api/plans/start-trial/verify endpoint redirects new trial users here
 * with `?lt=<one-time-loginToken>` (24-hour TTL, single-use). On mount we
 * fetch lightweight info about the pending signup (email, company) so we can
 * greet the user, then ask them to choose a password. Submitting POSTs the
 * token + password to /api/auth/complete-trial-signup, which atomically claims
 * the token, sets a real bcrypt password hash on the user row, and returns a
 * session — we drop them straight into /dashboard.
 *
 * Why a setup page (instead of the previous auto-exchange)?
 *   - 5-minute auto-login windows kept failing real users on slow networks,
 *     ad-blockers, or page refreshes — the link looked broken when in fact
 *     it had simply expired.
 *   - Without a real password, users couldn't sign in again later via
 *     /login — they'd see "invalid credentials" forever and bounce to
 *     Forgot Password.
 *   - A friendly password form is the standard SaaS pattern; users expect it.
 */
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { Loader2, Shield, Eye, EyeOff, Zap } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/* Mirror the server's password policy (api-server/src/lib/password-policy.ts)
   so the user gets instant, friendly feedback before a round-trip. */
function passwordProblem(pw: string): string | null {
  if (pw.length < 12) return "Password must be at least 12 characters.";
  if (pw.length > 128) return "Password must be no more than 128 characters.";
  if (!/[A-Z]/.test(pw)) return "Password must include an uppercase letter.";
  if (!/[a-z]/.test(pw)) return "Password must include a lowercase letter.";
  if (!/[0-9]/.test(pw)) return "Password must include a number.";
  if (!/[^A-Za-z0-9]/.test(pw)) return "Password must include a symbol (e.g. ! @ # $ %).";
  return null;
}

/* The API returns machine codes in `error` (e.g. PASSWORD_TOO_SHORT) alongside
   a human `message`. Prefer the message; fall back to this map so an ALL_CAPS
   code is never rendered. */
const PASSWORD_ERROR_MESSAGES: Record<string, string> = {
  PASSWORD_TOO_SHORT: "Password must be at least 12 characters.",
  PASSWORD_TOO_LONG: "That password is too long.",
  PASSWORD_MISSING_UPPERCASE: "Password must include an uppercase letter.",
  PASSWORD_MISSING_LOWERCASE: "Password must include a lowercase letter.",
  PASSWORD_MISSING_DIGIT: "Password must include a number.",
  PASSWORD_MISSING_SYMBOL: "Password must include a symbol (e.g. ! @ # $ %).",
  PASSWORD_TOO_COMMON: "That password is too common — please choose something less guessable.",
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; email: string; name: string; company: string }
  | { kind: "error"; message: string };

export default function TrialSetup() {
  const { login } = useAuth();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const lookupFiredRef = useRef(false);

  /* Lookup the token on mount (does NOT consume) so we can greet the user
     with their email/company — and detect bad/expired links up front
     instead of after they've typed a password. */
  useEffect(() => {
    if (lookupFiredRef.current) return;
    lookupFiredRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const lt = params.get("lt");
    if (!lt) {
      setState({ kind: "error", message: "This trial setup link is missing its token. Request a new one from the trial signup page." });
      return;
    }

    (async () => {
      try {
        const res = await fetch(`${BASE}/api/auth/trial-token-info?token=${encodeURIComponent(lt)}`);
        if (!res.ok) {
          setState({ kind: "error", message: "This trial setup link is invalid, expired, or already used. Request a fresh one from the trial signup page." });
          return;
        }
        const data = await res.json();
        setState({ kind: "ready", email: data.email, name: data.name, company: data.company });
      } catch {
        setState({ kind: "error", message: "Couldn't reach the server. Please check your connection and try again." });
      }
    })();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError("");

    const pwProblem = passwordProblem(password);
    if (pwProblem) { setSubmitError(pwProblem); return; }
    if (password !== confirm) { setSubmitError("Passwords don't match."); return; }

    const params = new URLSearchParams(window.location.search);
    const lt = params.get("lt");
    if (!lt) { setSubmitError("Token missing from URL — please reopen the link from your email."); return; }

    setSubmitting(true);
    try {
      const res = await fetch(`${BASE}/api/auth/complete-trial-signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: lt, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) {
          setState({ kind: "error", message: "This trial setup link is no longer valid. It may have expired or already been used. Request a fresh one." });
          return;
        }
        // Prefer the server's human sentence; never surface a raw ALL_CAPS code.
        const friendly =
          data.message ||
          (data.error && PASSWORD_ERROR_MESSAGES[data.error]) ||
          (data.error && !/^[A-Z0-9_]+$/.test(String(data.error)) ? data.error : null) ||
          `Setup failed (${res.status})`;
        throw new Error(friendly);
      }
      const data = await res.json();
      login(data.user, data.token);
      window.history.replaceState({}, "", `${BASE}/dashboard`);
      window.location.replace(`${BASE}/dashboard`);
    } catch (err: any) {
      setSubmitError(err?.message ?? "Couldn't complete signup. Please try again.");
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/5 p-8">
        {state.kind === "loading" && (
          <div className="text-center">
            <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto mb-4" />
            <h1 className="text-lg font-semibold text-foreground mb-1">Verifying your link…</h1>
            <p className="text-sm text-muted-foreground">One moment.</p>
          </div>
        )}

        {state.kind === "error" && (
          <div className="text-center">
            <Shield className="w-8 h-8 text-amber-400 mx-auto mb-4" />
            <h1 className="text-lg font-semibold text-foreground mb-2">Link no longer valid</h1>
            <p className="text-sm text-muted-foreground mb-6">{state.message}</p>
            <a
              href="https://l3xy.io/start-trial"
              className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity"
            >
              Request a new trial link
            </a>
            <div className="mt-3">
              <a href={`${BASE}/login`} className="text-xs text-muted-foreground hover:text-foreground underline">
                Already have an account? Sign in
              </a>
            </div>
          </div>
        )}

        {state.kind === "ready" && (
          <>
            <div className="flex items-center gap-2 mb-1">
              <span className="inline-block w-2 h-2 rounded-full bg-primary animate-pulse" />
              <span className="text-xs uppercase tracking-wider text-primary font-semibold">L3XY Trial</span>
            </div>
            <h1 className="text-2xl font-bold text-foreground mb-1">
              Welcome, {state.name.split(" ")[0]}
            </h1>
            <p className="text-sm text-muted-foreground mb-6">
              Choose a password to finish setting up your <span className="text-foreground font-medium">{state.company}</span> workspace. Your trial includes 1 job and 20 interviews for 14 days.
            </p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1.5">Email</label>
                <div className="px-3 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm text-foreground">
                  {state.email}
                </div>
              </div>

              <div>
                <label htmlFor="password" className="text-xs font-medium text-muted-foreground block mb-1.5">
                  Choose a password <span className="text-amber-400">*</span>
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 12 characters"
                    autoComplete="new-password"
                    minLength={12}
                    required
                    className="w-full px-3 py-2.5 pr-10 rounded-lg bg-background border border-white/15 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(s => !s)}
                    className="absolute inset-y-0 right-0 px-3 text-muted-foreground hover:text-foreground"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  At least 12 characters, with an uppercase letter, a lowercase letter, a number, and a symbol.
                </p>
              </div>

              <div>
                <label htmlFor="confirm" className="text-xs font-medium text-muted-foreground block mb-1.5">
                  Confirm password <span className="text-amber-400">*</span>
                </label>
                <input
                  id="confirm"
                  type={showPassword ? "text" : "password"}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Re-enter your password"
                  autoComplete="new-password"
                  minLength={12}
                  required
                  className="w-full px-3 py-2.5 rounded-lg bg-background border border-white/15 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary"
                />
              </div>

              {submitError && (
                <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
                  {submitError}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-60"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                {submitting ? "Setting up your workspace…" : "Create account & sign in"}
              </button>

              <p className="text-[11px] text-muted-foreground text-center pt-2">
                Enterprise-grade security · SOC 2 ready · 256-bit encryption
              </p>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
