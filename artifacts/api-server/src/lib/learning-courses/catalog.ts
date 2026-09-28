export type {
  CourseDefinition,
  ExerciseDefinition,
  LessonDefinition,
} from "./types";

import { SUPPORT_COMMUNICATION_FOUNDATIONS } from "./course-foundations";
import { SUPPORT_COMMUNICATION_PRACTICE } from "./course-practice";
import type { CourseDefinition } from "./types";

export const LEARNING_COURSES: CourseDefinition[] = [
  SUPPORT_COMMUNICATION_FOUNDATIONS,
  SUPPORT_COMMUNICATION_PRACTICE,
];

export function getLearningCourse(id: string): CourseDefinition | undefined {
  return LEARNING_COURSES.find((course) => course.id === id);
}