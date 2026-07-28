/**
 * @workspace/react-hooks — Shared React hooks used across frontend apps.
 *
 * Currently exports the two shadcn-derived hooks that were previously
 * duplicated in artifacts/lexy and artifacts/lexy-site:
 *   useToast / toast  — headless toast state manager (see use-toast.ts)
 *   useIsMobile       — viewport-below-mobile-breakpoint hook (see use-mobile.tsx)
 *
 * NOTE: artifacts/mockup-sandbox intentionally keeps its own local copies —
 * that app stays self-contained by design.
 */
export { useToast, toast } from "./use-toast";
export { useIsMobile } from "./use-mobile";
