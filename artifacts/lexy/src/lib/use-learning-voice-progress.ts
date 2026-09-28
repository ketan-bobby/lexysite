import { useQueryClient } from "@tanstack/react-query";
import {
  useGetLearningVoiceProgressHome,
  getGetLearningVoiceProgressHomeQueryKey,
  useStartLearningVoiceProgressCycle,
  useGetLearningVoiceProgressCycle,
  getGetLearningVoiceProgressCycleQueryKey,
  useSaveLearningVoiceProgressTurn,
  useStartLearningVoiceProgress,
  useGetLearningVoiceProgressReport,
  getGetLearningVoiceProgressReportQueryKey,
  useStartLearningVoiceTrainingReview,
  useGetLearningVoiceTrainingReview,
  getGetLearningVoiceTrainingReviewQueryKey,
  useReviewLearningVoiceTrainingLesson,
} from "@workspace/api-client-react";
import type { LearningVoiceProgressDetail } from "@workspace/api-client-react";

export {
  getGetLearningVoiceTrainingReviewQueryKey,
  useGetLearningVoiceProgressHome,
  useStartLearningVoiceProgressCycle,
  useGetLearningVoiceProgressCycle,
  useSaveLearningVoiceProgressTurn,
  useStartLearningVoiceProgress,
  useGetLearningVoiceProgressReport,
  useStartLearningVoiceTrainingReview,
  useGetLearningVoiceTrainingReview,
  useReviewLearningVoiceTrainingLesson,
};

export function useVoiceProgressInvalidation() {
  const queryClient = useQueryClient();

  return {
    invalidateHome: () => {
      queryClient.invalidateQueries({ queryKey: getGetLearningVoiceProgressHomeQueryKey() });
    },
    invalidateCycle: (cycleId: string) => {
      queryClient.invalidateQueries({
        queryKey: getGetLearningVoiceProgressCycleQueryKey(cycleId),
      });
      queryClient.invalidateQueries({
        queryKey: getGetLearningVoiceProgressReportQueryKey(cycleId),
      });
    },
    invalidateReview: (cycleId: string) => {
      queryClient.invalidateQueries({
        queryKey: getGetLearningVoiceTrainingReviewQueryKey(cycleId),
      });
    },
    setCycleData: (cycleId: string, data: LearningVoiceProgressDetail) => {
      queryClient.setQueryData(getGetLearningVoiceProgressCycleQueryKey(cycleId), data);
    },
  };
}
