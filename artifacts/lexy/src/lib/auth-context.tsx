/**
 * auth-context.tsx — session authentication context for the recruiter app.
 *
 * ── What this file does ───────────────────────────────────────────────────────
 * Provides a React context that tracks the logged-in session:
 *   user           User object — server-truth from /api/auth/me, with a
 *                  localStorage "user" cache for instant paint on reload
 *   isLoading      True while the initial /me fetch is in flight
 *   isAuthenticated  True when a user is present
 *   login(user)    Caches the user and updates context (the server has already
 *                  set the httpOnly session cookie by the time this is called)
 *   logout()       Clears the cache, asks the server to clear the cookie,
 *                  then navigates to /login
 *
 * Auth rides on the httpOnly `session_token` cookie set by the server at
 * login — the client never sees or stores the session token in production.
 * DEV ONLY: the Replit preview iframe blocks third-party cookies, so login
 * responses include a `token` field there and login() mirrors it into
 * localStorage for the shared Bearer fallback (authHeaders() in @/lib/api).
 * Production builds neither receive nor store a token.
 *
 * ── Exports ───────────────────────────────────────────────────────────────────
 *  AuthProvider    Context provider — wrap the app root with this
 *  useAuth()       Hook — returns the AuthContextType object
 *
 * ── Used by ───────────────────────────────────────────────────────────────────
 *  App.tsx                         Wraps the entire router
 *  All protected pages/components  Via `const { user } = useAuth()`
 */

import React, { createContext, useContext, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { User } from "@workspace/api-client-react";
import { authHeaders, endSession } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (user: User, devToken?: string) => void;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [localUser, setLocalUser] = useState<User | null>(() => {
    try {
      const saved = localStorage.getItem("user");
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  // Keep this tab's session in sync with every OTHER same-origin tab. When the
  // user logs in or out in one tab (e.g. the preview panel vs. a popped-out
  // browser tab), the localStorage "user" write fires a `storage` event in all
  // other tabs — mirror it here so tabs share one login instead of drifting
  // onto different accounts. Only same-tab login()/logout() writes
  // localStorage directly; storage events never fire in the tab that made the
  // change, so this handles the cross-tab case only.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea && e.storageArea !== localStorage) return;
      // `e.key === null` means localStorage.clear() — re-read then too.
      if (e.key !== null && e.key !== "user") return;
      const saved = localStorage.getItem("user");
      try {
        setLocalUser(saved ? JSON.parse(saved) : null);
      } catch {
        setLocalUser(null);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Server-truth session check. The httpOnly cookie is invisible to JS, so
  // this always runs once on mount: a logged-out visitor gets one clean 401
  // (retry: false — no loop) and stays logged out; a cookie-holder gets the
  // authoritative user object.
  const { data: serverUser, isLoading: isQueryLoading, isFetched } = useQuery<User>({
    queryKey: ["auth/me"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/auth/me`, {
        credentials: "include",
        headers: {
          "Cache-Control": "no-cache",
          // Dev-only Bearer fallback (shared, gated): the httpOnly cookie is
          // blocked in third-party iframe contexts (Replit preview).
          ...authHeaders(),
        },
      });
      if (!res.ok) throw new Error("Unauthorized");
      return res.json();
    },
    retry: false,
    staleTime: 0,
  });

  // Once the server has answered, it is the source of truth — including a 401,
  // which must override a stale cached user (e.g. cookie expired since the
  // last visit). Before it answers, the cache gives an instant paint.
  const user = isFetched ? (serverUser ?? null) : (serverUser || localUser);
  const isAuthenticated = !!user;

  const login = (newUser: User, devToken?: string) => {
    setLocalUser(newUser);
    localStorage.setItem("user", JSON.stringify(newUser));
    // DEV ONLY: mirror the token for the iframe Bearer fallback. Production
    // responses omit `token` entirely and this branch is dead-code-eliminated.
    if (import.meta.env.DEV && devToken) {
      localStorage.setItem("token", devToken);
    }
  };

  const logout = () => {
    setLocalUser(null);
    // Shared session-end flow (also used by apiFetch's global 401
    // interceptor): clears the localStorage "user" cache + dev token,
    // asks the server to clear the httpOnly cookie (the client can't
    // remove an httpOnly cookie itself; failure never blocks), THEN
    // navigates to /login.
    endSession();
  };

  return (
    <AuthContext.Provider value={{ user, isLoading: isQueryLoading, login, logout, isAuthenticated }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
