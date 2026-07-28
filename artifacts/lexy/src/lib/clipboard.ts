/*
 * copyToClipboard — copy text to the clipboard with a resilient fallback.
 *
 * The async Clipboard API (`navigator.clipboard`) is unavailable in several
 * common contexts: non-secure origins and cross-origin iframes that lack the
 * `clipboard-write` permission — which includes the Replit preview iframe. In
 * those cases `navigator.clipboard` is `undefined`, so a bare
 * `navigator.clipboard.writeText(...)` throws synchronously and any attached
 * `.then/.catch` never runs, making "copy" buttons silently do nothing.
 *
 * This helper tries the modern API first and falls back to a hidden-textarea +
 * `document.execCommand('copy')`. Resolves `true` on success, `false` otherwise.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path below */
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
