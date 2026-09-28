import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Trophy, Star, TrendingUp, History, AlertCircle } from "lucide-react";
import { useGetLearningAchievements } from "@/lib/use-learning-achievements";

export function AchievementsHome() {
  const { data: achievements, isLoading, isError } = useGetLearningAchievements();

  if (isLoading) {
    return (
      <div className="space-y-4 mt-8 pt-8 border-t">
        <h3 className="font-semibold text-lg border-b pb-2 flex items-center gap-2">
          <Trophy className="w-5 h-5 text-amber-500" /> Achievements & Learning Credits
        </h3>
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }

  if (isError || !achievements) {
    return (
      <div className="space-y-4 mt-8 pt-8 border-t">
        <h3 className="font-semibold text-lg border-b pb-2 flex items-center gap-2">
          <Trophy className="w-5 h-5 text-amber-500" /> Achievements & Learning Credits
        </h3>
        <Card className="border-destructive/20 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-base text-destructive flex items-center gap-2">
              <AlertCircle className="w-4 h-4" /> Failed to load achievements
            </CardTitle>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 mt-8 pt-8 border-t">
      <div>
        <h3 className="font-semibold text-lg border-b pb-2 flex items-center gap-2">
          <Trophy className="w-5 h-5 text-amber-500" /> Achievements & Learning Credits
        </h3>
        <p className="text-sm text-muted-foreground mt-2">{achievements.nonMonetaryDisclaimer}</p>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        <Card className="md:col-span-1 border-amber-500/20 bg-gradient-to-br from-amber-500/10 to-transparent">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Star className="w-4 h-4 text-amber-600" /> Total Balance
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold text-amber-600 mb-1">
              {achievements.creditsBalance}
            </div>
            <p className="text-xs text-amber-700/80 font-medium uppercase tracking-wider">
              {achievements.creditLabel}
            </p>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-primary" /> Milestones
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {achievements.milestones.length === 0 ? (
              <p className="text-sm text-muted-foreground">No milestones tracked yet.</p>
            ) : (
              achievements.milestones.map((m) => (
                <div key={m.key} className="space-y-1.5">
                  <div className="flex justify-between text-sm">
                    <span className="font-medium">{m.title}</span>
                    <span className="text-muted-foreground">
                      {m.current} / {m.target}
                    </span>
                  </div>
                  <Progress value={(m.current / m.target) * 100} className="h-2" />
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-3 border-b mb-3">
            <CardTitle className="text-base">Badges Earned</CardTitle>
          </CardHeader>
          <CardContent>
            {achievements.badges.length === 0 ? (
              <p className="text-sm text-muted-foreground">Keep learning to earn badges!</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {achievements.badges.map((b) => (
                  <div
                    key={b.key}
                    className="flex flex-col items-center text-center p-3 rounded-xl bg-muted/30 border"
                  >
                    <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-2">
                      <Trophy className="w-6 h-6 text-primary" />
                    </div>
                    <span className="text-xs font-semibold">{b.title}</span>
                    <span className="text-[10px] text-muted-foreground mt-1 leading-tight">
                      {b.description}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3 border-b mb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <History className="w-4 h-4" /> Recent Activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            {achievements.recentActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent activity.</p>
            ) : (
              <div className="space-y-4">
                {achievements.recentActivity.map((a) => (
                  <div key={a.id} className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium">{a.description}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(a.earnedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <Badge
                      variant="secondary"
                      className="shrink-0 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20"
                    >
                      +{a.creditsDelta} pts
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
