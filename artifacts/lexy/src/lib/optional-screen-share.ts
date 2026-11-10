/** Preserve the click gesture, but never block an interview on an optional picker. */
export function requestOptionalScreenShare(
  request: () => Promise<MediaStream>,
  timeoutMs = 8000,
): Promise<MediaStream | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (stream: MediaStream | null) => {
      if (settled) {
        stream?.getTracks().forEach((track) => track.stop());
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(stream);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      // Synchronous invocation retains the browser's transient user activation.
      request().then(finish, () => finish(null));
    } catch {
      finish(null);
    }
  });
}
