import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PlayCircle, Clock, BookOpen, Lock } from "lucide-react";
import { useGetLearningCourses, LearningCourseSummary } from "@/lib/use-learning-courses";

export function CourseCatalog() {
  const { data: catalog, isLoading, isError, refetch } = useGetLearningCourses();

  if (isLoading) {
    return (
      <div className="space-y-4 mt-8">
        <h3 className="font-semibold text-lg border-b pb-2">Support Communication Pilot</h3>
        <div className="grid sm:grid-cols-2 gap-4">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (isError || !catalog) {
    return (
      <div className="space-y-4 mt-8">
        <h3 className="font-semibold text-lg border-b pb-2">Support Communication Pilot</h3>
        <Card className="border-destructive/20">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Failed to load courses</CardTitle>
            <CardDescription>We could not load the learning pilot courses.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 mt-8">
      <div className="flex justify-between items-end border-b pb-4 mb-4">
        <div>
          <h3 className="font-semibold text-lg">Support Communication Pilot</h3>
          <div className="text-sm text-muted-foreground mt-1 space-y-1">
            <p>These optional courses are offered based on your interest in support roles.</p>
            <p><strong>Note:</strong> This is for your private practice only. Completion is not a formal assessment or demonstrated proficiency score, and there is no pass/fail grading.</p>
            <div className="inline-flex items-center gap-2 mt-1">
              <Badge variant="outline" className="text-[10px] bg-primary/5 border-primary/20 text-primary">Lexy-funded</Badge>
              <span>No credits required.</span>
            </div>
          </div>
        </div>
      </div>

      {!catalog.available || !catalog.unlocked ? (
        <Card className="bg-muted/30 border-dashed">
          <CardContent className="py-8 flex flex-col items-center justify-center text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
              <Lock className="w-6 h-6 text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium text-foreground">Course Pilot Locked</p>
              <p className="text-sm text-muted-foreground">{catalog.lockReason || "Courses are currently unavailable for your profile."}</p>
            </div>
            {catalog.available && <Button asChild variant="outline"><Link href="/portal/learning-growth">Review learning requirements</Link></Button>}
          </CardContent>
        </Card>
      ) : catalog.courses.length === 0 ? (
        <p className="text-sm text-muted-foreground">No pilot courses available right now.</p>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          {catalog.courses.map((course) => (
            <CourseCard key={course.id} course={course} unlocked={catalog.unlocked} lockReason={catalog.lockReason} />
          ))}
        </div>
      )}
    </div>
  );
}

function CourseCard({ course, unlocked, lockReason }: { course: LearningCourseSummary, unlocked: boolean, lockReason: string | null }) {
  const isEnrolled = !!course.enrollment;
  const isCompleted = course.enrollment?.status === "completed";
  
  return (
    <Card className="flex flex-col relative overflow-hidden transition-all hover:border-primary/30">
      <CardHeader className="pb-3">
        <div className="flex justify-between items-start gap-2">
          <CardTitle className="text-base font-semibold leading-tight">{course.title}</CardTitle>
          {isCompleted ? (
            <Badge variant="secondary" className="bg-signal-green/10 text-signal-green hover:bg-signal-green/20 shrink-0">Completed</Badge>
          ) : isEnrolled ? (
            <Badge variant="default" className="shrink-0 bg-primary/10 text-primary hover:bg-primary/20">In Progress</Badge>
          ) : null}
        </div>
        <CardDescription className="text-xs line-clamp-2 mt-1">
          {course.description}
        </CardDescription>
      </CardHeader>
      
      <CardContent className="pb-4 flex-1">
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <Clock className="w-3.5 h-3.5" />
            <span>{course.estimatedMinutes} mins</span>
          </div>
          <div className="flex items-center gap-1">
            <BookOpen className="w-3.5 h-3.5" />
            <span>{course.lessonCount} lessons</span>
          </div>
        </div>
        
        {isEnrolled && (
          <div className="mt-4 space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground uppercase tracking-wider">
              <span>{course.enrollment?.completedLessons} of {course.enrollment?.totalLessons} completed</span>
              <span>{course.enrollment?.path === 'voice' ? 'Voice Path' : 'Chat & Email Path'}</span>
            </div>
            <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
              <div 
                className="h-full bg-primary rounded-full transition-all duration-500" 
                style={{ width: `${Math.round(((course.enrollment?.completedLessons || 0) / (course.enrollment?.totalLessons || 1)) * 100)}%` }}
              />
            </div>
          </div>
        )}
      </CardContent>
      
      <CardFooter className="pt-0">
        {!unlocked && !isEnrolled ? (
           <Button variant="outline" className="w-full text-xs" disabled title={lockReason || "Complete baseline to unlock"}>
             <Lock className="w-3.5 h-3.5 mr-2" /> Locked
           </Button>
        ) : isCompleted ? (
           <Button asChild variant="outline" className="w-full">
             <Link href={`/portal/learning-growth/courses/${course.id}`}>Review Course</Link>
           </Button>
        ) : isEnrolled ? (
           <Button asChild className="w-full group">
             <Link href={`/portal/learning-growth/courses/${course.id}`}>
                <PlayCircle className="w-4 h-4 mr-2 group-hover:scale-110 transition-transform" /> 
                {course.enrollment?.resumeLessonId ? "Resume Course" : "Start Course"}
             </Link>
           </Button>
        ) : (
           <Button asChild variant="outline" className="w-full border-primary/30 text-primary hover:bg-primary/5 group">
             <Link href={`/portal/learning-growth/courses/${course.id}`}>
               View Details
             </Link>
           </Button>
        )}
      </CardFooter>
    </Card>
  );
}
