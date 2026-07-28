import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import fs from "node:fs";

const envRoot = path.resolve(import.meta.dirname, "..", "..");
const envMode = process.env.NODE_ENV === "production" ? "production" : "development";
function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};

  const vars: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

function loadRootEnv(mode: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const name of [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`]) {
    Object.assign(merged, parseEnvFile(path.resolve(envRoot, name)));
  }
  return merged;
}

const processEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === "string") processEnv[key] = value;
}

const env = { ...loadRootEnv(envMode), ...processEnv };
const isProduction = envMode === "production";
const isReplit = !!env.REPL_ID;
const clientEnvDefines = Object.fromEntries(
  Object.entries(env)
    .filter(([key]) => key.startsWith("VITE_"))
    .map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]),
);
const rawPort = env.LEXY_SITE_PORT ?? env.WEB_SITE_PORT ?? "5000";

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}


function normalizeBasePath(raw: string | undefined): string {
  const value = (raw ?? "/").trim();
  if (!value) return "/";

  const asPath = (() => {
    try {
      if (/^https?:\/\//i.test(value)) return new URL(value).pathname || "/";
    } catch {
      // Fall back to raw value when URL parsing fails.
    }
    return value;
  })();

  const withLeading = asPath.startsWith("/") ? asPath : `/${asPath}`;
  const normalized = withLeading.replace(/\/+/g, "/");
  return normalized || "/";
}

const basePath = normalizeBasePath(env.LEXY_SITE_BASE_PATH ?? env.BASE_PATH ?? "/");

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
    proxy: (() => {
      // Proxy key must include the base path so requests like
      // /lexy-site/api-server/... are correctly forwarded by the Vite dev server.
      const apiPrefix = `${basePath.replace(/\/$/, "")}/api-server`;
      const apiProxyConfig = {
        target: `http://localhost:${process.env.API_PORT ?? "8080"}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(new RegExp(`^${apiPrefix}`), ""),
      };
      return {
        [apiPrefix]: apiProxyConfig,
        "/api": {
          target: `http://localhost:${process.env.API_PORT ?? "8080"}`,
          changeOrigin: true,
        },
      };
    })(),
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
