import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Lock, Loader2, RefreshCw } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useGetLearningGrowth } from "@/lib/use-learning-growth";
import { InterestsForm } from "./learning-growth/components/InterestsForm";
import { GoalsForm } from "./learning-growth/components/GoalsForm";
import { PlanView } from "./learning-growth/components/PlanView";
import type { LearningGrowthResponse } from "@workspace/api-client-react";

type Editor = { kind: "interests" | "goals"; seed: LearningGrowthResponse; optional: boolean };

export default function PortalLearningGrowth() {
  const query = useGetLearningGrowth();
  const data = query.data;
  const [editor, setEditor] = useState<Editor | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => { document.title = "Learning & Growth | Lexy"; }, []);
  // Pin a draft's starting values AND revision. Background refreshes may update
  // server state, but must not unmount a form when another tab advances the stage.
  useEffect(() => {
    if (!editor && data?.available && (data.stage === "interests" || data.stage === "goals")) {
      setEditor({ kind: data.stage, seed: data, optional: false });
    }
  }, [data, editor]);
  useEffect(() => { heading.current?.focus(); }, [data?.stage]);

  if (query.isLoading) return <AppLayout><div role="status" className="flex justify-center py-24"><Loader2 className="h-8 w-8 animate-spin text-primary" /><span className="sr-only">Loading your learning plan</span></div></AppLayout>;
  if (!data && query.error) return <AppLayout><StateCard title="Unable to load Learning & Growth" message={query.error.message} action={<Button variant="outline" onClick={() => query.refetch()}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>} /></AppLayout>;
  if (!data || !data.available || data.stage === "unavailable") return <AppLayout><StateCard title="Learning & Growth is not available yet" message="This private pilot is not currently available for your account." action={<Button asChild variant="outline"><Link href="/portal/career">Return to Career Engine</Link></Button>} /></AppLayout>;

  const openEditor = (kind: Editor["kind"]) => setEditor({ kind, seed: data, optional: true });
  const activeEditor = editor ?? ((data.stage === "interests" || data.stage === "goals")
    ? { kind: data.stage, seed: data, optional: false } : null);
  return <AppLayout><div className="mx-auto max-w-4xl space-y-8">
    <header>
      <p className="mb-2 text-sm font-semibold uppercase tracking-[0.18em] text-primary">Private pilot</p>
      <h1 ref={heading} tabIndex={-1} className="text-3xl font-bold tracking-tight outline-none">Learning &amp; Growth</h1>
      <p className="mt-2 flex items-center gap-2 text-muted-foreground"><Lock className="h-4 w-4 shrink-0 text-primary" />Your interests, coaching and plan are private.</p>
      <p className="mt-2 text-sm text-muted-foreground">Employer sharing stays separate through your <Link href="/portal/introduction" className="text-primary underline">approved introduction</Link>.</p>
    </header>
    {query.error && <p role="alert" className="text-sm text-amber-700">Could not refresh the saved profile. Your draft is still here. <button className="underline" onClick={() => query.refetch()}>Retry</button></p>}
    {activeEditor ? <section className="space-y-4">
      {activeEditor.optional && <div className="flex justify-end"><Button variant="ghost" onClick={() => setEditor(null)}>Cancel editing</Button></div>}
      {activeEditor.kind === "interests"
        ? <InterestsForm data={activeEditor.seed} onComplete={() => setEditor(null)} />
        : <GoalsForm data={activeEditor.seed} onComplete={() => setEditor(null)} />}
    </section> : <>
      {data.stage === "baseline" && <BaselineGate onEdit={() => openEditor("interests")} onCheck={() => query.refetch()} checking={query.isFetching} />}
      {data.stage === "ready" && <PlanView data={data} onEdit={openEditor} />}
    </>}
  </div></AppLayout>;
}

function StateCard({ title, message, action }: { title: string; message: string; action: React.ReactNode }) {
  return <div className="mx-auto mt-8 max-w-3xl"><Card className="border-primary/20"><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{message}</CardDescription></CardHeader><CardFooter>{action}</CardFooter></Card></div>;
}

function BaselineGate({ onEdit, onCheck, checking }: { onEdit: () => void; onCheck: () => void; checking: boolean }) {
  return <Card className="border-primary/25">
    <CardHeader><Badge className="w-fit bg-primary/10 text-primary hover:bg-primary/10">Step 2 of 3</Badge><CardTitle className="text-2xl">Complete your private baseline</CardTitle><CardDescription>This baseline interview is mandatory before you can confirm your goals and receive a learning plan.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">Your baseline is private and is not an employer assessment. If you have already completed it, we will reuse it rather than ask you to repeat it.</p>
      <div className="flex flex-wrap gap-2">
        <Button asChild><Link href="/portal/career/interview">Complete baseline interview</Link></Button>
        <Button variant="outline" disabled={checking} onClick={onCheck}><RefreshCw className="mr-2 h-4 w-4" />Check baseline completion</Button>
        <Button variant="ghost" onClick={onEdit}>Edit interests</Button>
      </div>
    </CardContent>
  </Card>;
}