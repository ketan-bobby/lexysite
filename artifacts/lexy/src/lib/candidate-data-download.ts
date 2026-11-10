export interface CandidateDataFile {
  blob: Blob;
  filename: string;
}

export async function readCandidateDataDownload(response: Response): Promise<CandidateDataFile> {
  if (!response.ok) {
    if (response.status === 401) throw new Error("Your session expired. Please sign in again.");
    if (response.status === 403)
      throw new Error("You do not have permission to download this data.");
    if (response.status === 410)
      throw new Error("Your data has been erased, so there is nothing to download.");
    throw new Error("Could not prepare your data download. Please try again.");
  }
  const invalid = () => new Error("The data download was incomplete or invalid. Please try again.");
  if (!response.headers.get("content-type")?.match(/^application\/json(?:;|$)/i)) throw invalid();
  let data;
  try {
    data = await response.json();
  } catch {
    throw invalid();
  }
  if (
    !data ||
    typeof data !== "object" ||
    data.schemaVersion !== 1 ||
    typeof data.candidateId !== "string" ||
    !data.candidateId ||
    data.candidate?.id !== data.candidateId ||
    typeof data.exportedAt !== "string" ||
    !Array.isArray(data.applications) ||
    !Array.isArray(data.interviewSessions) ||
    !Array.isArray(data.interviewSchedules)
  )
    throw invalid();
  return {
    blob: new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }),
    filename: `lexy-data-export-${data.candidateId.slice(0, 8).replace(/[^a-zA-Z0-9_-]/g, "_")}.json`,
  };
}

interface DownloadEnvironment {
  createUrl(blob: Blob): string;
  revokeUrl(url: string): void;
  createLink(): HTMLAnchorElement;
  appendLink(link: HTMLAnchorElement): void;
  delayCleanup(cleanup: () => void): void;
}

export function saveCandidateDataDownload(
  file: CandidateDataFile,
  environment: DownloadEnvironment = {
    createUrl: (blob) => URL.createObjectURL(blob),
    revokeUrl: (url) => URL.revokeObjectURL(url),
    createLink: () => document.createElement("a"),
    appendLink: (link) => document.body.append(link),
    delayCleanup: (cleanup) => window.setTimeout(cleanup, 30_000),
  },
): void {
  const url = environment.createUrl(file.blob);
  let link: HTMLAnchorElement | undefined;
  try {
    link = environment.createLink();
    link.href = url;
    link.download = file.filename;
    environment.appendLink(link);
    link.click();
  } finally {
    link?.remove();
    // Do not revoke before the browser has consumed the download.
    environment.delayCleanup(() => environment.revokeUrl(url));
  }
}
