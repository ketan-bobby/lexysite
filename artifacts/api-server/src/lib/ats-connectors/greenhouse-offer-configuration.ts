import { z } from "zod/v4";
import {
  offerDigest,
  offerRevision,
  offerSnapshotSchema,
  type OfferSnapshot,
} from "./greenhouse-offer-policy";
import { boundGreenhouseApprovalFlow, greenhouseApprovalState } from "./greenhouse-offer-evidence";

export const GREENHOUSE_OFFER_CONFIGURATION_SCOPES = [
  "harvest:custom_fields:list",
  "harvest:custom_field_options:list",
  "harvest:custom_field_offices:list",
  "harvest:custom_field_departments:list",
  "harvest:offices:list",
  "harvest:departments:list",
  "harvest:jobs:list",
  "harvest:openings:list",
  "harvest:approval_flows:list",
] as const;
const id = z.number().int().positive().safe();
const stamp = z.iso.datetime({ offset: true });
const key = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,79}$/)
  .refine((v) => !["constructor", "prototype", "__proto__"].includes(v));
const fieldSchema = z.object({
  id,
  name_key: key,
  name: z.string().min(1).max(500),
  field_type: z.literal("offer"),
  active: z.literal(true),
  value_type: z.string().min(1).max(100),
  private: z.boolean(),
  required: z.boolean(),
  trigger_new_version: z.boolean(),
  internal_type: z.string().max(100).nullable(),
  default_value: z.unknown().refine((v) => v !== undefined),
  updated_at: stamp,
});
const treeSchema = z.object({ id, parent_id: id.nullable(), updated_at: stamp });
const jobSchema = z.object({
  id,
  status: z.enum(["open", "closed", "draft"]),
  is_template: z.boolean().nullable(),
  department_id: id.nullable(),
  office_ids: z.array(id).max(500).nullable(),
  updated_at: stamp,
});
const optionSchema = z.object({
  id,
  custom_field_id: id,
  name: z.string().min(1).max(500),
  active: z.literal(true),
  updated_at: stamp,
});
const officeRuleSchema = z.object({ id, custom_field_id: id, office_id: id, updated_at: stamp });
const departmentRuleSchema = z.object({
  id,
  custom_field_id: id,
  department_id: id,
  updated_at: stamp,
});
const openingSchema = z.object({
  id,
  job_id: id,
  open: z.literal(true),
  application_id: z.null(),
  closed_at: z.null(),
  opening_id: z.string().max(1000).nullable(),
  updated_at: stamp,
});
const reservationSchema = z.object({
  id,
  job_id: id,
  application_id: id,
  opening_id: id.nullable(),
  status: z.literal("Created"),
  resolved_at: z.null(),
  version: id,
  updated_at: stamp,
});

function rows<T extends z.ZodType<{ id: number }>>(
  schema: T,
  raw: unknown,
  max = 500,
): z.output<T>[] {
  const result = z.array(schema).max(max).parse(raw);
  if (new Set(result.map((v) => v.id)).size !== result.length)
    throw new Error("Duplicate metadata.");
  return result.sort((a, b) => a.id - b.id);
}
function ancestors(tree: z.infer<typeof treeSchema>[], selected: number[]) {
  const parents = new Map(tree.map((v) => [v.id, v.parent_id]));
  const result = new Set<number>();
  // Validate the complete returned graph, including unrelated cycles/orphans.
  for (const start of [...parents.keys(), ...selected]) {
    const seen = new Set<number>();
    let cursor: number | null = start;
    while (cursor !== null) {
      if (seen.has(cursor) || !parents.has(cursor)) throw new Error("Incomplete hierarchy.");
      seen.add(cursor);
      cursor = parents.get(cursor)!;
    }
  }
  for (const start of selected) {
    let cursor: number | null = start;
    while (cursor !== null) {
      result.add(cursor);
      cursor = parents.get(cursor)!;
    }
  }
  return result;
}
const fieldProjection =
  "id,name_key,name,field_type,active,value_type,private,required,trigger_new_version,internal_type,default_value,updated_at";
type ReadJson = (path: string) => Promise<unknown>;

