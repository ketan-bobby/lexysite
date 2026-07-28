import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.cache/**",
      "**/.local/**",
      "**/coverage/**",
      "**/*.min.js",
      "lib/db/drizzle/**",
      "attached_assets/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // ── Correctness we keep as errors (real bugs) ──
      // (react-hooks/rules-of-hooks is scoped to TS/TSX below.)

      // ── Lenient-by-design: noisy or stylistic rules downgraded to warn ──
      "no-empty": "warn",
      "prefer-const": "warn",
      "no-constant-condition": ["warn", { checkLoops: false }],
      "no-useless-escape": "warn",
      "no-useless-assignment": "warn",
      "no-unsafe-finally": "warn",
      "no-irregular-whitespace": "warn",
      "preserve-caught-error": "warn",

      // ── Off: patterns that are intentional / handled by TypeScript ──
      "no-undef": "off", // TypeScript resolves identifiers; avoids false positives
      "no-control-regex": "off", // intentional control-char sanitization regexes
      "no-case-declarations": "off",

      // ── typescript-eslint leniency (plugin applies to all files via recommended) ──
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-require-imports": "off", // CommonJS .cjs build scripts
      "@typescript-eslint/no-namespace": "off", // needed for Express Request augmentation
      "@typescript-eslint/no-unused-expressions": "warn",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
