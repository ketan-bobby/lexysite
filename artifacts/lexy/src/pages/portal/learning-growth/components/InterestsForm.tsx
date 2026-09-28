import { useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircle, Loader2, X, RefreshCw } from "lucide-react";
import { useSaveLearningGrowthInterests, useGetLearningGrowth } from "@/lib/use-learning-growth";
import { LearningGrowthInterestsInput, LearningGrowthInterestArea, LearningGrowthInterestsEducationStage, LearningGrowthPriority, LearningGrowthInterestsStartTiming } from "@workspace/api-client-react";
import type { LearningGrowthResponse } from "@workspace/api-client-react";

const CAREER_AREAS = [
  { value: "software_technology", label: "Software & Technology" },
  { value: "data_analytics", label: "Data & Analytics" },
  { value: "finance_accounting", label: "Finance & Accounting" },
  { value: "sales_marketing", label: "Sales & Marketing" },
  { value: "customer_service", label: "Customer Service" },
  { value: "operations", label: "Operations" },
  { value: "exploring", label: "Still Exploring" },
  { value: "other", label: "Other" }
];

const LEARNING_PRIORITIES = [
  { value: "first_job", label: "Landing my first job" },
  { value: "career_exploration", label: "Exploring career options" },
  { value: "communication", label: "Improving communication skills" },
  { value: "interviews", label: "Interview preparation" },
  { value: "role_skills", label: "Building specific role skills" }
];

