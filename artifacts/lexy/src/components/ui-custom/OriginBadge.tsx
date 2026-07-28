/**
 * OriginBadge — sourcing-origin attribution pill + fee-eligibility indicator.
 *
 * Origin is derived from the application's entry_type + origin_evidence:
 *   • entry_type='sourced' + evidence.channel='ai_sourcing' → "AI Sourced" (fee-eligible)
 *   • entry_type='sourced' + evidence.channel='linx'        → "LINX" (fee-eligible)
 *   • entry_type='applied'                                  → "Direct Apply"
 *   • entry_type='manual'                                   → "Recruiter Added"
 *   • entry_type='sourced' with NULL evidence               → "Sourced (pre-launch)" — NEVER fee-eligible
 */
import { Badge } from "@/components/ui/badge";
import { Sparkles, Link2, UserPlus, Send, CircleHelp } from "lucide-react";

export type OriginEvidence = { channel?: string; [k: string]: unknown } | null | undefined;

export function originInfo(entryType: string | null | undefined, evidence: OriginEvidence) {
  const channel =
    evidence && typeof evidence === "object" ? String((evidence as any).channel ?? "") : "";
  if (entryType === "sourced" && channel === "ai_sourcing")
    return {
      label: "AI Sourced",
      feeEligible: true,
      cls: "bg-primary/15 text-primary border-primary/30",
      Icon: Sparkles,
    };
  if (entryType === "sourced" && channel === "linx")
    return {
      label: "LINX",
      feeEligible: true,
      cls: "bg-purple-500/15 text-purple-600 border-purple-500/30",
      Icon: Link2,
    };
  if (entryType === "sourced")
    return {
      label: "Sourced (pre-launch)",
      feeEligible: false,
      cls: "bg-muted-bg text-muted-foreground border-border",
      Icon: CircleHelp,
    };
  if (entryType === "applied")
    return {
      label: "Direct Apply",
      feeEligible: false,
      cls: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
      Icon: Send,
    };
  if (entryType === "manual")
    return {
      label: "Recruiter Added",
      feeEligible: false,
      cls: "bg-slate-500/15 text-slate-600 border-slate-500/30",
      Icon: UserPlus,
    };
  return {
    label: "Unknown",
    feeEligible: false,
    cls: "bg-muted-bg text-muted-foreground border-border",
    Icon: CircleHelp,
  };
}

export function OriginBadge({
  entryType,
  originEvidence,
  showFeeTag = false,
}: {
  entryType: string | null | undefined;
  originEvidence: OriginEvidence;
  showFeeTag?: boolean;
}) {
  const info = originInfo(entryType, originEvidence);
  const { Icon } = info;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant="outline" className={`${info.cls} text-[11px] gap-1`}>
        <Icon className="w-3 h-3" />
        {info.label}
      </Badge>
      {showFeeTag && info.feeEligible && (
        <Badge
          variant="outline"
          className="bg-amber-500/15 text-amber-600 border-amber-500/30 text-[11px]"
        >
          Fee-eligible
        </Badge>
      )}
    </span>
  );
}
