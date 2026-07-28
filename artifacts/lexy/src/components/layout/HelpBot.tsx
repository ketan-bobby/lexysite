/**
 * HelpBot.tsx — Floating in-app help assistant for staff users.
 *
 * A launcher button (bottom-right) opens a chat panel. Questions go to
 * POST /api/help/ask, which answers from the Recruiter Guide knowledge base.
 * When the bot can't resolve a question, the SERVER escalates it to the
 * platform admins by email automatically — the UI just surfaces that fact.
 *
 * Auth rides the same cookie/dev-Bearer pattern as the rest of the app.
 * Mounted once inside AppLayout so it's available on every staff page
 * (never on the candidate portal or the public interview room).
 */
import { useEffect, useRef, useState } from "react";
import { HelpCircle, Loader2, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authHeaders } from "@/lib/api";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

interface Msg {
  role: "user" | "assistant";
  content: string;
  escalated?: boolean;
}

const GREETING: Msg = {
  role: "assistant",
  content:
    "Hi! I'm the Lexy help assistant. Ask me anything about using the platform — how-to steps, where to find things, or why something is behaving a certain way. If I can't resolve it, I'll forward your question to our support team automatically.",
};

export function HelpBot({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [messages, setMessages] = useState<Msg[]>([GREETING]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const ask = async () => {
    const question = input.trim();
    if (!question || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: question }]);
    setBusy(true);
    try {
      /* Send a short rolling history (excluding the canned greeting) so
         follow-up questions keep their context. */
      const history = messages
        .filter((m) => m !== GREETING)
        .slice(-6)
        .map(({ role, content }) => ({ role, content: content.slice(0, 2000) }));
      const res = await fetch(`${BASE}/api/help/ask`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ question, history }),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const data: { answer: string; resolved: boolean; escalated: boolean } = await res.json();
      setMessages((m) => [
        ...m,
        { role: "assistant", content: data.answer, escalated: data.escalated },
      ]);
    } catch {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content:
            "Sorry — I couldn't reach the help service. Please check your connection and try again.",
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <>
      {/* Panel — sits above the floating help launcher (bottom-right) */}
      {open && (
        <div className="fixed bottom-24 right-6 z-50 flex h-[520px] max-h-[calc(100vh-8rem)] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
          <div className="flex items-center justify-between border-b border-border bg-primary px-4 py-3 text-primary-foreground">
            <div className="flex items-center gap-2">
              <HelpCircle className="h-5 w-5" />
              <div>
                <div className="text-sm font-semibold leading-tight">Lexy Help</div>
                <div className="text-[11px] opacity-80">Answers from the Recruiter Guide</div>
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label="Close help assistant"
              className="rounded p-1 hover:bg-white/15"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
            {messages.map((m, i) => (
              <div
                key={i}
                className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
              >
                <div
                  className={
                    m.role === "user"
                      ? "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground"
                      : "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm text-foreground"
                  }
                >
                  {m.content}
                  {m.escalated && (
                    <div className="mt-1.5 rounded-md bg-amber-500/15 px-2 py-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                      Forwarded to support
                    </div>
                  )}
                </div>
              </div>
            ))}
            {busy && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
                </div>
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
            className="flex items-center gap-2 border-t border-border p-3"
          >
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask a question…"
              maxLength={1000}
              className="h-9 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
            <Button
              type="submit"
              size="icon"
              className="h-9 w-9 shrink-0"
              disabled={busy || !input.trim()}
              aria-label="Send question"
            >
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      )}
    </>
  );
}
