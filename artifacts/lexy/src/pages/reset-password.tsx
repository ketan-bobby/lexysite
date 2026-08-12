/**
 * pages/reset-password.tsx — Password Reset Completion Page
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Handles the "reset your password" link that is emailed to users who click
 * "Forgot password" on the login page. Validates the reset token and lets
 * the user set a new password.
 *
 * ─── Flow ────────────────────────────────────────────────────────────────────
 *   1. URL: /reset-password?token=<tok>
 *   2. On mount: validates token presence (client-side only — server validates
 *      on submit to avoid revealing token validity via GET)
 *   3. User enters and confirms new password
 *   4. POST /api/public/auth/reset-password { token, password }
 *   5. On success: show "Password updated" confirmation + "Go to Login" CTA
 *   6. On error: show error message (invalid token / expired / already used)
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /reset-password  (linked from password-reset emails)
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import { CheckCircle2, Loader2, Eye, EyeOff, ArrowRight } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function ResetPassword() {
  const [, navigate] = useLocation();
  const { login } = useAuth();

  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("token") ?? "";
    setToken(t);
    if (!t) setError("This reset link is missing a token. Please request a new one.");
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    if (password.length < 12) {
      setError("Password must be at least 12 characters.");
      return;
    }
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      setError("Password must include an uppercase letter, a lowercase letter, a number, and a symbol.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/public/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Server sends machine codes in `error` (e.g. PASSWORD_TOO_SHORT) with
        // the human sentence in `message` — never show a raw code.
        const isCode = (s: unknown) => typeof s !== "string" || /^[A-Z0-9_]+$/.test(s);
        const human = [data.message, data.error].find(v => v && !isCode(v));
        setError(human ?? "Could not reset your password.");
        return;
      }
      // Auto-login on success
      if (data.user) {
        login(data.user, data.token);
      }
      setSuccess(true);
      setTimeout(() => {
        navigate(data.user?.role === "candidate" ? "/portal/career" : "/login");
      }, 1500);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen text-foreground flex flex-col">
      <header className="border-b border-border/40 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="font-black text-lg tracking-tight select-none">
            L<span style={{ color: "hsl(186 100% 48%)" }}>3</span>xy AI
            <span className="text-muted-foreground align-super" style={{ fontSize: "0.5em" }}>™</span>
          </span>
        </div>
        <span className="text-xs text-muted-foreground">Password reset</span>
      </header>

      <main className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-md">
          <h1 className="text-3xl font-black tracking-tight mb-2">Choose a new password</h1>
          <p className="text-sm text-muted-foreground mb-8">
            Enter a new password for your L3xy account. You'll be signed in automatically once it's saved.
          </p>

          {success ? (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-6 text-center">
              <CheckCircle2 className="w-10 h-10 mx-auto text-emerald-400 mb-3" />
              <p className="font-semibold">Password updated</p>
              <p className="text-sm text-muted-foreground mt-1">Redirecting you now…</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <Label htmlFor="password">New password</Label>
                <div className="relative mt-1.5">
                  <Input
                    id="password"
                    type={showPass ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 12 characters"
                    autoComplete="new-password"
                    disabled={loading || !token}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass((s) => !s)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showPass ? "Hide password" : "Show password"}
                  >
                    {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <Label htmlFor="confirm">Confirm new password</Label>
                <Input
                  id="confirm"
                  type={showPass ? "text" : "password"}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Re-enter your new password"
                  autoComplete="new-password"
                  disabled={loading || !token}
                  className="mt-1.5"
                />
              </div>

              {error && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
                  {error}
                </div>
              )}

              <Button type="submit" disabled={loading || !token} className="w-full">
                {loading ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Updating…</>
                ) : (
                  <>Update password <ArrowRight className="w-4 h-4 ml-2" /></>
                )}
              </Button>

              <div className="text-center text-sm text-muted-foreground">
                <a href={`${BASE}/login`} className="hover:text-foreground">Back to sign in</a>
              </div>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
