import { apiBase, apiFetch } from "@/lib/api";

export async function zoomMeetingRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(`${apiBase}${path}`, {
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? "The Zoom operation was not confirmed. Reload its status.");
  }
  return response.json() as Promise<T>;
}
