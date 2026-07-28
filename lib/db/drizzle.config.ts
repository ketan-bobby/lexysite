import { defineConfig } from "drizzle-kit";
import fs from "fs";
import path from "path";

const tryLoadEnvFile = (filePath: string): void => {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const contents = fs.readFileSync(filePath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    const normalizedValue =
      value.startsWith('"') && value.endsWith('"')
        ? value.slice(1, -1)
        : value;

    process.env[key] = normalizedValue;
  }
};

tryLoadEnvFile(path.resolve(__dirname, ".env"));
tryLoadEnvFile(path.resolve(__dirname, "../../.env"));

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  // Use a single entrypoint to prevent duplicate object registration
  // when both leaf schema files and src/schema/index.ts are loaded.
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
