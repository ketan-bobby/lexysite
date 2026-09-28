import { useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { useConfirmLearningGrowthGoals, useGetLearningGrowth } from "@/lib/use-learning-growth";
import type { LearningGrowthResponse } from "@workspace/api-client-react";

export function GoalsForm({ data, onComplete }: { data: LearningGrowthResponse; onComplete?: () => void }) {
  const confirmGoals = useConfirmLearningGrowthGoals();
  const draftRevision = useRef(data.revision);
  const { refetch } = useGetLearningGrowth();
  
  const [immediateGoal, setImmediateGoal] = useState(data.goals?.immediateGoal || "");
  const [careerGoal3yr, setCareerGoal3yr] = useState(data.goals?.careerGoal3yr || "");
  const [careerGoal5yr, setCareerGoal5yr] = useState(data.goals?.careerGoal5yr || "");

  const reloadLatest = async () => {
    const result = await refetch();
    if (!result.data || result.error) return;
    draftRevision.current = result.data.revision;
    setImmediateGoal(result.data.goals.immediateGoal);
    setCareerGoal3yr(result.data.goals.careerGoal3yr);
    setCareerGoal5yr(result.data.goals.careerGoal5yr);
    confirmGoals.reset();
  };

  const isValid = immediateGoal.trim() && careerGoal3yr.trim() && careerGoal5yr.trim();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;
    
    confirmGoals.mutate({
      revision: draftRevision.current,
      immediateGoal,
      careerGoal3yr,
      careerGoal5yr
    }, {
      onSuccess: () => {
        if (onComplete) onComplete();
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Confirm Your Goals</CardTitle>
        <CardDescription>Based on your profile, we've drafted some goals. Edit them to reflect where you want to be.</CardDescription>
      </CardHeader>
      <CardContent>
        {confirmGoals.error && (
          <div className="mb-6 p-3 rounded bg-destructive/10 text-destructive text-sm flex items-center justify-between border border-destructive/20">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {confirmGoals.error.message}
            </div>
            {confirmGoals.error.message.includes("newer version") && (
              <Button size="sm" variant="outline" onClick={reloadLatest}>
                <RefreshCw className="w-3 h-3 mr-1" /> Discard edits &amp; reload latest
              </Button>
            )}
          </div>
        )}
        <form id="goals-form" onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-3">
            <Label htmlFor="immediate-goal" className="text-base font-semibold">Immediate Goal <span className="text-destructive">*</span></Label>
            <Textarea id="immediate-goal" value={immediateGoal} onChange={e => setImmediateGoal(e.target.value)} maxLength={2000} rows={3} placeholder="What are you trying to achieve right now? (e.g. Find a software engineering role)" />
          </div>
          <div className="space-y-3">
            <Label htmlFor="3yr-goal" className="text-base font-semibold">3-Year Career Goal <span className="text-destructive">*</span></Label>
            <Textarea id="3yr-goal" value={careerGoal3yr} onChange={e => setCareerGoal3yr(e.target.value)} maxLength={2000} rows={3} placeholder="Where do you see yourself in 3 years? (e.g. Lead a project team)" />
          </div>
          <div className="space-y-3">
            <Label htmlFor="5yr-goal" className="text-base font-semibold">5-Year Career Goal <span className="text-destructive">*</span></Label>
            <Textarea id="5yr-goal" value={careerGoal5yr} onChange={e => setCareerGoal5yr(e.target.value)} maxLength={2000} rows={3} placeholder="Where do you see yourself in 5 years? (e.g. Become a technical architect or engineering manager)" />
          </div>
        </form>
      </CardContent>
      <CardFooter className="bg-muted/20 border-t flex justify-end">
        <Button 
          type="submit" 
          form="goals-form" 
          disabled={!isValid || confirmGoals.isPending}
          className="min-w-32"
        >
          {confirmGoals.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Confirm Goals"}
        </Button>
      </CardFooter>
    </Card>
  );
}