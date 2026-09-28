import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiBase } from "@/lib/api";
import {
  LearningGrowthResponse,
  LearningGrowthInterestsInput,
  LearningGrowthGoalsInput
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";

export const getGetLearningGrowthQueryKey = (userId: string) => ["learning-growth", userId];

export function useGetLearningGrowth() {
  const { user } = useAuth();
  const userId = user?.id || "guest";
  const isCandidate = user?.role === "candidate";

  return useQuery<LearningGrowthResponse, Error>({
    queryKey: getGetLearningGrowthQueryKey(userId),
    enabled: isCandidate,
    staleTime: 60 * 1000 * 5, // 5 minutes
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
    queryFn: async () => {
      const res = await apiFetch(`${apiBase}/portal/learning-growth`);
      if (!res.ok) {
        throw new Error("Failed to load learning growth plan");
      }
      return res.json();
    }
  });
}

export function useSaveLearningGrowthInterests() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id || "guest";

  return useMutation<LearningGrowthResponse, Error, LearningGrowthInterestsInput>({
    mutationFn: async (data) => {
      const res = await apiFetch(`${apiBase}/portal/learning-growth/interests`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });
      if (!res.ok) {
        if (res.status === 409) throw new Error("A newer version of your profile exists. Please refresh and try again.");
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to save interests");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.setQueryData(getGetLearningGrowthQueryKey(userId), data);
    }
  });
}

export function useConfirmLearningGrowthGoals() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id || "guest";

  return useMutation<LearningGrowthResponse, Error, LearningGrowthGoalsInput>({
    mutationFn: async (data) => {
      const res = await apiFetch(`${apiBase}/portal/learning-growth/goals`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });
      if (!res.ok) {
        if (res.status === 409) throw new Error("A newer version of your profile exists. Please refresh and try again.");
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to confirm goals");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.setQueryData(getGetLearningGrowthQueryKey(userId), data);
      
      // Invalidate relevant career profile keys
      queryClient.invalidateQueries({ queryKey: ["career-profile"] });
      queryClient.invalidateQueries({ queryKey: ["portal", "career-profile"] });
    }
  });
}
