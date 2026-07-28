/**
 * components/layout/BackToHome.tsx — small "back to home" link
 *
 * Standalone full-screen pages (audit log, deletion queues, legal notices)
 * render outside AppLayout, so they have no sidebar/top-nav and would
 * otherwise be navigation dead-ends. Drop this at the top of such a page,
 * pointing at the right home for the page's audience.
 */
import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";

export function BackToHome({
  to = "/dashboard",
  label = "Back to home",
}: {
  to?: string;
  label?: string;
}) {
  return (
    <Link
      href={to}
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
    >
      <ArrowLeft className="w-4 h-4" />
      {label}
    </Link>
  );
}
