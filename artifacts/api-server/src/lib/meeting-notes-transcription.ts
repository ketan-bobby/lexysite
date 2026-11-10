const BATCH_SIZE = 4;

/**
 * Preserve source order with bounded concurrency. Await the entire active batch
 * even on failure, before the caller can remove its private temporary files.
 * Never return a partial transcript or start another batch after authority loss.
 */
export async function transcribeMeetingParts(
  parts: string[],
  read: (part: string) => Promise<Buffer>,
  transcribe: (bytes: Buffer) => Promise<string>,
  checkCurrent: () => Promise<void>,
): Promise<string> {
  if (!parts.length) throw new Error("No recording audio parts.");
  const captured: string[] = [];
  for (let index = 0; index < parts.length; index += BATCH_SIZE) {
    await checkCurrent();
    const results = await Promise.allSettled(
      parts.slice(index, index + BATCH_SIZE).map(async (part) => {
        await checkCurrent();
        const result = (await transcribe(await read(part))).trim();
        await checkCurrent();
        if (!result) throw new Error("Audio could not be transcribed completely.");
        return result;
      }),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    for (const result of results) {
      if (result.status === "fulfilled") captured.push(result.value);
    }
  }
  await checkCurrent();
  return captured.join("\n\n");
}
