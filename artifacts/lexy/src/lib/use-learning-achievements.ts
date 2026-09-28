import { useQueryClient } from "@tanstack/react-query";
import {
  useGetLearningAchievements,
  getGetLearningAchievementsQueryKey,
} from "@workspace/api-client-react";

export { useGetLearningAchievements, getGetLearningAchievementsQueryKey };

export function useLearningAchievementsInvalidation() {
  const queryClient = useQueryClient();
  return {
    invalidateAchievements: () => {
      queryClient.invalidateQueries({ queryKey: getGetLearningAchievementsQueryKey() });
    },
  };
}
