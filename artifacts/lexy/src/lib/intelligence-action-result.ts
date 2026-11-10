export interface IntelligenceActionResult {
  triggered: boolean;
  action: string;
  message: string;
  blocked?: string;
  runId?: string;
  status?: string;
}

// A trigger receipt is not proof that the agent completed or contacted anyone.
// Never retry a failed POST automatically: the server may already have accepted it.
export async function readIntelligenceActionResult(
  response: Response,
): Promise<IntelligenceActionResult> {
  if (!response.ok) {
    if (response.status === 401)
      throw new Error("Your session has expired. Sign in again before executing this action.");
    if (response.status === 403)
      throw new Error("You do not have permission to execute this action.");
    if (response.status === 404)
      throw new Error("This candidate or work order is no longer available. Refresh the queue.");
    throw new Error(
      "The action could not be confirmed. Check Agent Activity before trying again to avoid duplicate work.",
    );
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      "The action returned an unreadable receipt. Check Agent Activity before trying again.",
    );
  }
  if (
    !result ||
    typeof result !== "object" ||
    !("triggered" in result) ||
    typeof result.triggered !== "boolean" ||
    !("action" in result) ||
    typeof result.action !== "string" ||
    !result.action.trim()
  ) {
    throw new Error(
      "The action returned an incomplete receipt. Check Agent Activity before trying again.",
    );
  }
  const data = result as Record<string, unknown>;
  if (data.triggered && (typeof data.runId !== "string" || !data.runId.trim())) {
    throw new Error(
      "No agent run reference was returned. Check Agent Activity before trying again.",
    );
  }
  return {
    triggered: data.triggered as boolean,
    action: data.action as string,
    message: data.triggered
      ? "Agent run accepted. Check Agent Activity for progress; this does not confirm completion or delivery."
      : data.blocked === "approval_required"
        ? "Not executed. Recruiter approval is required by your organisation’s policy."
        : data.blocked === "policy_disabled_automation"
          ? "Not executed. Your organisation’s policy requires this action to be handled manually."
          : typeof data.blocked === "string"
            ? "Not executed. A workflow restriction prevented this action."
            : typeof data.message === "string" && data.message.trim()
              ? data.message
              : "Not executed. The server did not start an agent.",
    blocked: typeof data.blocked === "string" ? data.blocked : undefined,
    runId: typeof data.runId === "string" ? data.runId : undefined,
    status: typeof data.status === "string" ? data.status : undefined,
  };
}
