/** Save authenticated recording bytes, never navigate to a cross-origin stream. */
export async function downloadRecording(
  storageUrl: string,
  interviewId: string,
  headers: HeadersInit,
): Promise<void> {
  const response = await fetch(storageUrl, { headers, credentials: "include" });
  if (!response.ok) throw new Error("Recording download failed. Please try again.");
  const blob = await response.blob();
  if (!blob.size) throw new Error("The recording file is empty.");
  const extension = blob.type.split(";")[0] === "video/mp4" ? "mp4" : "webm";
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = `interview-${interviewId}.${extension}`;
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    // Allow the browser to consume the file before releasing its bytes.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
