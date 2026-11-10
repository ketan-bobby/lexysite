import { useEffect, useRef } from "react";

/** Ignore responses after navigation, authority changes, or unmount (including A → B → A). */
export function useZohoRequestScope(key: string) {
  const current = useRef({ key });
  if (current.current.key !== key) current.current = { key };
  const ticket = current.current;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return () => mounted.current && current.current === ticket;
}
