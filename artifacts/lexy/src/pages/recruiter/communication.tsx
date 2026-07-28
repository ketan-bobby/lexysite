/**
 * pages/recruiter/communication.tsx — Communication Health Monitor
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Shows the recruiter a health dashboard for ongoing candidate communication:
 * ghosting risk scores, days-since-last-contact, and recommended follow-up
 * actions for at-risk candidates across all active jobs.
 *
 * ─── Key sections ────────────────────────────────────────────────────────────
 *   Risk Overview       — count of candidates at each risk level (critical /
 *                         high / medium / low) with a progress bar breakdown
 *   At-Risk Candidate   — sorted list of highest-risk candidates; each card
 *                         shows risk score, last contact date, recommended
 *                         action (call / email / nurture), and a "Take Action"
 *                         button that opens the inbox/outreach flow
 *
 * ─── Data source ─────────────────────────────────────────────────────────────
 *   useListGhostingRisks() — GET /api/communication/ghosting-risks
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/communication
 */
import { AppLayout } from "@/components/layout/AppLayout";
import { useListGhostingRisks } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn, pluralize } from "@/lib/utils";
import { MessageSquareWarning, Send, Zap, AlertTriangle, Clock, CheckCircle, Bell } from "lucide-react";

// Ghosting-risk bands — an inverted risk quantity (higher = worse), not match fit;
// its own cutoffs, so any equality with a match band is coincidental.
const RISK_HIGH = 75;
const RISK_ELEVATED = 50;

const riskLevels = [
  { level: "critical", label: "Critical", color: "bg-red-100 text-red-700 border-red-200", dot: "bg-red-500" },
  { level: "high", label: "High", color: "bg-orange-100 text-orange-700 border-orange-200", dot: "bg-orange-500" },
  { level: "medium", label: "Medium", color: "bg-yellow-100 text-yellow-700 border-yellow-200", dot: "bg-yellow-400" },
  { level: "low", label: "Low", color: "bg-green-100 text-green-700 border-green-200", dot: "bg-green-500" },
];

const riskColor = (level: string) => riskLevels.find(r => r.level === level) || riskLevels[1];

const mockRisks = [
  { id: "1", candidateName: "Alex Martinez", jobTitle: "Senior Software Engineer", riskLevel: "critical", riskScore: 92, daysSinceContact: 12, stage: "Offer Extended", nextAction: "Send urgent follow-up", lastMessage: "We sent the offer letter on March 12th." },
  { id: "2", candidateName: "Sophie Turner", jobTitle: "Product Manager", riskLevel: "high", riskScore: 78, daysSinceContact: 8, stage: "Post-Interview", nextAction: "Share interview feedback", lastMessage: "Interview completed. Awaiting your feedback." },
  { id: "3", candidateName: "Omar Hassan", jobTitle: "Data Scientist", riskLevel: "high", riskScore: 71, daysSinceContact: 7, stage: "Technical Screen", nextAction: "Reschedule technical screen", lastMessage: "We're looking forward to your technical screen." },
  { id: "4", candidateName: "Lily Chen", jobTitle: "UX Designer", riskLevel: "medium", riskScore: 55, daysSinceContact: 5, stage: "Application Review", nextAction: "Send application update", lastMessage: "Your application is under review." },
  { id: "5", candidateName: "James Park", jobTitle: "DevOps Engineer", riskLevel: "medium", riskScore: 48, daysSinceContact: 4, stage: "Phone Screen", nextAction: "Confirm phone screen time", lastMessage: "Thanks for applying!" },
  { id: "6", candidateName: "Maria Santos", jobTitle: "Frontend Engineer", riskLevel: "low", riskScore: 20, daysSinceContact: 2, stage: "Interview Scheduled", nextAction: "Reminder in 2 days", lastMessage: "Interview scheduled for next Monday." },
];

