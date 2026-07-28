/**
 * main.tsx — Application entry point.
 *
 * ── What this file does ───────────────────────────────────────────────────────
 * Mounts the React application into the #root DOM element.
 * Wraps the tree in next-themes' ThemeProvider so the app can switch between the
 * dark (default) and light color schemes via the global ThemeToggle. The initial
 * class is applied by a tiny inline script in index.html to avoid a flash of the
 * wrong theme before React hydrates.
 */

import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import App from "./App";
import "./index.css";

/*
 * Silence the benign "ResizeObserver loop completed with undelivered
 * notifications" browser error at its source.
 *
 * Radix popper primitives (Select, DropdownMenu, Popover, etc.) observe their
 * trigger/content with a ResizeObserver when they open. When an observer
 * callback mutates layout in a way that schedules another resize, the browser
 * emits this notification as a window `error` event with a null `error` object
 * and no stack. It is completely harmless — nothing crashes — but the Replit
 * dev runtime-error overlay wraps any null-error event in a synthetic
 * `Error("(unknown runtime error)")` and shows a scary empty overlay.
 *
 * A window `error` listener can't reliably swallow it: the overlay registers
 * its own listener from a <head> script that runs before this entry module, and
 * `error` events fire at AT_TARGET where the capture flag is ignored and
 * listeners run in registration order — so the overlay always wins.
 *
 * The robust fix is to break the synchronous resize loop: defer each observer
 * callback to the next animation frame. This is the well-established cure and
 * prevents the notification from ever being dispatched. Dev-only, since the
 * overlay is dev-only and we don't want to alter production timing.
 */
if (import.meta.env.DEV && typeof window !== "undefined" && window.ResizeObserver) {
  const NativeResizeObserver = window.ResizeObserver;
  window.ResizeObserver = class extends NativeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => {
        window.requestAnimationFrame(() => {
          callback(entries, observer);
        });
      });
    }
  };
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider
    attribute="class"
    defaultTheme="dark"
    enableSystem={false}
    disableTransitionOnChange
  >
    <App />
  </ThemeProvider>,
);
