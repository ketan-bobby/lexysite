import type { CourseDefinition } from "./types";

export const SUPPORT_COMMUNICATION_FOUNDATIONS: CourseDefinition = {
  id: "support-communication-foundations",
  title: "Customer Support Communication Foundations",
  description:
    "Build clear, accurate and empathetic communication for everyday customer-support situations across shared, voice and written channels. Practice completion supports development; it does not verify proficiency or guarantee a hiring outcome.",
  version: 1,
  estimatedMinutes: 145,
  lessons: [
    {
      id: "foundations-plain-accurate-sentences",
      title: "Plain Language and Accurate Sentences",
      track: "shared",
      estimatedMinutes: 15,
      objectives: [
        "Turn vague or complicated support language into short, complete and accurate sentences.",
        "Keep the subject, verb and time reference consistent.",
      ],
      sections: [
        {
          heading: "Lead with the useful fact",
          body: "Put the action or decision first, then add the reason and next step. Prefer familiar words: use “send” instead of “transmit” and “use” instead of “utilise.” One sentence should carry one main idea. Plain language is not abrupt when it includes context and a courteous next step.",
        },
        {
          heading: "Check the sentence frame",
          body: "A dependable frame is subject + verb + detail: “The replacement leaves our warehouse tomorrow.” Match singular subjects with singular verbs, and use past tense for completed events and future forms for promised actions. Before sending, ask: who does what, and when?",
        },
      ],
      example: {
        scenario:
          "A customer asks why an approved replacement has not arrived. It will leave the warehouse tomorrow.",
        response:
          "Your replacement is approved and will leave our warehouse tomorrow. We will email the tracking link once it ships.",
        whyItWorks:
          "It states the status, uses an accurate future time reference and gives a concrete next step without unnecessary jargon.",
      },
      exercises: [
        {
          id: "foundations-plain-accurate-sentences-check",
          type: "choice",
          prompt:
            "Which response is clearest when a refund was approved yesterday and normally reaches the card within five business days?",
          options: [
            { id: "a", label: "Your refund was approved yesterday and should reach your card within five business days." },
            { id: "b", label: "Refunds have been being processed and may eventuate." },
            { id: "c", label: "We approve it yesterday, wait five days." },
          ],
          correctOptionId: "a",
          feedback:
            "Option A uses plain words, correct past tense for the approval and a specific, qualified delivery window. B is vague and complex; C has inaccurate tense and sounds abrupt.",
          checklist: ["Names the completed action", "States the expected timing", "Uses a complete sentence"],
        },
        {
          id: "foundations-plain-accurate-sentences-apply",
          type: "reflection",
          prompt:
            "Rewrite this update for a customer: “Due to a system-side fulfilment exception, dispatching of your item has not been effectuated.” The item will ship Friday.",
          feedback:
            "Compare your wording with the coaching example. More than one clear answer can work; this practice is not an assessment grade.",
          modelAnswer:
            "We could not ship your item because of a system error. It is now scheduled to ship Friday, and we will send you the tracking link then.",
          checklist: ["Uses familiar words", "Explains the current status", "Includes Friday as the next step"],
        },
      ],
    },
    {
      id: "foundations-reading-for-intent-detail",
      title: "Listening Skills from Read Scenarios",
      track: "shared",
      estimatedMinutes: 14,
      objectives: [
        "Identify intent, key details and emotion in a customer statement presented as text.",
        "Separate confirmed facts from assumptions.",
      ],
      sections: [
        {
          heading: "Practice listening without audio",
          body: "This lesson uses written scenarios only; no audio is provided. To simulate one-pass listening, read a scenario once, cover it, and note the customer's goal, the problem, and important details such as dates or amounts. Then uncover it and check accuracy.",
        },
        {
          heading: "Use an intent-detail-emotion grid",
          body: "Intent is what the customer wants now. Details are facts needed to act. Emotion tells you how to acknowledge the experience. Do not turn a possibility into a fact: “I think I was charged twice” requires checking, not an immediate claim that two charges occurred.",
        },
      ],
      example: {
        scenario:
          "Read once: “My parcel was due on the 12th. Tracking has shown ‘at depot’ for three days, and I need it before my trip on Friday.”",
        response:
          "Intent: find the parcel and confirm whether it can arrive before Friday. Details: due on the 12th; at depot for three days; trip Friday. Emotion: concerned and time-pressured.",
        whyItWorks:
          "The notes preserve the exact timeline, identify the real request and avoid claiming the parcel is lost.",
      },
      exercises: [
        {
          id: "foundations-reading-for-intent-detail-check",
          type: "choice",
          prompt:
            "Read once: “I changed my plan on Monday, but the app still shows the old allowance.” What is confirmed?",
          options: [
            { id: "a", label: "The plan change failed permanently." },
            { id: "b", label: "The customer requested a change Monday and currently sees the old allowance." },
            { id: "c", label: "The customer changed plans today." },
          ],
          correctOptionId: "b",
          feedback:
            "Option B preserves only stated facts. The cause and final status are not yet known, and Monday should not be replaced with today.",
          checklist: ["Keeps the stated day", "Does not invent a cause", "Captures the visible problem"],
        },
        {
          id: "foundations-reading-for-intent-detail-apply",
          type: "reflection",
          prompt:
            "Read once, then hide this text and note intent, details and emotion: “The £18 delivery fee appeared after checkout. I chose standard delivery because the page said it was free.”",
          feedback:
            "Unhide the scenario and compare exact facts. The model is a coaching example, not a score.",
          modelAnswer:
            "Intent: understand or correct the £18 fee. Details: fee appeared after checkout; customer chose standard delivery; page appeared to say delivery was free. Emotion: surprised or frustrated. I would verify the offer and order before promising a refund.",
          checklist: ["Captures £18", "Notes when the fee appeared", "Avoids promising an unverified outcome"],
        },
      ],
    },
    {
      id: "foundations-clarify-confirm",
      title: "Clarify and Confirm",
      track: "shared",
      estimatedMinutes: 14,
      objectives: [
        "Ask one focused clarification question at a time.",
        "Confirm names, numbers and requests without assigning blame.",
      ],
      sections: [
        {
          heading: "Clarify the smallest missing fact",
          body: "Explain briefly why you need information, then ask a focused question. “To find the correct order, could you share the order number?” is easier to answer than “Can you give me more details?” Avoid asking again for information the customer already supplied.",
        },
        {
          heading: "Confirm high-risk details",
          body: "Repeat back dates, amounts, spellings and the requested outcome before acting. Group long details into chunks and label what they mean. Use neutral language when records conflict: “I can see a different postcode here; let us confirm the correct one.”",
        },
      ],
      example: {
        scenario:
          "Two orders appear on the account, and the customer says, “Cancel the blue one.”",
        response:
          "I can help with that. To make sure I cancel the right order, do you mean the blue jacket in order 4831?",
        whyItWorks:
          "It explains the reason for confirming and identifies the item and order before an irreversible action.",
      },
      exercises: [
        {
          id: "foundations-clarify-confirm-check",
          type: "choice",
          prompt:
            "A customer says, “It stopped working after the update.” Which is the best first clarification?",
          options: [
            { id: "a", label: "Why did you break it?" },
            { id: "b", label: "Can you explain everything?" },
            { id: "c", label: "Which feature stopped working after the update?" },
          ],
          correctOptionId: "c",
          feedback:
            "Option C isolates the first missing fact without blame. A assumes customer fault, while B is broad and increases effort.",
          checklist: ["Asks one question", "Targets a missing fact", "Uses neutral language"],
        },
        {
          id: "foundations-clarify-confirm-apply",
          type: "reflection",
          prompt:
            "Write a confirmation before changing delivery from 14 Market Street to 40 Market Street for order 7702.",
          feedback:
            "Check that your confirmation protects against changing the wrong order or address. The example is coaching, not a grade.",
          modelAnswer:
            "Before I update it, please confirm that you want order 7702 changed from 14 Market Street to 40 Market Street. Is that correct?",
          checklist: ["Includes order 7702", "States both addresses", "Requests confirmation before action"],
        },
      ],
    },
    {
      id: "foundations-support-vocabulary",
      title: "Support Vocabulary in Context",
      track: "shared",
      estimatedMinutes: 14,
      objectives: [
        "Use precise terms for billing, orders, accounts and technical issues.",
        "Translate internal terminology into customer-friendly language.",
      ],
      sections: [
        {
          heading: "Choose the term that matches the status",
          body: "A pending card charge is not the same as a completed charge. A refund sends money back after payment; a cancellation stops an order or service. Authentication confirms identity; authorisation confirms permission. Accurate terms prevent false expectations.",
        },
        {
          heading: "Pair terms with plain explanations",
          body: "Customers do not need internal queue names or codes. If a system says “payment authorisation pending,” explain: “Your bank has not yet confirmed the payment.” Preserve important distinctions while removing internal shorthand.",
        },
      ],
      example: {
        scenario:
          "The order is packed, but the carrier has not collected it. An internal screen says “manifested.”",
        response:
          "Your order is packed and ready for the carrier to collect. Tracking will update after the carrier scans it.",
        whyItWorks:
          "It replaces an internal logistics term with the actual status and a realistic condition for the next update.",
      },
      exercises: [
        {
          id: "foundations-support-vocabulary-check",
          type: "choice",
          prompt:
            "A card transaction is visible but not completed. Which description is most precise?",
          options: [
            { id: "a", label: "The payment is pending." },
            { id: "b", label: "The refund is complete." },
            { id: "c", label: "The order was cancelled." },
          ],
          correctOptionId: "a",
          feedback:
            "Pending describes an initiated but incomplete transaction. Refund and cancellation are different actions and would misstate the status.",
          checklist: ["Distinguishes payment states", "Avoids an unsupported promise", "Uses customer-friendly wording"],
        },
        {
          id: "foundations-support-vocabulary-apply",
          type: "reflection",
          prompt:
            "Explain “failed authentication; reset credential required” to a customer who cannot sign in.",
          feedback:
            "Your answer should preserve the meaning without exposing internal jargon. The model is one coaching example.",
          modelAnswer:
            "We could not confirm your sign-in details. Please reset your password using the link on the sign-in page, then try again.",
          checklist: ["Explains what failed", "Gives a concrete next step", "Avoids internal shorthand"],
        },
      ],
    },
    {
      id: "foundations-summarize-reconstruct",
      title: "Summarize and Reconstruct a Case",
      track: "shared",
      estimatedMinutes: 15,
      objectives: [
        "Reconstruct a customer issue in chronological order.",
        "Summarize the issue, evidence and requested outcome without adding facts.",
      ],
      sections: [
        {
          heading: "Build a reliable timeline",
          body: "Mark each event with who acted, what happened and when. Sequence words—first, then, after that, currently—make cause and order visible. If timing is unknown, say so rather than guessing.",
        },
        {
          heading: "Compress without losing the decision facts",
          body: "A useful case summary contains the original goal, key events, current status and desired outcome. Remove greetings, repetition and unrelated detail. Attribute uncertain claims: write “customer reports the seal was broken,” not “the warehouse broke the seal.”",
        },
      ],
      example: {
        scenario:
          "A customer ordered headphones Tuesday, received a damaged box Thursday, contacted chat Friday and has not received the promised return label.",
        response:
          "Customer ordered headphones Tuesday and reports they arrived Thursday in a damaged box. They contacted support Friday and are still waiting for the return label. Requested outcome: send the label.",
        whyItWorks:
          "It preserves sequence and attribution, states the current gap and ends with the requested action.",
      },
      exercises: [
        {
          id: "foundations-summarize-reconstruct-check",
          type: "choice",
          prompt:
            "Which sentence is safest when the cause of a missed delivery is unknown?",
          options: [
            { id: "a", label: "The driver deliberately skipped the address." },
            { id: "b", label: "Tracking shows a missed delivery; the reason is not yet confirmed." },
            { id: "c", label: "The customer gave the wrong address." },
          ],
          correctOptionId: "b",
          feedback:
            "Option B separates the observed status from the unknown cause. A and C assign blame without evidence.",
          checklist: ["States known evidence", "Marks uncertainty", "Avoids blame"],
        },
        {
          id: "foundations-summarize-reconstruct-apply",
          type: "reflection",
          prompt:
            "Summarize: Mina upgraded on 3 May. She was billed the old £25 plan and new £35 plan on 5 May. She wants the duplicate reviewed before the next billing date.",
          feedback:
            "Compare whether your summary preserves dates, amounts and the requested outcome. This is practice, not a proficiency result.",
          modelAnswer:
            "Mina upgraded on 3 May. On 5 May, she was charged £25 for the old plan and £35 for the new plan. She wants the possible duplicate reviewed before her next bill.",
          checklist: ["Includes both dates", "Includes both amounts", "Describes the charge as needing review"],
        },
      ],
    },
    {
      id: "foundations-empathy-ownership",
      title: "Empathy and Service Basics",
      track: "shared",
      estimatedMinutes: 14,
      objectives: [
        "Acknowledge the specific impact of a problem without overpromising.",
        "Show ownership through a clear action and update point.",
      ],
      sections: [
        {
          heading: "Acknowledge before investigating",
          body: "Effective empathy is specific: name the inconvenience or concern you heard. “I understand why another delay is frustrating” is stronger than a generic apology. Do not claim to feel exactly what the customer feels.",
        },
        {
          heading: "Make ownership observable",
          body: "Ownership means stating what you can do, doing it, and explaining when the customer will hear next. Avoid guarantees outside your control. Replace “I promise it will arrive” with “I will contact the carrier today and update you by 4 p.m.”",
        },
      ],
      example: {
        scenario:
          "A parent paid for next-day delivery, but the birthday gift has not arrived.",
        response:
          "I understand why this delay is especially disappointing when the gift is for a birthday. I will check the carrier status now and explain the available options.",
        whyItWorks:
          "It recognizes the specific impact and offers an immediate action without promising an outcome before checking.",
      },
      exercises: [
        {
          id: "foundations-empathy-ownership-check",
          type: "choice",
          prompt:
            "Which response combines empathy with responsible ownership?",
          options: [
            { id: "a", label: "Calm down; deliveries are sometimes late." },
            { id: "b", label: "I guarantee it will arrive in an hour." },
            { id: "c", label: "I can see why the delay is frustrating. I will check the latest scan and then outline your options." },
          ],
          correctOptionId: "c",
          feedback:
            "Option C acknowledges impact and names a controllable next action. A dismisses the customer; B makes an unverified guarantee.",
          checklist: ["Names the impact", "Offers a controllable action", "Avoids a guarantee"],
        },
        {
          id: "foundations-empathy-ownership-apply",
          type: "reflection",
          prompt:
            "Respond to a customer who has contacted support twice about an account lock and must submit an application today.",
          feedback:
            "Look for specific acknowledgement and an immediate, realistic next step. The model is a coaching example only.",
          modelAnswer:
            "I understand how urgent this is when you have already contacted us twice and need to submit today. I will review the lock reason now and, if I cannot remove it, connect you with the account team and explain the expected response time.",
          checklist: ["Acknowledges repeat contact", "Recognizes today's deadline", "States an action without promising success"],
        },
      ],
    },
    {
      id: "foundations-intelligibility-pacing",
      title: "Private Aloud Practice: Intelligibility and Pacing",
      track: "voice",
      estimatedMinutes: 15,
      objectives: [
        "Use thought groups, clear word endings and pauses to make a response easier to follow.",
        "Self-reflect on private aloud practice without recording or speech scoring.",
      ],
      sections: [
        {
          heading: "Speak in thought groups",
          body: "Read aloud privately and pause at meaning boundaries, not after every word: “I checked your order / and the replacement ships tomorrow.” Stress the key contrast or detail. This course does not record, listen to or score your speech.",
        },
        {
          heading: "Use a text-based self-check",
          body: "Say the line once at a comfortable pace. Then type which words felt rushed or unclear and revise the line with slash marks for pauses. Repeat privately only if it is safe and comfortable; otherwise, silently mark stress and pacing in the text.",
        },
      ],
      example: {
        scenario:
          "Privately say: “The first payment failed, but the second payment was accepted.”",
        response:
          "Suggested phrasing: “The FIRST payment failed / but the SECOND payment was accepted.” Text reflection: I will slow down around “second payment” so the contrast is clear.",
        whyItWorks:
          "The pause and contrast stress make the status easier to understand, while reflection remains text based and private.",
      },
      exercises: [
        {
          id: "foundations-intelligibility-pacing-check",
          type: "choice",
          prompt:
            "Where is the most useful thought-group break? “After you reset the password sign in again.”",
          options: [
            { id: "a", label: "After you / reset the / password sign / in again." },
            { id: "b", label: "After you reset the password / sign in again." },
            { id: "c", label: "After / you reset the password sign in / again." },
          ],
          correctOptionId: "b",
          feedback:
            "Option B separates the condition from the next instruction. The other breaks split phrases that belong together.",
          checklist: ["Keeps phrases intact", "Separates sequential actions", "Supports a comfortable pace"],
        },
        {
          id: "foundations-intelligibility-pacing-apply",
          type: "reflection",
          prompt:
            "Privately read “Your current balance is sixty, not sixteen, pounds” or mark it silently. Add pause and emphasis marks, then write one pacing adjustment you would make. No recording is made.",
          feedback:
            "Use the model as a self-coaching example, not an assessment of your speech.",
          modelAnswer:
            "“Your current balance is SIXTY / not SIXTEEN / pounds.” I would slow down on the two numbers, finish each word clearly and pause around the correction.",
          checklist: ["Marks the contrasting numbers", "Adds meaningful pauses", "Names one specific self-adjustment"],
        },
      ],
    },
    {
      id: "foundations-call-opening-close",
      title: "Private Aloud Practice: Call Openings and Closings",
      track: "voice",
      estimatedMinutes: 15,
      objectives: [
        "Structure a concise greeting, purpose check and close.",
        "Practice a spoken response privately and reflect in writing.",
      ],
      sections: [
        {
          heading: "Open with orientation",
          body: "A useful opening includes a greeting, your role or support team, and an invitation to explain the need. After the customer speaks, confirm the purpose. Do not request sensitive information until the approved verification step.",
        },
        {
          heading: "Close with shared understanding",
          body: "Summarize what was done, what happens next, who owns it and when. Ask whether the customer needs clarification, rather than using a rushed “anything else?” Practice aloud privately or rehearse silently; no audio is captured or evaluated.",
        },
      ],
      example: {
        scenario:
          "A delivery address was corrected, and dispatch will confirm the change by email within two hours.",
        response:
          "We have updated the delivery address to 40 Market Street. Dispatch will email confirmation within two hours. Is there anything about that next step you would like me to clarify?",
        whyItWorks:
          "It confirms the completed action, owner, channel and time before inviting a final question.",
      },
      exercises: [
        {
          id: "foundations-call-opening-close-check",
          type: "choice",
          prompt:
            "Which closing gives the clearest expectation after an escalation?",
          options: [
            { id: "a", label: "Someone will probably contact you." },
            { id: "b", label: "The billing team owns the review and will email you by 3 p.m. tomorrow." },
            { id: "c", label: "That's all. Bye." },
          ],
          correctOptionId: "b",
          feedback:
            "Option B names the owner, action, channel and deadline. A is vague; C gives no confirmation or next step.",
          checklist: ["Names the owner", "States a channel", "States a time"],
        },
        {
          id: "foundations-call-opening-close-apply",
          type: "reflection",
          prompt:
            "Privately say or silently rehearse a close for this case: password reset link sent; it expires in 30 minutes; customer should reply to the case email if it fails. Then type your closing. No recording is made.",
          feedback:
            "Check your typed close against the operational details. The example is coaching, not speech scoring.",
          modelAnswer:
            "I have sent the password reset link, and it will expire in 30 minutes. Please try it before then. If it does not work, reply to the case email so we can continue helping without starting again.",
          checklist: ["Confirms the sent link", "Includes the 30-minute limit", "Explains what to do if it fails"],
        },
      ],
    },
    {
      id: "foundations-read-hide-write",
      title: "Read–Hide–Write for Accurate Notes",
      track: "chat_email",
      estimatedMinutes: 14,
      objectives: [
        "Use a read–hide–write routine to capture names, numbers and short case details.",
        "Check written notes against source text without claiming audio dictation.",
      ],
      sections: [
        {
          heading: "A text alternative to dictation",
          body: "There is no dictated audio in this lesson. Read the provided line once, hide it, and write the details from memory. Reveal the source and check character by character. This builds attention and note accuracy without pretending to test listening.",
        },
        {
          heading: "Protect exact data",
          body: "Chunk reference numbers, preserve leading zeros and label each field. For names, copy the supplied spelling rather than substituting a familiar one. For addresses, separate unit, street, city and postcode. Never include full payment credentials in ordinary case notes.",
        },
      ],
      example: {
        scenario:
          "Read, hide, write: “Asha Menon, order QF-0427, delivery to Flat 6, 18 Cedar Road, Leeds LS7 4AB.”",
        response:
          "Customer: Asha Menon | Order: QF-0427 | Address: Flat 6, 18 Cedar Road, Leeds LS7 4AB",
        whyItWorks:
          "Labels and chunking make each exact field easier to compare with the source.",
      },
      exercises: [
        {
          id: "foundations-read-hide-write-check",
          type: "choice",
          prompt:
            "Which note accurately preserves reference 008-14B?",
          options: [
            { id: "a", label: "Reference: 8-14B" },
            { id: "b", label: "Reference: 008-14B" },
            { id: "c", label: "Reference: 008-148" },
          ],
          correctOptionId: "b",
          feedback:
            "Option B preserves both leading zeros and the final letter. Those differences can point to a different case.",
          checklist: ["Keeps leading zeros", "Keeps punctuation", "Distinguishes B from 8"],
        },
        {
          id: "foundations-read-hide-write-apply",
          type: "reflection",
          prompt:
            "Read once, hide, then write: “Nora Iqbal moved appointment CX-0912 from 9:15 a.m. Tuesday to 2:40 p.m. Thursday.” Reveal it and write what you corrected.",
          feedback:
            "Accuracy comes from comparison and correction. This text routine is not audio dictation and is not graded.",
          modelAnswer:
            "Nora Iqbal | Appointment CX-0912 | From: Tuesday, 9:15 a.m. | To: Thursday, 2:40 p.m. Self-check: verify spelling, reference, both days and both times.",
          checklist: ["Preserves the reference", "Labels old and new times", "Records a specific self-correction or confirms an exact match"],
        },
      ],
    },
    {
      id: "foundations-readable-chat-email",
      title: "Readable Chat and Email",
      track: "chat_email",
      estimatedMinutes: 15,
      objectives: [
        "Structure concise chat and email responses for scanning.",
        "Set a courteous, specific next step without sounding abrupt.",
      ],
      sections: [
        {
          heading: "Design for a quick read",
          body: "Start with the answer or acknowledgement. Use short paragraphs and numbered steps when order matters. In chat, send a complete thought rather than many fragments. In email, use a specific subject and keep one purpose per paragraph.",
        },
        {
          heading: "Edit for tone and action",
          body: "Use the customer's name only where natural, avoid all caps, and explain limits directly. End with the action, owner and time. Proofread names, dates, links and negations such as “not,” because small errors can reverse meaning.",
        },
      ],
      example: {
        scenario:
          "Email a customer whose invoice copy is attached and whose billing-address correction will appear on the next invoice.",
        response:
          "Subject: Invoice copy and billing-address update\n\nHello Sam,\n\nI have attached your April invoice. I also corrected the billing address; the new address will appear on your next invoice.\n\nPlease reply if you cannot open the attachment.\n\nKind regards,\nCustomer Support",
        whyItWorks:
          "The subject is specific, the two outcomes are easy to scan and the fallback action is clear.",
      },
      exercises: [
        {
          id: "foundations-readable-chat-email-check",
          type: "choice",
          prompt:
            "Which chat update is easiest to act on?",
          options: [
            { id: "a", label: "Do this: settings account security reset." },
            { id: "b", label: "Open Settings, choose Account, then select Security > Reset password." },
            { id: "c", label: "You should know where the password thing is." },
          ],
          correctOptionId: "b",
          feedback:
            "Option B gives ordered, named navigation steps. A is compressed and ambiguous; C is dismissive and provides no route.",
          checklist: ["Uses ordered steps", "Names controls exactly", "Maintains a respectful tone"],
        },
        {
          id: "foundations-readable-chat-email-apply",
          type: "reflection",
          prompt:
            "Write a short email: case 6148 is assigned to the returns team; they will reply within two business days; the customer should keep the damaged item until instructed.",
          feedback:
            "Compare clarity, tone and all three case facts. The model is a coaching example, not an assessment grade.",
          modelAnswer:
            "Subject: Next steps for case 6148\n\nHello,\n\nYour case is now with our returns team. They will reply within two business days. Please keep the damaged item until the team tells you how to return it.\n\nKind regards,\nCustomer Support",
          checklist: ["Includes case 6148", "States two business days", "Says to keep the item until instructed"],
        },
      ],
    },
  ],
};