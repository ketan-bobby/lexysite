/**
 * Local platform-operations export; never mounted in employer/candidate APIs.
 * usage-economics-report.ts FROM TO [EVIDENCE.json] [TENANT_ID]
 * ISO instants; half-open period. Evidence file contains opaque references only.
 */
import { readFile } from "node:fs/promises";
import { dbAdmin, pool, tenantsTable, vendorUsageAttemptsTable } from "@workspace/db";
import { and, eq, gte, lt } from "drizzle-orm";
import { aggregateEconomics, economicsEvidenceSchema } from "../lib/usage-economics";

try {
  const [fromArg, toArg, evidencePath, tenantId, ...extra] = process.argv.slice(2);
  const from = new Date(fromArg),
    to = new Date(toArg);
  if (
    extra.length ||
    !fromArg ||
    !toArg ||
    !Number.isFinite(+from) ||
    !Number.isFinite(+to) ||
    +from >= +to ||
    +to - +from > 366 * 86400_000
  )
    throw new Error("Use FROM TO [EVIDENCE.json] [TENANT_ID]; maximum period 366 days");
  const evidence = economicsEvidenceSchema.parse(
    evidencePath ? JSON.parse(await readFile(evidencePath, "utf8")) : {},
  );
  // An explicit leaf filter cannot roll foreign siblings into its report.
  const attempts = await dbAdmin
    .select()
    .from(vendorUsageAttemptsTable)
    .where(
      and(
        gte(vendorUsageAttemptsTable.createdAt, from),
        lt(vendorUsageAttemptsTable.createdAt, to),
        tenantId ? eq(vendorUsageAttemptsTable.tenantId, tenantId) : undefined,
      ),
    );
  const tenants = await dbAdmin
    .select({ id: tenantsTable.id, parentId: tenantsTable.parentId })
    .from(tenantsTable);
  const result = aggregateEconomics(attempts, tenants, {
    from,
    to,
    evidence,
    allowedTenantIds: tenantId ? new Set([tenantId]) : null,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch {
  process.stderr.write(
    "Economics export failed. Check dates, schema and evidence; no cost conclusion available.\n",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