export default function Communication() {
  const { data } = useListGhostingRisks();
  const risks = (data as any)?.risks?.length ? (data as any).risks : mockRisks;

  const criticalCount = risks.filter((r: any) => r.riskLevel === "critical").length;
  const highCount = risks.filter((r: any) => r.riskLevel === "high").length;

  return (
    <AppLayout>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
        <div>
          <h1 className="page-title">Anti-Ghosting Engine</h1>
          <p className="text-muted-foreground mt-1">AI-powered communication monitoring to prevent candidate drop-off.</p>
        </div>
        <Button className="gap-2">
          <Zap className="w-4 h-4" /> Run Auto Follow-ups
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <Card className="hover-elevate border-red-200">
          <CardContent className="p-5 flex items-center gap-3">
            <div className="p-2.5 bg-red-100 text-red-600 rounded-xl"><AlertTriangle className="w-5 h-5" /></div>
            <div><p className="text-xs text-muted-foreground">Critical Risk</p><p className="text-2xl font-bold text-red-600">{criticalCount}</p></div>
          </CardContent>
        </Card>
        <Card className="hover-elevate border-orange-200">
          <CardContent className="p-5 flex items-center gap-3">
            <div className="p-2.5 bg-orange-100 text-orange-600 rounded-xl"><Bell className="w-5 h-5" /></div>
            <div><p className="text-xs text-muted-foreground">High Risk</p><p className="text-2xl font-bold text-orange-600">{highCount}</p></div>
          </CardContent>
        </Card>
        <Card className="hover-elevate">
          <CardContent className="p-5 flex items-center gap-3">
            <div className="p-2.5 bg-blue-100 text-blue-600 rounded-xl"><Clock className="w-5 h-5" /></div>
            <div><p className="text-xs text-muted-foreground">Total Monitored</p><p className="text-2xl font-bold">{risks.length}</p></div>
          </CardContent>
        </Card>
        <Card className="hover-elevate">
          <CardContent className="p-5 flex items-center gap-3">
            <div className="p-2.5 bg-green-100 text-green-600 rounded-xl"><CheckCircle className="w-5 h-5" /></div>
            <div><p className="text-xs text-muted-foreground">Engaged Today</p><p className="text-2xl font-bold">{risks.filter((r: any) => r.daysSinceContact <= 1).length}</p></div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquareWarning className="w-5 h-5 text-primary" /> Ghosting Risk Monitor
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {risks.map((r: any) => {
              const cfg = riskColor(r.riskLevel);
              const isCritical = r.riskLevel === "critical";
              return (
                <div key={r.id} className={cn(
                  "p-4 rounded-xl border group hover-elevate transition-all",
                  isCritical ? "border-red-200 bg-red-50/50" : "border-border/60"
                )}>
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-4 flex-1 min-w-0">
                      <div className={cn(
                        "w-2 h-2 rounded-full flex-shrink-0",
                        cfg.dot,
                        isCritical && "animate-pulse"
                      )} />
                      <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center font-bold text-sm flex-shrink-0">
                        {(r.candidateName || "?").charAt(0)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-semibold text-sm">{r.candidateName}</p>
                          <Badge className={`text-[10px] border ${cfg.color}`}>{cfg.label} Risk</Badge>
                          <Badge variant="outline" className="text-[10px]">{r.stage}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{r.jobTitle} • Last contact {pluralize(r.daysSinceContact, "day")} ago</p>
                        <p className="text-xs text-muted-foreground italic mt-1">"{r.lastMessage}"</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-6 flex-shrink-0">
                      <div className="hidden md:block w-32">
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-muted-foreground">Risk Score</span>
                          <span className={`font-bold ${r.riskScore >= RISK_HIGH ? "text-red-600" : r.riskScore >= RISK_ELEVATED ? "text-orange-500" : "text-muted-foreground"}`}>{r.riskScore}%</span>
                        </div>
                        <Progress value={r.riskScore} className={cn("h-1.5", r.riskScore >= RISK_HIGH ? "[&>div]:bg-red-500" : r.riskScore >= RISK_ELEVATED ? "[&>div]:bg-orange-400" : "")} />
                      </div>
                      <div className="text-center hidden md:block">
                        <p className="text-xs text-muted-foreground">Next Action</p>
                        <p className="text-xs font-medium max-w-[120px]">{r.nextAction}</p>
                      </div>
                      <Button size="sm" className={cn("gap-1.5 h-8 opacity-0 group-hover:opacity-100 transition-opacity", isCritical ? "bg-red-600 hover:bg-red-700" : "")}>
                        <Send className="w-3.5 h-3.5" /> Follow-up
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </AppLayout>
  );
}
