/** Recover before opening HTTP or starting workers. No provider/email imports. */
export async function recoverBeforeListening(options: {
  recover: () => Promise<unknown>;
  listen: () => void;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Startup recovery requires a positive finite timeout");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(options.recover),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Startup recovery timed out")), timeoutMs);
      }),
    ]);
    options.listen();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
