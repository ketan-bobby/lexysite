/**
 * CookieBanner.tsx
 * Marketing-site cookie consent banner.
 *
 * Renders a fixed bottom banner prompting visitors to accept or reject
 * non-essential (analytics) cookies. The user's choice is persisted in
 * localStorage so the banner only appears until a decision is made.
 *
 * Exports: default `CookieBanner` component.
 */
import { useState, useEffect } from "react";
import { Cookie, X, ShieldCheck } from "lucide-react";
import { Link } from "wouter";

// localStorage key holding the visitor's consent decision ("accepted" | "rejected").
const STORAGE_KEY = "lexy_cookie_consent";

export default function CookieBanner() {
  const [visible, setVisible] = useState(false);

  // Show the banner only when no prior consent decision is stored.
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) setVisible(true);
  }, []);

  // Persist consent for all cookie categories and hide the banner.
  const accept = () => {
    localStorage.setItem(STORAGE_KEY, "accepted");
    setVisible(false);
  };

  // Persist rejection of non-essential cookies and hide the banner.
  const reject = () => {
    localStorage.setItem(STORAGE_KEY, "rejected");
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[200] p-4 md:p-6">
      <div className="max-w-5xl mx-auto bg-card border border-border rounded-2xl shadow-2xl p-5 md:p-6 flex flex-col md:flex-row items-start md:items-center gap-4">
        <div className="flex items-center gap-3 shrink-0">
          <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
            <Cookie className="w-4 h-4" />
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium mb-0.5">We use cookies</p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            We use strictly necessary cookies to keep the platform running. We also use analytics
            cookies to understand how visitors use our site — only with your consent. Read our{" "}
            <Link
              href="/privacy"
              className="text-primary underline underline-offset-2 hover:text-primary/80 transition-colors"
            >
              Privacy Policy
            </Link>{" "}
            and{" "}
            <Link
              href="/privacy#cookies"
              className="text-primary underline underline-offset-2 hover:text-primary/80 transition-colors"
            >
              Cookie Policy
            </Link>{" "}
            for details. You can change your preferences at any time.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0 w-full md:w-auto">
          <button
            onClick={reject}
            className="flex-1 md:flex-none px-4 py-2 rounded-lg text-sm font-medium border border-border hover:border-primary/30 text-muted-foreground hover:text-foreground transition-colors"
          >
            Reject Non-Essential
          </button>
          <button
            onClick={accept}
            className="flex-1 md:flex-none flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            Accept All
          </button>
          <button
            onClick={reject}
            className="text-muted-foreground hover:text-foreground transition-colors p-1"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
