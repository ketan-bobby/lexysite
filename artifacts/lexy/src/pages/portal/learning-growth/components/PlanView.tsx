import { Link } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, Target, Map } from "lucide-react";
import type { LearningGrowthResponse } from "@workspace/api-client-react";

import { CourseCatalog } from "./CourseCatalog";
import { AssessmentHome } from "./AssessmentHome";
import { VoiceProgressHome } from "./VoiceProgressHome";
import { AchievementsHome } from "./AchievementsHome";

const CAREER_AREAS = [
  { value: "software_technology", label: "Software & Technology" },
  { value: "data_analytics", label: "Data & Analytics" },
  { value: "finance_accounting", label: "Finance & Accounting" },
  { value: "sales_marketing", label: "Sales & Marketing" },
  { value: "customer_service", label: "Customer Service" },
  { value: "operations", label: "Operations" },
  { value: "exploring", label: "Still Exploring" },
  { value: "other", label: "Other" },
];

export function PlanView({
  data,
  onEdit,
}: {
  data: LearningGrowthResponse;
  onEdit: (kind: "interests" | "goals") => void;
}) {
  const { plan, goals } = data;

  return (
    <div className="space-y-6">
      <Card className="bg-gradient-to-br from-primary/5 to-transparent border-primary/20">
        <CardHeader className="pb-4">
          <CardTitle className="text-2xl flex items-center gap-2">
            <Target className="w-6 h-6 text-primary" />
            Your Development Plan
          </CardTitle>
          {plan?.summary && (
            <CardDescription className="text-base text-foreground/90">
              {plan.summary}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {plan?.startingPointNote && (
            <div className="bg-background/60 p-4 rounded-lg border backdrop-blur-sm shadow-sm mb-6">
              <h4 className="font-semibold text-sm text-primary mb-1 uppercase tracking-wide">
                Starting Point
              </h4>
              <p className="text-sm">{plan.startingPointNote}</p>
            </div>
          )}

          {plan?.nextSteps && plan.nextSteps.length > 0 && (
            <div className="space-y-4 mb-8">
              <h3 className="font-semibold text-lg border-b pb-2 flex items-center gap-2">
                <Map className="w-5 h-5 text-primary/70" /> Actionable Next Steps
              </h3>
              <div className="grid gap-3">
                {plan.nextSteps.map((step) => (
                  <div
                    key={step.id}
                    className="flex gap-4 p-4 rounded-xl border bg-card hover:border-primary/30 transition-colors"
                  >
                    <div className="mt-0.5">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold shadow-inner">
                        {step.kind === "practice" ? "P" : step.kind === "reflection" ? "R" : "S"}
                      </div>
                    </div>
                    <div className="flex-1">
                      <div className="flex items-start justify-between">
                        <h4 className="font-medium text-base">{step.title}</h4>
                        <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
                          {step.kind}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground mt-1.5">{step.description}</p>
                      {step.href && (
                        <Button asChild variant="link" className="h-auto p-0 mt-2 text-primary">
                          <Link href={step.href} className="flex items-center gap-1">
                            Open Resource <ExternalLink className="w-3 h-3" />
                          </Link>
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <CourseCatalog />
          <VoiceProgressHome />
          <AchievementsHome />
          <AssessmentHome />
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between border-b mb-3">
            <CardTitle className="text-lg">Your Goals</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => onEdit("goals")}>
              Edit goals
            </Button>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div>
              <h5 className="font-semibold text-muted-foreground uppercase text-[11px] tracking-widest mb-1">
                Immediate
              </h5>
              <p>{goals?.immediateGoal}</p>
            </div>
            <div>
              <h5 className="font-semibold text-muted-foreground uppercase text-[11px] tracking-widest mb-1">
                3-Year
              </h5>
              <p>{goals?.careerGoal3yr}</p>
            </div>
            <div>
              <h5 className="font-semibold text-muted-foreground uppercase text-[11px] tracking-widest mb-1">
                5-Year
              </h5>
              <p>{goals?.careerGoal5yr}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between border-b mb-3">
            <CardTitle className="text-lg">Your Profile</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => onEdit("interests")}>
              Edit interests
            </Button>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div>
              <h5 className="font-semibold text-muted-foreground uppercase text-[11px] tracking-widest mb-1">
                Career Areas
              </h5>
              <div className="flex flex-wrap gap-1 mt-1">
                {data.interests?.careerAreas?.map((area: string) => (
                  <Badge key={area} variant="secondary">
                    {CAREER_AREAS.find((a) => a.value === area)?.label || area}
                  </Badge>
                ))}
              </div>
            </div>
            {(data.interests?.immediateRoles?.length ?? 0) > 0 && (
              <div>
                <h5 className="font-semibold text-muted-foreground uppercase text-[11px] tracking-widest mb-1">
                  Target Roles
                </h5>
                <div className="flex flex-wrap gap-1 mt-1">
                  {data.interests?.immediateRoles?.map((role: string) => (
                    <Badge key={role} variant="outline" className="bg-background">
                      {role}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <h5 className="font-semibold text-muted-foreground uppercase text-[11px] tracking-widest mb-1">
                  Education Stage
                </h5>
                <p className="capitalize">{data.interests?.educationStage?.replace("_", " ")}</p>
              </div>
              <div>
                <h5 className="font-semibold text-muted-foreground uppercase text-[11px] tracking-widest mb-1">
                  Timing
                </h5>
                <p className="capitalize">{data.interests?.startTiming?.replace("_", " ")}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
