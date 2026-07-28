/**
 * middlewares/validate.ts — Request validation via Zod schemas
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * A small factory that builds an Express middleware which validates one or
 * more of `req.body`, `req.query`, `req.params` against Zod schemas (the
 * ones generated from our OpenAPI spec in `@workspace/api-zod`). On success
 * it REPLACES the raw payload with the parsed result so downstream handlers
 * benefit from coerced + narrowed values (numbers parsed from strings, dates
 * parsed from ISO strings, unknown keys stripped). On failure it returns a
 * uniform 400 with a structured `issues[]` array so clients can localise
 * field-level error messages.
 *
 * ─── Why this layer exists ───────────────────────────────────────────────────
 * Until 2026-05-16 the api-server had no schema validation library at all.
 * Route handlers parsed `req.body as { ... }` and trusted the cast. The
 * generated Zod schemas in `@workspace/api-zod` were sitting unused. This
 * middleware closes that loop: the OpenAPI spec becomes the single source
 * of truth that flows into both the generated TS client (lib/api-client-
 * react) AND runtime enforcement on the server.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   import { validate } from "../middlewares/validate";
 *   import { LoginBody } from "@workspace/api-zod";
 *
 *   router.post("/auth/login",
 *     loginIpLimit,
 *     validate({ body: LoginBody }),
 *     async (req, res) => {
 *       // req.body is now typed as z.infer<typeof LoginBody>
 *       const { email, password } = req.body;
 *       ...
 *     });
 *
 * ─── Rollout strategy ────────────────────────────────────────────────────────
 * Apply route-by-route. The validate() middleware should sit AFTER any
 * rate limiters (so a flood of malformed requests still hits the limiter)
 * but BEFORE any auth/resolveUser middleware (so we reject garbage before
 * we touch the DB).
 *
 * ─── On purpose NOT done here ────────────────────────────────────────────────
 *   - We don't validate `req.headers`. Auth header parsing lives in
 *     resolveUser; the cookie middleware handles cookies.
 *   - We don't validate responses. The generated `*Response` schemas are
 *     available for use in tests, but bolting them into the response path
 *     adds latency to every successful call for protection against a class
 *     of bugs that integration tests already catch.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { ZodTypeAny, ZodIssue } from "zod";
import { logger } from "../lib/logger";

type Schemas = {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
};

type Part = keyof Schemas;

/* The canonical place to read parsed-and-narrowed values is
 * `res.locals.validated.{body,query,params}`. Handlers that care about the
 * coerced/stripped shape MUST read from here, because Express 5 defines
 * `req.query` (and sometimes `req.params`) as a getter — in-place replacement
 * is best-effort, not contractual.
 *
 * For `req.body` the assignment IS reliable across Express 4/5, so existing
 * `req.body` consumers continue to work without changes. That's why we still
 * attempt the assignment below — it's the cheap-and-friendly path for the
 * 90% case (POST/PUT body validation) and only the rare query/params
 * consumers need to switch to `res.locals.validated`. */
export interface ValidatedLocals {
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

function issuesFor(part: Part, issues: ZodIssue[]) {
  return issues.map((i) => ({
    part,
    path: [part, ...i.path.map((p) => String(p))].join("."),
    code: i.code,
    message: i.message,
  }));
}

export function validate(schemas: Schemas): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const allIssues: ReturnType<typeof issuesFor> = [];
    const validated: ValidatedLocals = {};

    for (const part of ["body", "query", "params"] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (!result.success) {
        allIssues.push(...issuesFor(part, result.error.issues));
        continue;
      }

      /* Always write to res.locals — this is the contractual path. */
      validated[part] = result.data;

      /* Best-effort in-place replacement for handler ergonomics. Reliable
       * for `body`; may silently no-op on Express 5 `query`/`params` which
       * can be getter-only. Handlers that care about the coerced shape on
       * those parts MUST read from `res.locals.validated`. */
      try {
        (req as unknown as Record<Part, unknown>)[part] = result.data;
      } catch (err) {
        logger.warn(
          { err: (err as Error)?.message, part },
          "[validate] could not replace req[part] with parsed value; handler must read res.locals.validated",
        );
      }
    }

    if (allIssues.length > 0) {
      res.status(400).json({
        error: "VALIDATION_FAILED",
        message: "Request did not match the expected schema.",
        issues: allIssues,
      });
      return;
    }

    res.locals.validated = validated;
    next();
  };
}
