export interface CourseDefinition {
  id: string;
  title: string;
  description: string;
  version: number;
  estimatedMinutes: number;
  lessons: LessonDefinition[];
}

export interface LessonDefinition {
  id: string;
  title: string;
  track: "shared" | "voice" | "chat_email";
  estimatedMinutes: number;
  objectives: string[];
  sections: { heading: string; body: string }[];
  example: { scenario: string; response: string; whyItWorks: string };
  exercises: ExerciseDefinition[];
}

export interface ExerciseDefinition {
  id: string;
  type: "choice" | "reflection";
  prompt: string;
  options?: { id: string; label: string }[];
  correctOptionId?: string;
  feedback: string;
  modelAnswer?: string;
  checklist: string[];
}