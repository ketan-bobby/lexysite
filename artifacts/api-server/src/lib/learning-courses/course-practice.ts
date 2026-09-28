import type { CourseDefinition } from "./types";

export const SUPPORT_COMMUNICATION_PRACTICE: CourseDefinition = {
  id: "support-communication-practice",
  title: "Customer Support Communication in Practice",
  description:
    "Apply advanced clarity, investigation, empathy and solution skills to detailed customer-support cases across shared, voice and written channels. Completing these practices is distinct from verified proficiency and does not guarantee employment.",
  version: 1,
  estimatedMinutes: 159,
  lessons: [
    {
      id: "practice-advanced-clarity",
      title: "Advanced Clarity for Complex Updates",
      track: "shared",
      estimatedMinutes: 16,
      objectives: [
        "Organize a complex explanation into outcome, reason, condition and next step.",
        "Use qualified language when an outcome depends on another team or event.",
      ],
      sections: [
        {
          heading: "Build complete thought groups",
          body: "Start with the result the customer needs to know. Add only the reason that helps them understand it, then state conditions and actions. Connect ideas explicitly with because, if, unless and therefore. Avoid long chains of clauses that hide the decision.",
        },
        {
          heading: "Be precise about certainty",
          body: "Use “will” for a controlled, scheduled action and “should” or “expected” for a likely outcome outside your control. Name the condition: “If the bank releases the hold today, the balance should update tomorrow.” Precision is more trustworthy than false confidence.",
        },
      ],
      example: {
        scenario:
          "A replacement is approved, but stock arrives Wednesday. Dispatch can ship only after a quality check.",
        response:
          "Your replacement is approved. New stock is due Wednesday, and dispatch will ship it after the quality check. We expect to send tracking by Thursday, but I will update you if the stock arrival changes.",
        whyItWorks:
          "It separates confirmed approval from dependent timing and gives a useful update commitment.",
      },
      exercises: [
        {
          id: "practice-advanced-clarity-check",
          type: "choice",
          prompt:
            "Which wording accurately describes a transfer that depends on identity verification?",
          options: [
            { id: "a", label: "The transfer is guaranteed today." },
            { id: "b", label: "Once verification is complete, we can release the transfer; processing then takes up to one business day." },
            { id: "c", label: "Verification, transfer, processing, etcetera, will happen." },
          ],
          correctOptionId: "b",
          feedback:
            "Option B identifies the condition and timing without guaranteeing when verification will finish. A overpromises; C is vague.",
          checklist: ["States the condition", "Separates stages", "Uses a bounded timeframe"],
        },
        {
          id: "practice-advanced-clarity-apply",
          type: "reflection",
          prompt:
            "Explain this case: cancellation is submitted; warehouse confirmation is pending; if already packed, delivery cannot be stopped and a return will be needed.",
          feedback:
            "Check whether your answer distinguishes completed, pending and conditional facts. The model is coaching, not a grade.",
          modelAnswer:
            "I have submitted the cancellation, and we are waiting for the warehouse to confirm it. If the order has already been packed, we may not be able to stop delivery; in that case, I will explain how to return it.",
          checklist: ["Confirms submission", "Marks warehouse confirmation as pending", "Explains the packed-order condition"],
        },
      ],
    },
    {
      id: "practice-paraphrase-detail",
      title: "Paraphrase and Capture Critical Detail",
      track: "shared",
      estimatedMinutes: 16,
      objectives: [
        "Paraphrase a complex account without changing its meaning.",
        "Capture dates, amounts, identifiers and event sequence in a verification summary.",
      ],
      sections: [
        {
          heading: "Paraphrase meaning, not wording",
          body: "A good paraphrase shortens repetition but keeps the customer's level of certainty, cause-and-effect claims and requested outcome. Begin with “Let me check I have this right,” then invite correction. Do not make an allegation stronger than the customer made it.",
        },
        {
          heading: "Use detail anchors",
          body: "Write critical details under four anchors: when, amount, reference and event. Read written scenarios once, hide them and reconstruct the anchors before checking the source. These are text scenarios; no audio is supplied or implied.",
        },
      ],
      example: {
        scenario:
          "“On 8 June I paid invoice 2041 for $86. The portal timed out, so I tried again. Now I can see two pending entries.”",
        response:
          "Let me check I have this right: you attempted the $86 payment for invoice 2041 twice on 8 June after the portal timed out, and both entries currently appear pending.",
        whyItWorks:
          "It preserves the sequence and pending status without incorrectly calling both entries completed charges.",
      },
      exercises: [
        {
          id: "practice-paraphrase-detail-check",
          type: "choice",
          prompt:
            "Which paraphrase preserves “I may have received the wrong model”?",
          options: [
            { id: "a", label: "We definitely shipped the wrong model." },
            { id: "b", label: "You think the delivered model may differ from the one ordered." },
            { id: "c", label: "You no longer want the product." },
          ],
          correctOptionId: "b",
          feedback:
            "Option B keeps the customer's uncertainty and the product mismatch. A turns it into a proven fact; C changes the request.",
          checklist: ["Preserves uncertainty", "Keeps the core mismatch", "Does not assign blame"],
        },
        {
          id: "practice-paraphrase-detail-apply",
          type: "reflection",
          prompt:
            "Paraphrase: “Booking BK-731 was moved from 18 July to 21 July. I was still charged a £30 change fee even though the agent said the disruption waiver applied.”",
          feedback:
            "Compare identifiers, dates, amount and the reported promise. This is a coaching exercise, not proficiency scoring.",
          modelAnswer:
            "Let me confirm: booking BK-731 moved from 18 to 21 July, and you were charged £30 even though you were told the disruption waiver would cover the change.",
          checklist: ["Includes BK-731", "Preserves both dates and £30", "Attributes what the customer was told"],
        },
      ],
    },
    {
      id: "practice-contextual-vocabulary",
      title: "Contextual Vocabulary and Customer Meaning",
      track: "shared",
      estimatedMinutes: 15,
      objectives: [
        "Interpret informal customer wording from context.",
        "Respond with precise plain language rather than copying ambiguous expressions.",
      ],
      sections: [
        {
          heading: "Translate expressions into support facts",
          body: "Customers may say an app is “playing up,” a charge “came out of nowhere,” or a parcel is “stuck.” Treat these as clues, not diagnoses. Ask what the customer sees and when it began, then use exact terms in your summary.",
        },
        {
          heading: "Distinguish nearby concepts",
          body: "Unavailable differs from discontinued; delayed differs from lost; declined differs from pending. “Roll over” may mean moving credit or renewing a plan, depending on context. Confirm ambiguous phrases before taking action.",
        },
      ],
      example: {
        scenario:
          "A customer says, “The app keeps kicking me out whenever I open invoices.”",
        response:
          "To confirm, does the app return you to the sign-in screen when you open any invoice, or only a particular one?",
        whyItWorks:
          "It translates “kicking me out” into an observable behavior and tests the scope without prematurely diagnosing it.",
      },
      exercises: [
        {
          id: "practice-contextual-vocabulary-check",
          type: "choice",
          prompt:
            "A customer says a parcel is “stuck at customs.” What should the agent conclude?",
          options: [
            { id: "a", label: "Customs has permanently confiscated it." },
            { id: "b", label: "The customer sees no recent movement and the customs status needs checking." },
            { id: "c", label: "The carrier delivered it." },
          ],
          correctOptionId: "b",
          feedback:
            "Option B treats informal “stuck” as a report requiring verification. The other options invent outcomes.",
          checklist: ["Interprets context", "Keeps the status unverified", "Identifies a check"],
        },
        {
          id: "practice-contextual-vocabulary-apply",
          type: "reflection",
          prompt:
            "Respond to: “My data vanished overnight.” The account screen shows 0 GB, but usage and renewal date have not yet been checked.",
          feedback:
            "Use an observable description and one focused question. The model is one coaching approach.",
          modelAnswer:
            "I can see why a zero balance is concerning. To work out whether the allowance was used or failed to renew, could you tell me the renewal date shown in the app?",
          checklist: ["Acknowledges the visible zero balance", "Does not claim data was deleted", "Asks for one diagnostic fact"],
        },
      ],
    },
    {
      id: "practice-probing-questions",
      title: "Probing Questions for Diagnosis",
      track: "shared",
      estimatedMinutes: 16,
      objectives: [
        "Move from an open question to focused diagnostic and confirmation questions.",
        "Avoid leading, duplicate and burdensome questioning.",
      ],
      sections: [
        {
          heading: "Use a question funnel",
          body: "Start open enough to understand the customer's account: “What happens when you select Pay?” Then narrow by time, scope or exact error. Finish with a closed confirmation before action. Explain why sensitive or unexpected information is needed.",
        },
        {
          heading: "Choose questions that change the next step",
          body: "Every question should help select or safely complete an action. Do not ask for details already visible or irrelevant to the decision. Avoid leading questions such as “You must have entered it incorrectly, right?” and ask one question at a time.",
        },
      ],
      example: {
        scenario:
          "A customer reports that checkout fails.",
        response:
          "What happens after you select Place order? [Customer: an address error appears.] Does the error appear for both saved addresses or only the new one?",
        whyItWorks:
          "The first question reveals the symptom; the second tests scope and can distinguish an address issue from a wider checkout issue.",
      },
      exercises: [
        {
          id: "practice-probing-questions-check",
          type: "choice",
          prompt:
            "Which question best distinguishes a device issue from an account issue?",
          options: [
            { id: "a", label: "Have you tried signing in on another device?" },
            { id: "b", label: "Why is your device broken?" },
            { id: "c", label: "Can you send every account document?" },
          ],
          correctOptionId: "a",
          feedback:
            "Option A tests whether the symptom follows the account or stays with one device. B assumes a cause; C requests excessive information.",
          checklist: ["Tests a useful distinction", "Avoids blame", "Requests proportionate information"],
        },
        {
          id: "practice-probing-questions-apply",
          type: "reflection",
          prompt:
            "Write three sequenced questions for a customer who says, “My discount did not work,” when multiple promotions exist.",
          feedback:
            "Each question should narrow the case and affect what you check next. The example is coaching, not a grade.",
          modelAnswer:
            "1. What did you expect the discount to change at checkout? 2. Which promotion or code were you using? 3. Before I review the terms, can you confirm which items were in the basket?",
          checklist: ["Starts with the expected outcome", "Identifies the promotion", "Confirms relevant basket scope"],
        },
      ],
    },
    {
      id: "practice-empathy-deescalation",
      title: "Empathy and De-escalation",
      track: "shared",
      estimatedMinutes: 17,
      objectives: [
        "Respond to frustration with acknowledgement, boundaries and forward movement.",
        "De-escalate without agreeing to unsupported claims or rewards.",
      ],
      sections: [
        {
          heading: "Lower effort and temperature",
          body: "Let the customer finish, identify the concrete impact and summarize the goal. Keep sentences calm and brief. If interrupted, return to the shared goal: “I want to resolve the incorrect charge; first I need to confirm which transaction it is.”",
        },
        {
          heading: "Set respectful boundaries",
          body: "Empathy does not require accepting abusive language or bypassing policy. State the boundary and route forward: “I want to help, and I can continue while we speak respectfully.” If the requested outcome is unavailable, explain what you checked and offer genuine alternatives.",
        },
      ],
      example: {
        scenario:
          "A customer has repeated the issue to three agents and says, “Nobody here listens.”",
        response:
          "You should not have had to explain this three times. I have the case notes open: the £42 charge is still under review, and you need an update today. I will check the review owner now.",
        whyItWorks:
          "It acknowledges repeat effort, proves key details were heard and takes a specific next action.",
      },
      exercises: [
        {
          id: "practice-empathy-deescalation-check",
          type: "choice",
          prompt:
            "Which response sets a productive boundary after personal insults?",
          options: [
            { id: "a", label: "Insult me again and I will delete your account." },
            { id: "b", label: "I want to help resolve the delivery issue, and I can continue if we keep the conversation respectful." },
            { id: "c", label: "You're right about everything." },
          ],
          correctOptionId: "b",
          feedback:
            "Option B states the boundary, preserves the goal and avoids retaliation. A threatens an unrelated action; C agrees indiscriminately.",
          checklist: ["States a respectful boundary", "Returns to the issue", "Avoids threat or false agreement"],
        },
        {
          id: "practice-empathy-deescalation-apply",
          type: "reflection",
          prompt:
            "Reply to a customer angry that a same-day technician cancelled. No same-day slots remain; tomorrow 9–11 a.m. and 2–4 p.m. are available.",
          feedback:
            "A strong response recognizes the disruption, states the limit and offers real choices. The model is coaching only.",
          modelAnswer:
            "I understand why a same-day cancellation is frustrating, especially after you planned around the visit. There are no appointments left today. I can book tomorrow from 9–11 a.m. or 2–4 p.m.; which causes less disruption?",
          checklist: ["Acknowledges the scheduling impact", "States today's limit directly", "Offers both available windows"],
        },
      ],
    },
    {
      id: "practice-solutions-complex-cases",
      title: "Explain Solutions and Manage Complex Cases",
      track: "shared",
      estimatedMinutes: 17,
      objectives: [
        "Explain a multi-step solution with rationale, sequence and checks.",
        "Coordinate a complex case with clear ownership and contingency.",
      ],
      sections: [
        {
          heading: "Make instructions executable",
          body: "Before giving steps, state the intended result and any prerequisite. Number actions in the order they must happen, use exact control names and explain what success looks like. Pause for a check after a risky or branching step.",
        },
        {
          heading: "Map ownership and contingencies",
          body: "Complex cases often cross teams. Tell the customer what you own, what another team owns and how updates will arrive. Include a fallback: “If the status has not changed by noon, reply to this case and we will contact the carrier.” Never send the customer around without context.",
        },
      ],
      example: {
        scenario:
          "A phone must reconnect after a network reset, which removes saved Wi-Fi networks but not photos.",
        response:
          "A network reset can restore the connection. It removes saved Wi-Fi networks, so have your Wi-Fi password ready; it does not delete photos. Open Settings > System > Reset > Reset network settings. After the phone restarts, reconnect to Wi-Fi and check whether mobile service appears.",
        whyItWorks:
          "It gives the purpose, consequence, reassurance, exact sequence and a success check.",
      },
      exercises: [
        {
          id: "practice-solutions-complex-cases-check",
          type: "choice",
          prompt:
            "What should come before a step that signs a customer out on every device?",
          options: [
            { id: "a", label: "A warning about the effect and confirmation that the customer is ready." },
            { id: "b", label: "Nothing; perform it without explanation." },
            { id: "c", label: "A promise that no session will end." },
          ],
          correctOptionId: "a",
          feedback:
            "Option A supports informed action before a disruptive step. B removes choice; C contradicts the known effect.",
          checklist: ["Explains consequence", "Checks readiness", "Avoids contradiction"],
        },
        {
          id: "practice-solutions-complex-cases-apply",
          type: "reflection",
          prompt:
            "Explain this resolution: billing corrects a £12 fee within three business days; you have submitted case BL-440; customer receives email when complete; if none by day four, reply to the case email.",
          feedback:
            "Check action, owner, timing, notification and fallback. The model is a coaching example, not verified performance.",
          modelAnswer:
            "I have submitted case BL-440 to billing to correct the £12 fee. The correction can take up to three business days, and we will email you when it is complete. If you have no email by the fourth business day, reply to the case email so we can follow up.",
          checklist: ["Includes case and amount", "Names billing and three business days", "Gives the day-four fallback"],
        },
      ],
    },
    {
      id: "practice-spoken-retelling",
      title: "Private Aloud Practice: Retelling a Case",
      track: "voice",
      estimatedMinutes: 16,
      objectives: [
        "Retell a case in a concise situation-action-next-step structure.",
        "Use a written self-review to check accuracy after private aloud practice.",
      ],
      sections: [
        {
          heading: "Plan a spoken retelling",
          body: "Read the text case, note three anchors—situation, action, next step—then hide the source and retell it privately in your own words. Do not memorize every sentence. No audio is provided, recorded or scored.",
        },
        {
          heading: "Reflect against the source",
          body: "After speaking privately, type your retelling or a brief self-review. Reopen the case and check names, numbers, sequence, uncertainty and ownership. Completion records practice only; it is not verified speaking proficiency.",
        },
      ],
      example: {
        scenario:
          "Case: Dev reported a £64 duplicate charge Monday. Billing confirmed one is pending and will review it by Wednesday. Dev will receive email.",
        response:
          "Private retelling plan: Situation—Dev sees two £64 entries from Monday. Action—billing confirmed one is pending and is reviewing it. Next step—billing will email Dev by Wednesday. Self-review: I kept the pending status and did not call it a completed duplicate.",
        whyItWorks:
          "The retelling is organized, preserves the critical uncertainty and includes the owner, channel and deadline.",
      },
      exercises: [
        {
          id: "practice-spoken-retelling-check",
          type: "choice",
          prompt:
            "Which detail must remain qualified when retelling “the customer believes the courier left it next door”?",
          options: [
            { id: "a", label: "That delivery next door is the customer's belief, not a confirmed fact." },
            { id: "b", label: "That the courier admitted an error." },
            { id: "c", label: "That a neighbour signed for it." },
          ],
          correctOptionId: "a",
          feedback:
            "Option A preserves attribution. The courier admission and neighbour signature were not supplied.",
          checklist: ["Preserves attribution", "Avoids invented evidence", "Keeps the reported event"],
        },
        {
          id: "practice-spoken-retelling-apply",
          type: "reflection",
          prompt:
            "Privately retell, then type a self-review: “Order 551 arrived 6 August without the charger. A charger was requested 7 August and should dispatch within 48 hours. Tracking will come by email.” No recording is made.",
          feedback:
            "Use the model to coach your own accuracy and organization; it is not speech assessment.",
          modelAnswer:
            "Retelling: Order 551 arrived on 6 August with the charger missing. A replacement charger was requested on 7 August and is expected to dispatch within 48 hours; tracking will arrive by email. Self-review: I included both dates, kept “expected” rather than guaranteed, and named the update channel.",
          checklist: ["Includes order 551 and both dates", "Keeps the dispatch timing qualified", "Mentions email tracking"],
        },
      ],
    },
    {
      id: "practice-spontaneous-call-simulation",
      title: "Private Aloud Practice: Spontaneous Call Response",
      track: "voice",
      estimatedMinutes: 16,
      objectives: [
        "Plan and privately rehearse an unscripted response using acknowledge-clarify-act.",
        "Self-identify one strength and one revision in text without recording or automated scoring.",
      ],
      sections: [
        {
          heading: "Use a flexible response frame",
          body: "Take 20 seconds to note three prompts: acknowledge the impact, clarify the decisive gap, and state the next safe action. Then respond aloud privately for about 30–60 seconds, or silently rehearse if speaking is not suitable. There is no microphone use or recorded assessment.",
        },
        {
          heading: "Revise, do not rate yourself",
          body: "Write one phrase that worked and one phrase you would improve. Check whether you invented a policy, guarantee or customer detail. The goal is deliberate practice, not a proficiency label, badge or hiring prediction.",
        },
      ],
      example: {
        scenario:
          "A customer needs a laptop for an exam tomorrow; repair status says “awaiting part,” with no delivery date.",
        response:
          "I understand why the timing is critical with your exam tomorrow. The repair is waiting for a part, but I do not yet have its arrival date. I will check the part status and whether a temporary device is available. Self-review: I acknowledged the deadline and avoided promising a repair.",
        whyItWorks:
          "It responds naturally with empathy, transparent uncertainty and two relevant checks.",
      },
      exercises: [
        {
          id: "practice-spontaneous-call-simulation-check",
          type: "choice",
          prompt:
            "A spontaneous response should begin with which move when the customer reports serious inconvenience?",
          options: [
            { id: "a", label: "A specific acknowledgement followed by the key clarification or safe action." },
            { id: "b", label: "An invented guarantee to sound confident." },
            { id: "c", label: "A long policy quotation before addressing the impact." },
          ],
          correctOptionId: "a",
          feedback:
            "Option A shows the customer they were heard and moves toward resolution. Guarantees and policy dumps can increase frustration.",
          checklist: ["Acknowledges impact", "Moves toward diagnosis or action", "Avoids unsupported certainty"],
        },
        {
          id: "practice-spontaneous-call-simulation-apply",
          type: "reflection",
          prompt:
            "Privately respond for up to 60 seconds: a traveller's account is locked abroad; identity must be verified; normal review is within two hours. Then type one strength and one revision. No audio is captured.",
          feedback:
            "Compare your structure and factual care with the coaching model. This does not score speaking proficiency.",
          modelAnswer:
            "Response: I understand how disruptive it is to lose account access while travelling. To restore access safely, we first need to complete identity verification. Once submitted, review normally takes up to two hours, and I will explain the verification steps now. Strength: I gave a clear sequence. Revision: I would stress “normally” so the timeframe does not sound guaranteed.",
          checklist: ["Acknowledges travel impact", "Explains verification before review", "Includes a specific strength and revision"],
        },
      ],
    },
    {
      id: "practice-written-chat-crm",
      title: "Written Chat and CRM Handoffs",
      track: "chat_email",
      estimatedMinutes: 15,
      objectives: [
        "Keep live chat concise while maintaining context and empathy.",
        "Write factual CRM notes that enable the next agent to continue without repetition.",
      ],
      sections: [
        {
          heading: "Manage the chat rhythm",
          body: "Acknowledge, explain what you are checking and give a realistic wait update. Ask one question per message when answers affect the next step. Before transfer, tell the customer why, where the case is going and what context will accompany it.",
        },
        {
          heading: "Write neutral CRM notes",
          body: "Record issue, verified facts, actions, result, promised next step and deadline. Attribute disputed statements and exclude judgments such as “difficult customer.” Do not copy unnecessary sensitive data into notes.",
        },
      ],
      example: {
        scenario:
          "Customer reports router offline since 10:20. Restart completed, red light remains. Network team escalation NT-882; update within four hours.",
        response:
          "CRM: Customer reports router offline since 10:20. Guided restart completed; red status light remains. Escalated to Network under NT-882. Customer advised of update by email within four hours.",
        whyItWorks:
          "It records the report, completed troubleshooting, observable result, owner, reference, channel and timeframe without judgment.",
      },
      exercises: [
        {
          id: "practice-written-chat-crm-check",
          type: "choice",
          prompt:
            "Which CRM phrase is neutral and useful?",
          options: [
            { id: "a", label: "Customer was unreasonable and dramatic." },
            { id: "b", label: "Customer reports three failed deliveries and requests collection-point delivery." },
            { id: "c", label: "Bad case. Fix it." },
          ],
          correctOptionId: "b",
          feedback:
            "Option B records the customer's report and requested outcome. A is judgmental; C lacks actionable facts.",
          checklist: ["Uses neutral attribution", "Captures count or sequence", "States requested outcome"],
        },
        {
          id: "practice-written-chat-crm-apply",
          type: "reflection",
          prompt:
            "Write a CRM handoff: Priya reports invoice 771 has wrong tax address; identity verified; no payment issue; sent to billing as BI-903; update by Friday email.",
          feedback:
            "Check that another agent could continue without making Priya repeat herself. The model is coaching, not graded.",
          modelAnswer:
            "Priya reports an incorrect tax address on invoice 771. Identity verified; customer confirms payment is not disputed. Sent correction request to Billing under BI-903. Advised customer of email update by Friday.",
          checklist: ["Includes invoice and escalation references", "Separates address issue from payment", "Includes Friday email update"],
        },
      ],
    },
    {
      id: "practice-written-case-email",
      title: "Written Case Resolution by Email",
      track: "chat_email",
      estimatedMinutes: 15,
      objectives: [
        "Write an email that resolves multiple customer questions in a clear order.",
        "Explain policy and alternatives with specific evidence and next steps.",
      ],
      sections: [
        {
          heading: "Mirror the customer's questions",
          body: "Open with the outcome, then answer each question in the order asked or under short headings. Explain the relevant rule in plain language and how it applies to this case. Avoid pasting an entire policy when one condition is decisive.",
        },
        {
          heading: "Close the decision loop",
          body: "State what has happened, what remains open and what the customer must do, including dates or documents. If the preferred outcome is unavailable, offer only alternatives that genuinely exist. Proofread attachments, amounts, names and deadlines.",
        },
      ],
      example: {
        scenario:
          "Return requested on day 32; standard window is 30 days. Item is faulty, so a separate fault review remains available with photos.",
        response:
          "Subject: Options for your faulty item\n\nHello Lee,\n\nThe standard change-of-mind window ended after 30 days, so I cannot open that type of return on day 32. Because you reported a fault, we can still review the item under our fault process. Please reply with a photo of the damage and the serial number, and we will respond within two business days.\n\nKind regards,\nCustomer Support",
        whyItWorks:
          "It explains the declined route, distinguishes the valid alternative and gives exact evidence and timing.",
      },
      exercises: [
        {
          id: "practice-written-case-email-check",
          type: "choice",
          prompt:
            "Which is the clearest way to explain a policy limit?",
          options: [
            { id: "a", label: "Computer says no." },
            { id: "b", label: "The price-match applies within seven days; this request was received on day nine, so it is outside that window." },
            { id: "c", label: "Please read all 18 pages of our terms." },
          ],
          correctOptionId: "b",
          feedback:
            "Option B states the decisive rule and applies it to the case. A is dismissive; C shifts unnecessary work to the customer.",
          checklist: ["Names the relevant rule", "Applies the case fact", "Uses respectful direct language"],
        },
        {
          id: "practice-written-case-email-apply",
          type: "reflection",
          prompt:
            "Email a customer: warranty repair approved for tablet T-440; prepaid label attached; back up data and remove case; repair usually 7–10 business days after receipt; tracking emailed on return.",
          feedback:
            "Check all preparation steps and distinguish usual timing from a guarantee. The model is a coaching example only.",
          modelAnswer:
            "Subject: Approved repair for tablet T-440\n\nHello,\n\nYour warranty repair is approved, and the prepaid shipping label is attached. Before sending tablet T-440, please back up your data and remove its protective case.\n\nRepairs usually take 7–10 business days after we receive the tablet. We will email tracking when it is on its way back.\n\nKind regards,\nCustomer Support",
          checklist: ["Confirms approval and attachment", "Includes both preparation steps", "States qualified timing and return tracking"],
        },
      ],
    },
  ],
};