/**
 * One-off backfill: embed profile vectors for existing candidates so the
 * similar-hire signal has a corpus from day one (backlog: "Backfill embeddings
 * for existing candidates so the signal works sooner").
 *
 * Historically, embeddings were only written as a side effect of the screening
 * agent's similar-hire enrichment, so candidates created before that feature
 * (or via import/manual paths) have no vector. This script finds candidates
 * with a missing or stale-model embedding and runs the canonical
 * ensureCandidateEmbedding() for each — same text builder, same hash, same
 * upsert as the live path, so it is fully idempotent and model-aware.
 *
 * Skips candidates whose profile is entirely empty (no title, company, or
 * skills) — an "Unknown/Unknown" vector is noise, and the live path will embed
 * them as soon as their profile is enriched.
 *
 * Run:      pnpm --filter @workspace/api-server exec tsx scripts/backfill-candidate-embeddings.ts
 * Dry run:  ... backfill-candidate-embeddings.ts --dry-run
 * One tenant: ... backfill-candidate-embeddings.ts --tenant <tenantId>
 */
import { dbAdmin, candidatesTable, candidateEmbeddingsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { ensureCandidateEmbedding } from "../src/lib/similar-hire.js";
import { EMBEDDING_MODEL } from "../src/lib/ai.js";

const DRY_RUN = process.argv.includes("--dry-run");
const tenantFlag = process.argv.indexOf("--tenant");
const ONLY_TENANT = tenantFlag >= 0 ? process.argv[tenantFlag + 1] : null;
const CONCURRENCY = 4;

async function main(): Promise<void> {
  /* Candidates with a non-empty profile and no current-model embedding. */
  const conds = [
    sql`(coalesce(trim(${candidatesTable.currentTitle}), '') <> ''
      OR coalesce(trim(${candidatesTable.currentCompany}), '') <> ''
      OR coalesce(jsonb_array_length(to_jsonb(${candidatesTable.skills})), 0) > 0)`,
    sql`(${candidateEmbeddingsTable.candidateId} IS NULL OR ${candidateEmbeddingsTable.model} <> ${EMBEDDING_MODEL})`,
  ];
  if (ONLY_TENANT) conds.push(eq(candidatesTable.tenantId, ONLY_TENANT));

  const rows = await dbAdmin
    .select({ id: candidatesTable.id, tenantId: candidatesTable.tenantId })
    .from(candidatesTable)
    .leftJoin(
      candidateEmbeddingsTable,
      and(
        eq(candidateEmbeddingsTable.tenantId, candidatesTable.tenantId),
        eq(candidateEmbeddingsTable.candidateId, candidatesTable.id),
      ),
    )
    .where(and(...conds));

  console.log(
    `[backfill-embeddings] ${rows.length} candidate(s) need a ${EMBEDDING_MODEL} vector` +
      (ONLY_TENANT ? ` (tenant ${ONLY_TENANT})` : "") +
      (DRY_RUN ? " — DRY RUN, stopping." : ""),
  );
  if (DRY_RUN || rows.length === 0) return;

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((r) => ensureCandidateEmbedding(r.tenantId, r.id)));
    for (const v of results) v ? ok++ : failed++;
    if ((i / CONCURRENCY) % 10 === 0 || i + CONCURRENCY >= rows.length) {
      console.log(
        `[backfill-embeddings] progress ${Math.min(i + CONCURRENCY, rows.length)}/${rows.length} (ok=${ok} failed=${failed})`,
      );
    }
  }
  console.log(`[backfill-embeddings] DONE — embedded=${ok} failed=${failed} of ${rows.length}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[backfill-embeddings] fatal:", err?.message ?? err);
  process.exit(1);
});
