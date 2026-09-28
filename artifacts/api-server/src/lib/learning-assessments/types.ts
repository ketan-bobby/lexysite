export type AssessmentDimensionId =
  | "clarity_structure"
  | "empathy_tone"
  | "clarification"
  | "action_accuracy"
  | "channel_execution";

export type AssessmentLevel = "emerging" | "developing" | "consistent" | "not_observed";
export type AssessmentPath = "voice" | "chat_email";

export type AssessmentFact = {
  id: string;
  description: string;
  patterns: string[];
};

export type AssessmentUnsafePromise = {
  description: string;
  patterns: string[];
};

export type AssessmentTaskDefinition = {
  key: string;
  title: string;
  instructions: string;
  responseMode: "spoken_or_typed" | "typed";
  minimumNonSpaceCharacters: number;
  coveredDimensions: AssessmentDimensionId[];
  facts: AssessmentFact[];
  unsafePromises: AssessmentUnsafePromise[];
  recommendationLessonIds: Partial<Record<AssessmentDimensionId, string[]>>;
};

export type AssessmentDefinition = {
  courseId: string;
  path: AssessmentPath;
  title: string;
  introduction: string;
  tasks: AssessmentTaskDefinition[];
};

export type RubricDimension = {
  id: AssessmentDimensionId;
  label: string;
  description: string;
  anchors: Record<Exclude<AssessmentLevel, "not_observed">, string>;
};

export type AssessmentResponses = Record<string, string> | string[];

export type AssessmentDimensionOutcome = {
  dimension: AssessmentDimensionId;
  label: string;
  level: AssessmentLevel;
  evidence: string[];
  observed: number;
  possible: number;
  recommendationLessonIds: string[];
};

export type AssessmentReport = {
  rubricVersion: string;
  taskSetVersion: number;
  courseId: string;
  path: AssessmentPath;
  dimensions: AssessmentDimensionOutcome[];
  overallSummary: string;
  recommendations: string[];
};