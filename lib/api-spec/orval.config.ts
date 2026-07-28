/**
 * Orval codegen config for the API spec.
 * Generates two outputs from openapi.yaml: a react-query client (api-client-react,
 * using the customFetch mutator) and Zod validators + TS types (api-zod).
 * Run via `pnpm --filter @workspace/api-spec run codegen`.
 */
import { defineConfig } from "orval";
import path from "path";

const root = path.resolve(__dirname, "..", "..");
const apiClientReactSrc = path.resolve(root, "lib", "api-client-react", "src");
const apiZodSrc = path.resolve(root, "lib", "api-zod", "src");
const openapiPath = path.resolve(__dirname, "openapi.yaml");

// NOTE: openapi.yaml already declares `info.title: Api`, which is what our
// exports assume (generated output is `api.ts`). Older configs ran an inline
// `transformer` function to force-set the title, but orval 8+ requires
// `transformer` to be a path string to a module — passing a function silently
// breaks input resolution. Since the title is already correct in the spec,
// we just drop the transformer entirely.

export default defineConfig({
  "api-client-react": {
    input: openapiPath,
    output: {
      workspace: apiClientReactSrc,
      target: "generated",
      client: "react-query",
      mode: "split",
      baseUrl: "/api",
      clean: true,
      prettier: true,
      override: {
        fetch: {
          includeHttpResponseReturnType: false,
        },
        mutator: {
          path: path.resolve(apiClientReactSrc, "custom-fetch.ts"),
          name: "customFetch",
        },
      },
    },
  },
  zod: {
    input: openapiPath,
    output: {
      workspace: apiZodSrc,
      client: "zod",
      target: "generated",
      schemas: { path: "generated/types", type: "typescript" },
      mode: "split",
      clean: true,
      prettier: true,
      override: {
        zod: {
          coerce: {
            query: ['boolean', 'number', 'string'],
            param: ['boolean', 'number', 'string'],
          },
        },
        useDates: true,
      },
    },
  },
});
