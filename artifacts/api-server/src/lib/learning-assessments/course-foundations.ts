import type { AssessmentDefinition, AssessmentPath, AssessmentTaskDefinition } from "./types";

const shared = (path: AssessmentPath): AssessmentTaskDefinition[] => [
  {
    key: "order-update",
    title: "Give a clear order update",
    instructions: "A customer says order 4827 was approved today, stock arrives Wednesday, and dispatch follows a quality check. Respond with the status and a careful next step.",
    responseMode: path === "voice" ? "spoken_or_typed" : "typed",
    minimumNonSpaceCharacters: 40,
    coveredDimensions: ["clarity_structure", "action_accuracy"],
    facts: [
      { id: "approval", description: "approval is current", patterns: ["approved", "approval"] },
      { id: "wednesday", description: "stock arrives Wednesday", patterns: ["\\bWednesday\\b", "\\bWed\\b"] },
      { id: "quality", description: "dispatch follows a quality check", patterns: ["quality\\s+check", "check(?:ed|ing)?\\s+(?:the\\s+)?stock"] },
    ],
    unsafePromises: [{ description: "an unconfirmed guaranteed delivery", patterns: ["guarantee(?:d)?\\s+(?:delivery|arrival)", "definitely\\s+arrive"] }],
    recommendationLessonIds: { clarity_structure: ["foundations-plain-accurate-sentences"], action_accuracy: ["foundations-plain-accurate-sentences"] },
  },
  {
    key: "upset-customer",
    title: "Acknowledge and help",
    instructions: "A customer says a £18 delivery fee appeared after checkout despite choosing standard delivery because the page said it was free. Respond empathetically and state what you would check.",
    responseMode: path === "voice" ? "spoken_or_typed" : "typed",
    minimumNonSpaceCharacters: 40,
    coveredDimensions: ["empathy_tone", "clarification", "action_accuracy"],
    facts: [
      { id: "fee", description: "the £18 fee appeared after checkout", patterns: ["£?18", "delivery\\s+fee"] },
      { id: "standard", description: "standard delivery was selected", patterns: ["standard\\s+delivery"] },
      { id: "verify", description: "the offer or order will be checked", patterns: ["check", "verify", "review"] },
    ],
    unsafePromises: [{ description: "an immediate refund without checking", patterns: ["guarantee.*refund", "refund.*guaranteed", "will\\s+refund\\s+immediately"] }],
    recommendationLessonIds: { empathy_tone: ["foundations-empathy-ownership"], clarification: ["foundations-clarify-confirm"], action_accuracy: ["foundations-reading-for-intent-detail"] },
  },
  {
    key: "account-question",
    title: "Ask one useful question",
    instructions: "The app returns a customer to the sign-in screen whenever they open invoices. Ask one focused question that narrows what happens, without diagnosing the cause.",
    responseMode: path === "voice" ? "spoken_or_typed" : "typed",
    minimumNonSpaceCharacters: 25,
    coveredDimensions: ["clarification", "empathy_tone"],
    facts: [
      { id: "scope", description: "the question checks whether this affects any or one invoice", patterns: ["any\\s+invoice", "every\\s+invoice", "one\\s+invoice", "particular\\s+invoice"] },
      { id: "question", description: "a focused question is asked", patterns: ["\\?","\\b(?:which|does|do|is|are|can|could)\\b"] },
    ],
    unsafePromises: [{ description: "a diagnosis stated as certain", patterns: ["(?:the|a)\\s+(?:bug|server\\s+error)\\s+(?:is|caused)", "we\\s+know\\s+the\\s+cause"] }],
    recommendationLessonIds: { clarification: ["foundations-clarify-confirm"], empathy_tone: ["foundations-empathy-ownership"] },
  },
  {
    key: "channel-summary",
    title: "Capture the handoff",
    instructions: "Write or say a concise CRM-style summary: Sam's invoice copy is attached, the billing address was corrected, and the new address appears on the next invoice. Include a courteous customer-facing next step.",
    responseMode: path === "voice" ? "spoken_or_typed" : "typed",
    minimumNonSpaceCharacters: 35,
    coveredDimensions: ["channel_execution", "clarity_structure", "action_accuracy"],
    facts: [
      { id: "attachment", description: "the invoice copy is attached", patterns: ["invoice\\s+copy.*attach", "attach.*invoice\\s+copy"] },
      { id: "correction", description: "the billing address was corrected", patterns: ["correct(?:ed|ion).*billing\\s+address", "billing\\s+address.*correct"] },
      { id: "next", description: "the new address appears on the next invoice", patterns: ["next\\s+invoice"] },
    ],
    unsafePromises: [{ description: "sharing or changing information without confirmation", patterns: ["everything\\s+is\\s+fixed\\s+forever", "no\\s+need\\s+to\\s+check"] }],
    recommendationLessonIds: { channel_execution: [path === "voice" ? "foundations-call-opening-close" : "foundations-readable-chat-email"], clarity_structure: ["foundations-plain-accurate-sentences"], action_accuracy: [path === "voice" ? "foundations-call-opening-close" : "foundations-readable-chat-email"] },
  },
];

export const FOUNDATIONS_ASSESSMENTS: Record<AssessmentPath, AssessmentDefinition> = {
  voice: { courseId: "support-communication-foundations", path: "voice", title: "Foundations developmental reassessment — voice practice", introduction: "A private written record of a spoken-or-typed response. Speak aloud, then use the browser transcript, or type the exact response. No audio is stored.", tasks: shared("voice") },
  chat_email: { courseId: "support-communication-foundations", path: "chat_email", title: "Foundations developmental reassessment — chat and email", introduction: "A private written reassessment using customer chat or email and a CRM-style summary. Respond in writing; no audio or listening claim is involved.", tasks: shared("chat_email") },
};