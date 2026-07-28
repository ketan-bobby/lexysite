/**
 * hooks/use-mobile.tsx — Responsive Mobile-Breakpoint Hook
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Exports useIsMobile(), a React hook that returns true when the viewport
 * width is below the MOBILE_BREAKPOINT (768 px). Uses a MediaQueryList
 * listener so the value updates reactively whenever the window is resized.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   components/layout/AppLayout.tsx  — collapses sidebar on mobile
 *   components/ui/sidebar.tsx        — switches between sheet and permanent sidebar
 */
import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}
