/**
 * pages/not-found.tsx — 404 Not Found Page
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Catch-all route rendered when no other route matches. Shows a simple
 * branded 404 message with a "Go Home" link. Registered in App.tsx as the
 * final <Route> so it catches any unmatched path.
 */
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Brain } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center text-primary mb-6 shadow-xl shadow-primary/5">
        <Brain className="w-8 h-8" />
      </div>
      <h1 className="text-4xl font-display font-bold mb-2">404</h1>
      <p className="text-xl text-muted-foreground mb-8 text-center max-w-md">
        The page you are looking for doesn't exist or has been moved.
      </p>
      <Link href="/">
        <Button size="lg" className="hover-elevate active-elevate-2 shadow-lg shadow-primary/20">
          Return Home
        </Button>
      </Link>
    </div>
  );
}
