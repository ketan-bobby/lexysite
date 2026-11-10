import { ReplitConnectors } from "@replit/connectors-sdk";

export type RecallReadiness = {
  state: "connected" | "unavailable" | "authorization_required" | "selection_required";
  checkedAt: string;
  attendanceEnabled: false;
  message: string;
};

type Gateway = Pick<ReplitConnectors, "listConnections" | "proxy">;

/**
 * Project connection diagnostics, NOT employer/staff authorization to use Recall.
 * Never return bot records, connection identifiers, region metadata or provider errors.
 * No write methods are exposed here. Checking readiness cannot dispatch a bot.
 */
export async function checkRecallReadiness(
  gateway: Gateway = new ReplitConnectors(),
  timeoutMs = 10_000,
): Promise<RecallReadiness> {
  const result = (state: RecallReadiness["state"], message: string): RecallReadiness => ({
    state,
    checkedAt: new Date().toISOString(),
    attendanceEnabled: false,
    message,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation = async (): Promise<RecallReadiness> => {
      const connections = (await gateway.listConnections({ connector_names: "recall-ai" })).filter(
        (connection) => connection.connector_name === "recall-ai",
      );
      if (connections.length > 1)
        return result(
          "selection_required",
          "More than one Recall workspace is available. Explicit workspace binding is required.",
        );
      if (connections.length !== 1)
        return result(
          "unavailable",
          "The server cannot access a Recall connection. Check the integration configuration.",
        );
      const response = await gateway.proxy("recall-ai", "/api/v1/bot/?page_size=1", {
        connectionId: connections[0]!.id,
        method: "GET",
      });
      // This is an authorization probe, not a meeting listing. Do not read or retain bodies.
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403)
        return result(
          "authorization_required",
          "Recall rejected access. Check that the account, API key and selected region match.",
        );
      if (!response.ok)
        return result(
          "unavailable",
          "Recall did not confirm readiness. Try the check again later.",
        );
      return result(
        "connected",
        "Recall accepted the read-only connection check. No meeting assistant was dispatched.",
      );
    };
    return await Promise.race([
      operation(),
      new Promise<RecallReadiness>((resolve) => {
        timer = setTimeout(
          () => resolve(result("unavailable", "Recall did not respond within the check window.")),
          timeoutMs,
        );
      }),
    ]);
  } catch {
    return result(
      "unavailable",
      "Recall could not be checked. No meeting assistant was dispatched.",
    );
  } finally {
    clearTimeout(timer);
  }
}
