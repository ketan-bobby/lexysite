/**
 * components/share/ShareCard.tsx — Lexy Career Snapshot Shareable Card
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Renders the "Lexy Career Snapshot" — a visually rich card suitable for
 * sharing on LinkedIn or X. Displays the candidate's hire probability,
 * screening / interview / verification signal bars, and a Lexy verdict badge.
 *
 * The component is exported as a forwardRef so the parent (ShareModal) can
 * pass it directly to html-to-image's toPng() for PNG export without
 * any extra DOM querying.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   components/share/ShareModal.tsx  — rendered inside the share dialog preview
 */

import { forwardRef } from "react";
import type { LexyInsight } from "@/lib/share-engine";
import { topPercentLabel } from "@/lib/share-engine";

interface ShareCardProps {
  insight: LexyInsight;
  candidateName?: string;
  jobTitle?: string;
}

function SignalBar({ label, score, color }: { label: string; score: number; color: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: "#9CA3AF", letterSpacing: "0.06em", textTransform: "uppercase" }}>
          {label}
        </span>
        <span style={{ fontSize: 12, fontWeight: 800, color, fontVariantNumeric: "tabular-nums" }}>
          {score}
        </span>
      </div>
      <div style={{ height: 5, borderRadius: 99, background: "rgba(255,255,255,0.07)", overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: `${score}%`,
            borderRadius: 99,
            background: `linear-gradient(90deg, ${color}99, ${color})`,
            transition: "width 0.6s ease",
          }}
        />
      </div>
    </div>
  );
}

const TIER_COLOR: Record<string, string> = {
  Exceptional: "#4ade80",
  Strong:      "#22d3ee",
  Promising:   "#facc15",
  Developing:  "#fb923c",
};

