/**
 * components/share/ShareModal.tsx — Viral Share Modal (Career Snapshot)
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Full-featured share dialog for the Lexy Career Snapshot. Shows a live
 * preview of the ShareCard, three AI-generated captions (LinkedIn / X /
 * reflective), and action buttons to copy caption, download PNG, or open
 * a pre-filled LinkedIn / X share intent URL.
 *
 * ─── Flow ────────────────────────────────────────────────────────────────────
 *   1. Parent opens the modal with an insight + candidate/job context.
 *   2. Modal calls generateCaptions() (share-engine.ts) for three caption variants.
 *   3. User picks a caption, previews the card, and clicks Download or Share.
 *   4. Download: toPng() renders ShareCard at 2× resolution → browser saves file.
 *   5. Share: opens a new tab with a LinkedIn/X intent URL including caption text.
 *   6. All events are tracked via trackShareEvent() (share-analytics.ts).
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   pages/recruiter/candidates/[id].tsx  — "Share" button on candidate profile
 */

import { useRef, useState, useCallback } from "react";
import { toPng } from "html-to-image";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@workspace/react-hooks/use-toast";
import { ShareCard } from "./ShareCard";
import { generateCaptions, topPercentLabel } from "@/lib/share-engine";
import { trackShareEvent } from "@/lib/share-analytics";
import type { LexyInsight } from "@/lib/share-engine";
import {
  Copy, Download, Linkedin, Twitter, Check, Share2, Sparkles,
  ChevronDown, ChevronUp,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ShareModalProps {
  open: boolean;
  onClose: () => void;
  insight: LexyInsight;
  candidateName?: string;
  jobTitle?: string;
}

type CaptionKey = "linkedin" | "x" | "reflective";

const CAPTION_META: { key: CaptionKey; label: string; icon: React.ReactNode; desc: string }[] = [
  {
    key: "linkedin",
    label: "LinkedIn",
    icon: <Linkedin className="w-3.5 h-3.5" />,
    desc: "Professional · long-form",
  },
  {
    key: "x",
    label: "X / Twitter",
    icon: <Twitter className="w-3.5 h-3.5" />,
    desc: "Short · punchy",
  },
  {
    key: "reflective",
    label: "Reflective",
    icon: <Sparkles className="w-3.5 h-3.5" />,
    desc: "Personal growth",
  },
];

export function ShareModal({ open, onClose, insight, candidateName, jobTitle }: ShareModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const captions = generateCaptions(insight, candidateName);

  const [activeCaption, setActiveCaption] = useState<CaptionKey>("linkedin");
  const [copiedKey, setCopiedKey] = useState<CaptionKey | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [expandedCaption, setExpandedCaption] = useState(false);

  const handleDownload = useCallback(async () => {
    if (!cardRef.current) return;
    setDownloading(true);
    try {
      const dataUrl = await toPng(cardRef.current, {
        pixelRatio: 2.5,
        backgroundColor: "#0A0F1E",
      });
      const link = document.createElement("a");
      link.download = `lexy-career-snapshot-${(candidateName ?? "candidate").replace(/\s+/g, "-").toLowerCase()}.png`;
      link.href = dataUrl;
      link.click();
      trackShareEvent("image_downloaded", { candidateId: undefined });
      toast({ title: "Image downloaded!", description: "Share card saved as PNG." });
    } catch (err) {
      console.error(err);
      toast({ title: "Download failed", description: "Try again in a moment.", variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  }, [candidateName, toast]);

  const handleCopy = useCallback(async (key: CaptionKey) => {
    const text = captions[key];
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      trackShareEvent("caption_copied", { caption_type: key });
      toast({ title: "Caption copied!", description: `${CAPTION_META.find(m => m.key === key)?.label} caption in clipboard.` });
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      toast({ title: "Copy failed", description: "Please select and copy manually.", variant: "destructive" });
    }
  }, [captions, toast]);

  const linkedInUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent("https://l3xy.ai")}`;
  const xUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(captions.x.slice(0, 260))}&url=${encodeURIComponent("https://l3xy.ai")}`;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent
        className="max-w-3xl p-0 overflow-hidden border-border/50 bg-card"
      >
        <DialogHeader className="px-6 pt-5 pb-0">
          <DialogTitle className="flex items-center gap-2 text-base font-bold">
            <Share2 className="w-4 h-4 text-primary" />
            Share Career Snapshot
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col md:flex-row gap-0 min-h-0">

          {/* ── Left: Card Preview ──────────────────────────────────────── */}
          <div className="flex-shrink-0 bg-[#060B18] flex flex-col items-center justify-center p-6 gap-4 border-r border-border/30 min-w-[320px]">
            <div className="text-[10px] text-muted-foreground font-semibold uppercase tracking-widest mb-1">
              Preview
            </div>
            <div style={{ transform: "scale(0.72)", transformOrigin: "top center" }}>
              <ShareCard
                ref={cardRef}
                insight={insight}
                candidateName={candidateName}
                jobTitle={jobTitle}
              />
            </div>

            {/* Action buttons */}
            <div className="flex flex-col gap-2 w-full mt-2">
              <Button
                onClick={handleDownload}
                disabled={downloading}
                className="w-full gap-2 bg-primary/90 hover:bg-primary"
                size="sm"
              >
                <Download className="w-3.5 h-3.5" />
                {downloading ? "Generating…" : "Download PNG"}
              </Button>

              <div className="grid grid-cols-2 gap-2">
                <a href={linkedInUrl} target="_blank" rel="noopener noreferrer"
                  onClick={() => trackShareEvent("linkedin_share")}>
                  <Button variant="outline" size="sm" className="w-full gap-1.5 text-[#0A66C2] border-[#0A66C2]/30 hover:bg-[#0A66C2]/10">
                    <Linkedin className="w-3.5 h-3.5" /> LinkedIn
                  </Button>
                </a>
                <a href={xUrl} target="_blank" rel="noopener noreferrer"
                  onClick={() => trackShareEvent("x_share" as any)}>
                  <Button variant="outline" size="sm" className="w-full gap-1.5 border-border/50 hover:bg-muted/40">
                    <Twitter className="w-3.5 h-3.5" /> X / Twitter
                  </Button>
                </a>
              </div>
            </div>
          </div>

          {/* ── Right: Captions ─────────────────────────────────────────── */}
          <div className="flex-1 flex flex-col min-h-0 overflow-y-auto p-5">
            <div className="text-[10px] text-muted-foreground font-semibold uppercase tracking-widest mb-3">
              Generated Captions
            </div>

            {/* Caption tab selector */}
            <div className="flex gap-1.5 mb-4 flex-wrap">
              {CAPTION_META.map(({ key, label, icon, desc }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => { setActiveCaption(key); setExpandedCaption(false); }}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all",
                    activeCaption === key
                      ? "border-primary/50 bg-primary/15 text-primary"
                      : "border-border/40 text-muted-foreground hover:border-border hover:text-foreground",
                  )}
                >
                  {icon}
                  {label}
                  <span className="text-[9px] opacity-50 hidden sm:inline">· {desc}</span>
                </button>
              ))}
            </div>

            {/* Active caption */}
            {CAPTION_META.map(({ key }) => {
              if (key !== activeCaption) return null;
              const text = captions[key];
              const lines = text.split("\n");
              const preview = lines.slice(0, 4).join("\n");
              const isLong = lines.length > 4;

              return (
                <div key={key} className="flex-1 flex flex-col">
                  <div
                    className="flex-1 rounded-xl border border-border/40 bg-muted/20 p-4 text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap cursor-text select-all font-mono text-[11px] relative overflow-hidden"
                    style={{ minHeight: 160, maxHeight: expandedCaption ? "none" : 180, overflow: expandedCaption ? "auto" : "hidden" }}
                  >
                    {expandedCaption ? text : preview}
                    {isLong && !expandedCaption && (
                      <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-[#111827] to-transparent pointer-events-none" />
                    )}
                  </div>

                  {isLong && (
                    <button
                      type="button"
                      onClick={() => setExpandedCaption(p => !p)}
                      className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground mt-1 self-start transition-colors"
                    >
                      {expandedCaption
                        ? <><ChevronUp className="w-3 h-3" /> Collapse</>
                        : <><ChevronDown className="w-3 h-3" /> Show full caption</>
                      }
                    </button>
                  )}

                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3 gap-2 self-end"
                    onClick={() => handleCopy(key)}
                  >
                    {copiedKey === key
                      ? <><Check className="w-3.5 h-3.5 text-emerald-400" /> Copied!</>
                      : <><Copy className="w-3.5 h-3.5" /> Copy caption</>
                    }
                  </Button>
                </div>
              );
            })}

            {/* Insight summary strip */}
            <div className="mt-4 pt-4 border-t border-border/30 space-y-2">
              <div className="text-[10px] text-muted-foreground font-semibold uppercase tracking-widest mb-2">
                Snapshot Summary
              </div>
              <div className="flex flex-wrap gap-2">
                {topPercentLabel(insight.percentile_rank) && (
                  <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400 bg-emerald-500/5">
                    {topPercentLabel(insight.percentile_rank)}
                  </Badge>
                )}
                <Badge variant="outline" className="text-[10px]">
                  {insight.tier}
                </Badge>
                <Badge variant="outline" className="text-[10px] border-primary/30 text-primary bg-primary/5">
                  Score: {insight.composite_score}/100
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed italic">
                "{insight.short_summary}"
              </p>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
