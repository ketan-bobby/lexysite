/**
 * Public entry point for the React API client package.
 * Re-exports the orval-generated react-query hooks and schema types, plus the
 * customFetch mutator and its configuration helpers (base URL, auth token).
 */
export * from "./generated/api";
export * from "./generated/api.schemas";
export {
  setBaseUrl,
  setAuthTokenGetter,
  customFetch,
  ApiError,
} from "./custom-fetch";
export type { AuthTokenGetter, CustomFetchOptions } from "./custom-fetch";
