import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiBase } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import {
  LearningAssessmentHome,
  LearningAssessmentStartInput,
  LearningAssessmentSummary,
  LearningAssessmentDetail,
  LearningAssessmentTaskInput,
  LearningAssessmentReport,
  LearningAssessmentTask,
  LearningAssessmentDimension,
} from "@workspace/api-client-react";

export type {
  LearningAssessmentHome,
  LearningAssessmentStartInput,
  LearningAssessmentSummary,
  LearningAssessmentDetail,
  LearningAssessmentTaskInput,
  LearningAssessmentReport,
  LearningAssessmentTask,
  LearningAssessmentDimension,
};

export const getGetLearningAssessmentsQueryKey = (userId: string) => [
  "learning-assessments",
  userId,
];
export const getGetLearningAssessmentDetailQueryKey = (userId: string, assessmentId: string) => [
  "learning-assessment",
  userId,
  assessmentId,
];
export const getGetLearningAssessmentReportQueryKey = (userId: string, assessmentId: string) => [
  "learning-assessment-report",
  userId,
  assessmentId,
];

export function useGetLearningAssessments() {
  const { user } = useAuth();
  const userId = user?.id || "guest";
  const isCandidate = user?.role === "candidate";

  return useQuery<LearningAssessmentHome, Error>({
    queryKey: getGetLearningAssessmentsQueryKey(userId),
    enabled: isCandidate,
    staleTime: 60 * 1000 * 5, // 5 minutes
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
    queryFn: async () => {
      const res = await apiFetch(`${apiBase}/portal/learning-growth/assessments`);
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(
          errorData.error || errorData.message || "Failed to load learning assessments",
        );
      }
      return res.json();
    },
  });
}

export function useStartLearningAssessment() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id || "guest";

  return useMutation<LearningAssessmentDetail, Error, LearningAssessmentStartInput>({
    mutationFn: async (data) => {
      const res = await apiFetch(`${apiBase}/portal/learning-growth/assessments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to start learning assessment");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.setQueryData(
        getGetLearningAssessmentDetailQueryKey(userId, data.summary.id),
        data,
      );
      queryClient.invalidateQueries({ queryKey: getGetLearningAssessmentsQueryKey(userId) });
    },
  });
}

export function useGetLearningAssessmentDetail(assessmentId: string) {
  const { user } = useAuth();
  const userId = user?.id || "guest";
  const isCandidate = user?.role === "candidate";

  return useQuery<LearningAssessmentDetail, Error>({
    queryKey: getGetLearningAssessmentDetailQueryKey(userId, assessmentId),
    enabled: isCandidate && !!assessmentId,
    staleTime: 60 * 1000 * 5,
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
    queryFn: async () => {
      const res = await apiFetch(`${apiBase}/portal/learning-growth/assessments/${assessmentId}`);
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(
          errorData.error || errorData.message || "Failed to load assessment details",
        );
      }
      return res.json();
    },
  });
}

export function useSubmitLearningAssessmentTask(assessmentId: string, taskKey: string) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id || "guest";

  return useMutation<LearningAssessmentDetail, Error, LearningAssessmentTaskInput>({
    mutationFn: async (data) => {
      const res = await apiFetch(
        `${apiBase}/portal/learning-growth/assessments/${assessmentId}/tasks/${taskKey}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
      );
      if (!res.ok) {
        if (res.status === 409)
          throw new Error("A newer version of this draft exists. Please discard edits to reload.");
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to save task");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.setQueryData(getGetLearningAssessmentDetailQueryKey(userId, assessmentId), data);
      queryClient.invalidateQueries({ queryKey: getGetLearningAssessmentsQueryKey(userId) });
    },
  });
}

export function useGetLearningAssessmentReport(assessmentId: string) {
  const { user } = useAuth();
  const userId = user?.id || "guest";
  const isCandidate = user?.role === "candidate";

  return useQuery<LearningAssessmentReport, Error>({
    queryKey: getGetLearningAssessmentReportQueryKey(userId, assessmentId),
    enabled: isCandidate && !!assessmentId,
    staleTime: 60 * 1000 * 5,
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
    queryFn: async () => {
      const res = await apiFetch(
        `${apiBase}/portal/learning-growth/assessments/${assessmentId}/report`,
      );
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || errorData.message || "Failed to load assessment report");
      }
      return res.json();
    },
  });
}
