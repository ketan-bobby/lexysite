import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiBase } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import {
  LearningCourseCatalog,
  LearningCourseDetail,
  LearningCourseEnrollmentInput,
  LearningLessonInput,
  LearningCoursePath,
  LearningCourseEnrollmentStatus,
  LearningCourseEnrollment,
  LearningCourseSummary,
  LearningCourseSection,
  LearningCourseExample,
  LearningCourseExerciseType,
  LearningCourseExercise,
  LearningLessonProgressStatus,
  LearningExerciseFeedback,
  LearningLessonProgress,
  LearningCourseLessonTrack,
  LearningCourseLesson,
  LearningLessonInputAction
} from "@workspace/api-client-react";

export type {
  LearningCourseCatalog,
  LearningCourseDetail,
  LearningCourseEnrollmentInput,
  LearningLessonInput,
  LearningCoursePath,
  LearningCourseEnrollmentStatus,
  LearningCourseEnrollment,
  LearningCourseSummary,
  LearningCourseSection,
  LearningCourseExample,
  LearningCourseExerciseType,
  LearningCourseExercise,
  LearningLessonProgressStatus,
  LearningExerciseFeedback,
  LearningLessonProgress,
  LearningCourseLessonTrack,
  LearningCourseLesson,
  LearningLessonInputAction
};

export const getGetLearningCoursesQueryKey = (userId: string) => ["learning-courses", userId];
export const getGetLearningCourseDetailQueryKey = (userId: string, courseId: string) => ["learning-course", userId, courseId];

export function useGetLearningCourses() {
  const { user } = useAuth();
  const userId = user?.id || "guest";
  const isCandidate = user?.role === "candidate";

  return useQuery<LearningCourseCatalog, Error>({
    queryKey: getGetLearningCoursesQueryKey(userId),
    enabled: isCandidate,
    staleTime: 60 * 1000 * 5, // 5 minutes
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
    queryFn: async () => {
      const res = await apiFetch(`${apiBase}/portal/learning-growth/courses`);
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || errorData.message || "Failed to load learning courses");
      }
      return res.json();
    }
  });
}

export function useGetLearningCourse(courseId: string) {
  const { user } = useAuth();
  const userId = user?.id || "guest";
  const isCandidate = user?.role === "candidate";

  return useQuery<LearningCourseDetail, Error>({
    queryKey: getGetLearningCourseDetailQueryKey(userId, courseId),
    enabled: isCandidate && !!courseId,
    staleTime: 60 * 1000 * 5, // 5 minutes
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
    queryFn: async () => {
      const res = await apiFetch(`${apiBase}/portal/learning-growth/courses/${courseId}`);
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || errorData.message || "Failed to load course details");
      }
      return res.json();
    }
  });
}

export function useEnrollLearningCourse(courseId: string) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id || "guest";

  return useMutation<LearningCourseDetail, Error, LearningCourseEnrollmentInput>({
    mutationFn: async (data) => {
      const res = await apiFetch(`${apiBase}/portal/learning-growth/courses/${courseId}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to enroll in course");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.setQueryData(getGetLearningCourseDetailQueryKey(userId, courseId), data);
      queryClient.invalidateQueries({ queryKey: getGetLearningCoursesQueryKey(userId) });
    }
  });
}

export function useSubmitLearningLesson(courseId: string, lessonId: string) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id || "guest";

  return useMutation<LearningCourseDetail, Error, LearningLessonInput>({
    mutationFn: async (data) => {
      const res = await apiFetch(`${apiBase}/portal/learning-growth/courses/${courseId}/lessons/${lessonId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });
      if (!res.ok) {
        if (res.status === 409) throw new Error("A newer version of this lesson exists. Please discard edits to reload.");
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to save lesson");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.setQueryData(getGetLearningCourseDetailQueryKey(userId, courseId), data);
      queryClient.invalidateQueries({ queryKey: getGetLearningCoursesQueryKey(userId) });
    }
  });
}