async function sweep(s: OfferSnapshot, read: ReadJson) {
  const jobs = rows(
    jobSchema,
    await read(
      `/v3/jobs?ids=${s.binding.jobId}&per_page=2&fields=id,status,is_template,department_id,office_ids,updated_at`,
    ),
    1,
  );
  if (jobs.length !== 1 || String(jobs[0].id) !== s.binding.jobId)
    throw new Error("Job metadata unavailable.");
  const job = jobs[0];
  if (job.office_ids && new Set(job.office_ids).size !== job.office_ids.length)
    throw new Error("Duplicate job offices.");
  if (job.office_ids) job.office_ids.sort((a, b) => a - b);
  const fields = rows(
    fieldSchema,
    await read(
      `/v3/custom_fields?field_type=offer&active=true&per_page=101&fields=${fieldProjection}`,
    ),
    100,
  );
  if (new Set(fields.map((f) => f.name_key)).size !== fields.length)
    throw new Error("Duplicate field keys.");
  const offices = rows(
    treeSchema,
    await read("/v3/offices?per_page=500&fields=id,parent_id,updated_at"),
  );
  const departments = rows(
    treeSchema,
    await read("/v3/departments?per_page=500&fields=id,parent_id,updated_at"),
  );
  const openings = rows(
    openingSchema,
    await read(
      `/v3/openings?job_ids=${s.binding.jobId}&open=true&per_page=500&fields=id,job_id,open,application_id,closed_at,opening_id,updated_at`,
    ),
  );
  const reservations = rows(
    reservationSchema,
    await read(
      `/v3/offers?job_ids=${s.binding.jobId}&current_only=true&status=Created&per_page=101&fields=id,job_id,application_id,opening_id,status,resolved_at,version,updated_at`,
    ),
    100,
  );
  if ([...openings, ...reservations].some((v) => String(v.job_id) !== s.binding.jobId))
    throw new Error("Foreign job metadata.");
  const existing = reservations.find((r) => String(r.id) === s.existingChain?.id);
  if (
    existing &&
    (String(existing.application_id) !== s.binding.applicationId ||
      existing.version !== s.existingChain!.version)
  )
    throw new Error("Existing offer chain binding changed.");
  const jobApproval = boundGreenhouseApprovalFlow(
    await read(`/v3/approval_flows?job_ids=${s.binding.jobId}&approval_type=offer_job&per_page=2`),
    s,
    "job",
  );
  const offerApproval = s.existingChain
    ? boundGreenhouseApprovalFlow(
        await read(
          `/v3/approval_flows?offer_ids=${s.existingChain.id}&approval_type=offer_candidate&per_page=2`,
        ),
        s,
        "offer",
      )
    : null;
  const options: z.infer<typeof optionSchema>[] = [];
  const officeRules: z.infer<typeof officeRuleSchema>[] = [];
  const departmentRules: z.infer<typeof departmentRuleSchema>[] = [];
  for (let offset = 0; offset < fields.length; offset += 50) {
    const batch = fields.slice(offset, offset + 50);
    const batchIds = batch.map((f) => f.id);
    const choices = batch
      .filter((f) => ["single_select", "multi_select"].includes(f.value_type))
      .map((f) => f.id);
    const optionRows = choices.length
      ? rows(
          optionSchema,
          await read(
            `/v3/custom_field_options?custom_field_ids=${choices.join(",")}&active=true&per_page=500&fields=id,custom_field_id,name,active,updated_at`,
          ),
        )
      : [];
    const officeRows = rows(
      officeRuleSchema,
      await read(
        `/v3/custom_field_offices?custom_field_ids=${batchIds.join(",")}&per_page=500&fields=id,custom_field_id,office_id,updated_at`,
      ),
    );
    const departmentRows = rows(
      departmentRuleSchema,
      await read(
        `/v3/custom_field_departments?custom_field_ids=${batchIds.join(",")}&per_page=500&fields=id,custom_field_id,department_id,updated_at`,
      ),
    );
    if (
      optionRows.some((r) => !choices.includes(r.custom_field_id)) ||
      [...officeRows, ...departmentRows].some((r) => !batchIds.includes(r.custom_field_id))
    )
      throw new Error("Foreign field metadata.");
    options.push(...optionRows);
    officeRules.push(...officeRows);
    departmentRules.push(...departmentRows);
  }
  // Also reject identifier reuse across batches and duplicate semantic rules/options.
  const allOptions = rows(optionSchema, options, 1000);
  const allOfficeRules = rows(officeRuleSchema, officeRules, 1000);
  const allDepartmentRules = rows(departmentRuleSchema, departmentRules, 1000);
  if (
    new Set(allOfficeRules.map((r) => `${r.custom_field_id}:${r.office_id}`)).size !==
      allOfficeRules.length ||
    new Set(allDepartmentRules.map((r) => `${r.custom_field_id}:${r.department_id}`)).size !==
      allDepartmentRules.length ||
    new Set(reservations.map((r) => r.application_id)).size !== reservations.length
  )
    throw new Error("Ambiguous metadata relationships.");
  for (const f of fields) {
    const names = allOptions.filter((o) => o.custom_field_id === f.id).map((o) => o.name);
    if (new Set(names).size !== names.length) throw new Error("Ambiguous choice names.");
  }
  const officeIds = new Set(offices.map((o) => o.id)),
    departmentIds = new Set(departments.map((d) => d.id));
  if (
    allOfficeRules.some((r) => !officeIds.has(r.office_id)) ||
    allDepartmentRules.some((r) => !departmentIds.has(r.department_id))
  )
    throw new Error("Missing visibility parent.");
  return {
    job,
    fields,
    offices,
    departments,
    openings,
    reservations,
    jobApproval,
    offerApproval,
    options: allOptions,
    officeRules: allOfficeRules,
    departmentRules: allDepartmentRules,
  };
}