export const ShareCard = forwardRef<HTMLDivElement, ShareCardProps>(
  ({ insight, candidateName, jobTitle }, ref) => {
    const tierColor = TIER_COLOR[insight.tier] ?? "#22d3ee";
    const { signals, percentile_rank, identity_label, strongest_trait, biggest_gap, composite_score, tier } = insight;

    return (
      <div
        ref={ref}
        style={{
          width: 480,
          minHeight: 320,
          background: "linear-gradient(135deg, #0A0F1E 0%, #0D1526 60%, #0A1A1F 100%)",
          borderRadius: 20,
          overflow: "hidden",
          fontFamily: "'Inter', 'Helvetica Neue', sans-serif",
          position: "relative",
          border: "1px solid rgba(255,255,255,0.06)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
        }}
      >
        {/* Ambient glow top */}
        <div style={{
          position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)",
          width: 260, height: 180,
          background: `radial-gradient(ellipse at center, ${tierColor}18 0%, transparent 70%)`,
          pointerEvents: "none",
        }} />

        {/* Top accent bar */}
        <div style={{ height: 3, background: `linear-gradient(90deg, transparent, ${tierColor}, transparent)` }} />

        <div style={{ padding: "22px 26px 20px" }}>

          {/* Header row */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 }}>
            <div>
              {/* Lexy wordmark */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <div style={{
                  width: 22, height: 22, borderRadius: 6,
                  background: `linear-gradient(135deg, ${tierColor}40, ${tierColor}20)`,
                  border: `1px solid ${tierColor}40`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: tierColor }} />
                </div>
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.12em", color: "#6B7280" }}>
                  L3XY AI
                </span>
                <span style={{ fontSize: 9, color: "#374151", fontWeight: 600, letterSpacing: "0.05em" }}>
                  · CAREER SNAPSHOT
                </span>
              </div>

              {/* Candidate name */}
              {candidateName && (
                <div style={{ fontSize: 19, fontWeight: 900, color: "#F9FAFB", letterSpacing: "-0.02em", lineHeight: 1.1 }}>
                  {candidateName}
                </div>
              )}
              {jobTitle && (
                <div style={{ fontSize: 10, color: "#6B7280", marginTop: 2, fontWeight: 500 }}>
                  {jobTitle}
                </div>
              )}
            </div>

            {/* Composite score ring */}
            <div style={{ textAlign: "center", flexShrink: 0 }}>
              <div style={{
                width: 64, height: 64, borderRadius: "50%",
                background: `conic-gradient(${tierColor} ${composite_score * 3.6}deg, rgba(255,255,255,0.05) 0deg)`,
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: `0 0 20px ${tierColor}30`,
              }}>
                <div style={{
                  width: 50, height: 50, borderRadius: "50%",
                  background: "#0A0F1E",
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                }}>
                  <span style={{ fontSize: 16, fontWeight: 900, color: tierColor, lineHeight: 1 }}>
                    {composite_score}
                  </span>
                  <span style={{ fontSize: 7, color: "#4B5563", fontWeight: 600, letterSpacing: "0.05em" }}>
                    /100
                  </span>
                </div>
              </div>
              <div style={{
                marginTop: 5, fontSize: 8, fontWeight: 800, letterSpacing: "0.08em",
                color: tierColor, textTransform: "uppercase",
              }}>
                {tier}
              </div>
            </div>
          </div>

          {/* Percentile + Identity label.
              Percentile floor: never print a "Top N%" worse than Top 50% on a
              public shareable — fall back to the growth-framed identity label. */}
          <div style={{
            padding: "10px 14px",
            borderRadius: 10,
            background: `linear-gradient(135deg, ${tierColor}14, transparent)`,
            border: `1px solid ${tierColor}25`,
            marginBottom: 18,
          }}>
            <div style={{ fontSize: topPercentLabel(percentile_rank) ? 22 : 16, fontWeight: 900, color: tierColor, lineHeight: 1.2, marginBottom: 4 }}>
              {topPercentLabel(percentile_rank) ?? identity_label}
            </div>
            {topPercentLabel(percentile_rank) && (
              <div style={{ fontSize: 11, color: "#D1D5DB", fontWeight: 500, lineHeight: 1.4 }}>
                {identity_label}
              </div>
            )}
          </div>

          {/* Signal bars */}
          <div style={{ marginBottom: 16 }}>
            <SignalBar label={signals.communication.label} score={signals.communication.score} color={signals.communication.color} />
            <SignalBar label={signals.problem_solving.label} score={signals.problem_solving.score} color={signals.problem_solving.color} />
            <SignalBar label={signals.role_fit.label} score={signals.role_fit.score} color={signals.role_fit.color} />
          </div>

          {/* Strength + Gap row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 18 }}>
            <div style={{
              padding: "8px 10px", borderRadius: 8,
              background: "rgba(74,222,128,0.06)", border: "1px solid rgba(74,222,128,0.15)",
            }}>
              <div style={{ fontSize: 8, fontWeight: 700, color: "#4ade80", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 3 }}>
                ↑ Strongest
              </div>
              <div style={{ fontSize: 10, color: "#E5E7EB", fontWeight: 600, lineHeight: 1.3 }}>
                {strongest_trait}
              </div>
            </div>
            <div style={{
              padding: "8px 10px", borderRadius: 8,
              background: "rgba(251,145,24,0.06)", border: "1px solid rgba(251,145,24,0.15)",
            }}>
              <div style={{ fontSize: 8, fontWeight: 700, color: "#fb923c", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 3 }}>
                ↗ Growth Edge
              </div>
              <div style={{ fontSize: 10, color: "#E5E7EB", fontWeight: 600, lineHeight: 1.3 }}>
                {biggest_gap}
              </div>
            </div>
          </div>

          {/* CTA footer */}
          <div style={{
            borderTop: "1px solid rgba(255,255,255,0.05)",
            paddingTop: 12,
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <span style={{ fontSize: 9, color: "#374151", fontWeight: 500 }}>
              AI-powered hiring intelligence
            </span>
            <span style={{
              fontSize: 9, fontWeight: 700, color: tierColor,
              letterSpacing: "0.04em",
            }}>
              Get your Lexy profile →
            </span>
          </div>
        </div>
      </div>
    );
  },
);

ShareCard.displayName = "ShareCard";