export function InterestsForm({ data, onComplete }: { data: LearningGrowthResponse; onComplete?: () => void }) {
  const saveInterests = useSaveLearningGrowthInterests();
  const draftRevision = useRef(data.revision);
  const { refetch } = useGetLearningGrowth();
  
  const [careerAreas, setCareerAreas] = useState<string[]>(data.interests?.careerAreas || []);
  const [otherInterest, setOtherInterest] = useState(data.interests?.otherInterest || "");
  const [immediateRoles, setImmediateRoles] = useState<string[]>(data.interests?.immediateRoles || []);
  const [newRole, setNewRole] = useState("");
  const [educationStage, setEducationStage] = useState(data.interests?.educationStage || "");
  const [discipline, setDiscipline] = useState(data.interests?.discipline || "");
  const [graduationYear, setGraduationYear] = useState(data.interests?.graduationYear?.toString() || "");
  const [learningPriorities, setLearningPriorities] = useState<string[]>(data.interests?.learningPriorities || []);
  const [preferredLanguage, setPreferredLanguage] = useState(data.interests?.preferredLanguage || "");
  const [accessibilityPreferences, setAccessibilityPreferences] = useState(data.interests?.accessibilityPreferences || "");
  const [startTiming, setStartTiming] = useState(data.interests?.startTiming || "");

  const reloadLatest = async () => {
    const result = await refetch();
    if (!result.data || result.error) return;
    const latest = result.data;
    draftRevision.current = latest.revision;
    setCareerAreas(latest.interests?.careerAreas ?? []);
    setOtherInterest(latest.interests?.otherInterest ?? "");
    setImmediateRoles(latest.interests?.immediateRoles ?? []);
    setNewRole("");
    setEducationStage(latest.interests?.educationStage ?? "");
    setDiscipline(latest.interests?.discipline ?? "");
    setGraduationYear(latest.interests?.graduationYear?.toString() ?? "");
    setLearningPriorities(latest.interests?.learningPriorities ?? []);
    setPreferredLanguage(latest.interests?.preferredLanguage ?? "");
    setAccessibilityPreferences(latest.interests?.accessibilityPreferences ?? "");
    setStartTiming(latest.interests?.startTiming ?? "");
    saveInterests.reset();
  };

  const addRole = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && newRole.trim()) {
      e.preventDefault();
      if (immediateRoles.length < 10) {
        setImmediateRoles([...immediateRoles, newRole.trim()]);
        setNewRole("");
      }
    }
  };

  const addRoleButton = () => {
    const role = newRole.trim();
    if (role && immediateRoles.length < 10) { setImmediateRoles([...immediateRoles, role]); setNewRole(""); }
  };
  const removeRole = (idx: number) => { setImmediateRoles(immediateRoles.filter((_, i) => i !== idx)); };

  const toggleArea = (val: string) => {
    if (careerAreas.includes(val)) setCareerAreas(careerAreas.filter(a => a !== val));
    else if (careerAreas.length < 8) setCareerAreas([...careerAreas, val]);
  };

  const togglePriority = (val: string) => {
    if (learningPriorities.includes(val)) setLearningPriorities(learningPriorities.filter(p => p !== val));
    else if (learningPriorities.length < 5) setLearningPriorities([...learningPriorities, val]);
  };

  const isValid = 
    careerAreas.length > 0 && 
    (careerAreas.includes("other") ? !!otherInterest.trim() : true) &&
    educationStage &&
    startTiming &&
    learningPriorities.length > 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;
    const pendingRole = newRole.trim();
    const roles = pendingRole && immediateRoles.length < 10 ? [...immediateRoles, pendingRole] : immediateRoles;
    
    const payload: LearningGrowthInterestsInput = {
      revision: draftRevision.current,
      careerAreas: careerAreas as LearningGrowthInterestArea[],
      otherInterest: careerAreas.includes("other") ? otherInterest : null,
      immediateRoles: roles,
      educationStage: educationStage as LearningGrowthInterestsEducationStage,
      discipline: discipline || null,
      graduationYear: graduationYear ? parseInt(graduationYear, 10) : null,
      learningPriorities: learningPriorities as LearningGrowthPriority[],
      preferredLanguage: preferredLanguage || null,
      accessibilityPreferences: accessibilityPreferences || null,
      startTiming: startTiming as LearningGrowthInterestsStartTiming
    };

    saveInterests.mutate(payload, {
      onSuccess: () => {
        if (onComplete) onComplete();
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your Interests</CardTitle>
        <CardDescription>Tell us about your learning and career interests to shape your pilot experience.</CardDescription>
      </CardHeader>
      <CardContent>
        {saveInterests.error && (
          <div className="mb-6 p-3 rounded bg-destructive/10 text-destructive text-sm flex items-center justify-between border border-destructive/20">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {saveInterests.error.message}
            </div>
            {saveInterests.error.message.includes("newer version") && (
              <Button size="sm" variant="outline" onClick={reloadLatest}>
                <RefreshCw className="w-3 h-3 mr-1" /> Discard edits &amp; reload latest
              </Button>
            )}
          </div>
        )}
        <form id="interests-form" onSubmit={handleSubmit} className="space-y-8">
          
          <div className="space-y-3">
            <Label className="text-base font-semibold">Broad Career Areas (Max 8) <span className="text-destructive">*</span></Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-muted/30 p-4 rounded-lg border border-border/50">
              {CAREER_AREAS.map(area => (
                <div key={area.value} className="flex items-center space-x-2">
                  <Checkbox 
                    id={`area-${area.value}`} 
                    checked={careerAreas.includes(area.value)}
                    onCheckedChange={() => toggleArea(area.value)}
                    disabled={!careerAreas.includes(area.value) && careerAreas.length >= 8}
                  />
                  <Label htmlFor={`area-${area.value}`} className="cursor-pointer font-medium leading-none">{area.label}</Label>
                </div>
              ))}
            </div>
            {careerAreas.includes("other") && (
              <div className="pt-2">
                <Label htmlFor="other-interest">Please specify <span className="text-destructive">*</span></Label>
                <Input id="other-interest" value={otherInterest} onChange={e => setOtherInterest(e.target.value)} maxLength={250} className="mt-1.5" />
              </div>
            )}
          </div>

          <div className="space-y-3">
            <Label htmlFor="immediate-roles" className="text-base font-semibold">Immediate Roles of Interest</Label>
            <p className="text-xs text-muted-foreground">What specific jobs are you applying for right now? Type and press enter. (Max 10)</p>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                {immediateRoles.map((role, idx) => (
                  <Badge key={idx} variant="secondary" className="pl-3 pr-1 py-1 gap-1 text-sm bg-primary/10 text-primary border-primary/20">
                    {role}
                    <button type="button" onClick={() => removeRole(idx)} className="hover:bg-primary/20 rounded-full p-0.5"><X className="w-3 h-3" /></button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2"><Input id="immediate-roles" value={newRole} onChange={e => setNewRole(e.target.value)} onKeyDown={addRole} disabled={immediateRoles.length >= 10} placeholder={immediateRoles.length >= 10 ? "Maximum reached" : "e.g. Customer Support Representative"} maxLength={100} /><Button type="button" variant="outline" onClick={addRoleButton} disabled={!newRole.trim() || immediateRoles.length >= 10}>Add</Button></div>
            </div>
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-3">
              <Label className="text-base font-semibold">Education Stage <span className="text-destructive">*</span></Label>
              <Select value={educationStage} onValueChange={setEducationStage}>
                <SelectTrigger>
                  <SelectValue placeholder="Select stage" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="studying">Currently Studying</SelectItem>
                  <SelectItem value="graduating">Graduating Soon</SelectItem>
                  <SelectItem value="graduated">Recently Graduated</SelectItem>
                  <SelectItem value="working">Currently Working</SelectItem>
                  <SelectItem value="exploring">Exploring Options</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-3">
              <Label className="text-base font-semibold">Start Timing <span className="text-destructive">*</span></Label>
              <Select value={startTiming} onValueChange={setStartTiming}>
                <SelectTrigger>
                  <SelectValue placeholder="When are you looking to start?" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="now">Available Now</SelectItem>
                  <SelectItem value="within_month">Within a Month</SelectItem>
                  <SelectItem value="later">Later / Future</SelectItem>
                  <SelectItem value="exploring">Just Exploring</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-3">
              <Label htmlFor="discipline" className="text-base font-semibold">Degree / Discipline</Label>
              <Input id="discipline" value={discipline} onChange={e => setDiscipline(e.target.value)} maxLength={200} placeholder="e.g. Business Administration" />
            </div>
            <div className="space-y-3">
              <Label htmlFor="grad-year" className="text-base font-semibold">Graduation Year</Label>
              <Input id="grad-year" type="number" min={1950} max={2100} value={graduationYear} onChange={e => setGraduationYear(e.target.value)} placeholder="e.g. 2024" />
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-base font-semibold">Learning Priorities (Max 5) <span className="text-destructive">*</span></Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-muted/30 p-4 rounded-lg border border-border/50">
              {LEARNING_PRIORITIES.map(priority => (
                <div key={priority.value} className="flex items-center space-x-2">
                  <Checkbox 
                    id={`priority-${priority.value}`} 
                    checked={learningPriorities.includes(priority.value)}
                    onCheckedChange={() => togglePriority(priority.value)}
                    disabled={!learningPriorities.includes(priority.value) && learningPriorities.length >= 5}
                  />
                  <Label htmlFor={`priority-${priority.value}`} className="cursor-pointer font-medium leading-none">{priority.label}</Label>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <Label htmlFor="preferred-language" className="text-base font-semibold">Preferred Language</Label>
            <Input id="preferred-language" value={preferredLanguage} onChange={e => setPreferredLanguage(e.target.value)} maxLength={100} placeholder="e.g. English, Spanish" />
          </div>

          <div className="space-y-3">
            <Label htmlFor="accessibility" className="text-base font-semibold">Learning Accommodations</Label>
            <p className="text-xs text-muted-foreground">Any preferences or tools you use for learning? (Not a medical diagnosis)</p>
            <Textarea id="accessibility" value={accessibilityPreferences} onChange={e => setAccessibilityPreferences(e.target.value)} maxLength={500} rows={3} placeholder="e.g. Screen reader compatible, closed captions" />
          </div>

        </form>
      </CardContent>
      <CardFooter className="bg-muted/20 border-t flex justify-end">
        <Button 
          type="submit" 
          form="interests-form" 
          disabled={!isValid || saveInterests.isPending}
          className="min-w-32"
        >
          {saveInterests.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save Interests"}
        </Button>
      </CardFooter>
    </Card>
  );
}