/**
 * Bounded read plan: two complete, canonically compared sweeps, at most 28 GETs.
 * The owning HTTP transport MUST bound total time/bytes, permissions and pagination.
 * No fetcher, credentials or authorization are provided by this pure read plan.
 */
export async function readGreenhouseOfferConfiguration(raw: OfferSnapshot, read: ReadJson) {
  const s = offerSnapshotSchema.parse(raw);
  const first = await sweep(s, read),
    second = await sweep(s, read);
  if (offerDigest(first) !== offerDigest(second))
    throw new Error("Employer configuration changed.");
  const context = {
    tenantId: s.actor.tenantId,
    actorId: s.actor.id,
    workflowId: s.scope.workflowId,
    accountRef: s.accountRef,
    connectionRevision: s.connectionRevision,
    binding: s.binding,
    snapshotRevision: offerRevision(s),
  };
  const revision = offerDigest({ context, metadata: second });
  const officeAncestors = ancestors(second.offices, second.job.office_ids ?? []);
  const departmentAncestors = ancestors(
    second.departments,
    second.job.department_id ? [second.job.department_id] : [],
  );
  const fields = second.fields.map((f) => {
    const officeRestrictions = second.officeRules
      .filter((r) => r.custom_field_id === f.id)
      .map((r) => r.office_id);
    const departmentRestrictions = second.departmentRules
      .filter((r) => r.custom_field_id === f.id)
      .map((r) => r.department_id);
    const applies =
      (!officeAncestors.size ||
        !officeRestrictions.length ||
        officeRestrictions.some((v) => officeAncestors.has(v))) &&
      (!departmentAncestors.size ||
        !departmentRestrictions.length ||
        departmentRestrictions.some((v) => departmentAncestors.has(v)));
    const supported =
      f.internal_type === null &&
      ["short_text", "long_text", "number", "date", "single_select", "currency"].includes(
        f.value_type,
      );
    return {
      id: String(f.id),
      key: f.name_key,
      name: f.name,
      valueType: f.value_type,
      internalType: f.internal_type,
      required: f.required,
      private: f.private,
      triggersNewVersion: f.trigger_new_version,
      applies,
      supported,
      hasDefault: f.default_value !== null,
      defaultHash: offerDigest(f.default_value),
      choices: second.options
        .filter((o) => o.custom_field_id === f.id)
        .map((o) => ({ id: String(o.id), name: o.name })),
      officeRestrictions: officeRestrictions.sort((a, b) => a - b),
      departmentRestrictions: departmentRestrictions.sort((a, b) => a - b),
    };
  });
  function systemRequirement(internalType: string) {
    const matched = fields.filter((f) => f.applies && f.internalType === internalType);
    if (matched.length > 1) throw new Error("Ambiguous managed field.");
    return matched[0]?.required ?? null;
  }
  return {
    executionReady: false as const,
    revision,
    metadataRevision: offerDigest(second),
    context,
    job: { id: s.binding.jobId, status: second.job.status, isTemplate: second.job.is_template },
    fields,
    systemRequirements: {
      startDateRequired: systemRequirement("start_date"),
      openingRequired: systemRequirement("offer_opening"),
    },
    openings: second.openings.map((o) => ({
      id: String(o.id),
      availability: second.reservations.some((r) => r.opening_id === o.id)
        ? ("reserved" as const)
        : ("candidate" as const),
      reservedByCurrentChain: second.reservations.some(
        (r) =>
          r.opening_id === o.id &&
          String(r.id) === s.existingChain?.id &&
          String(r.application_id) === s.binding.applicationId &&
          r.version === s.existingChain?.version,
      ),
    })),
    jobApproval: {
      state: greenhouseApprovalState(second.jobApproval),
      revision: offerDigest(second.jobApproval),
    },
    offerApproval: {
      state: greenhouseApprovalState(second.offerApproval),
      revision: offerDigest(second.offerApproval),
    },
    currencyRules: fields
      .filter((f) => f.applies && f.valueType === "currency")
      .map((f) => ({
        fieldId: f.id,
        allowedCodes: null,
        minorUnitDigits: null,
      })),
    unresolved: [
      "verified_employer_currency_rules",
      "verified_candidate_approval_configuration",
      "verified_application_binding",
      "verified_no_candidate_delivery_side_effects",
      ...(fields.some((f) => f.applies && !f.supported && f.internalType === null)
        ? ["unsupported_offer_field_types"]
        : []),
      ...(systemRequirement("start_date") === null || systemRequirement("offer_opening") === null
        ? ["managed_field_requirements_unknown"]
        : []),
      ...(second.job.status !== "open" || second.job.is_template !== false
        ? ["job_not_verified_open_non_template"]
        : []),
      ...(fields.some((f) => f.applies && f.valueType === "single_select" && !f.choices.length)
        ? ["select_options_missing"]
        : []),
    ],
  };
}
