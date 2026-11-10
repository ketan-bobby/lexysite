import type { SourcingLimits, SourcingPolicy } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import { AccountRatesForm } from "./AccountRatesForm";
import { PROVIDERS, Field, type FormState } from "./sourcing-controls-shared";

export interface SourcingLimitsFormProps {
  form: FormState;
  errors: Record<string, string>;
  limits: SourcingLimits | null;
  policy: SourcingPolicy | null;
  employees: boolean;
  canEdit: boolean;
  canApprove: boolean;
  pending: boolean;
  dirty: boolean;
  stale: boolean;
  approvedFresh: boolean;
  currentJourney: { id: string; version: number } | undefined;
  set: (patch: Partial<FormState>) => void;
  onSave: () => void;
  onApprove: () => void;
  onDiscard: () => void;
  showAccountRates?: boolean;
}

export function SourcingLimitsForm({
  form,
  errors,
  limits,
  policy,
  employees,
  canEdit,
  canApprove,
  pending,
  dirty,
  stale,
  approvedFresh,
  currentJourney,
  set,
  onSave: save,
  onApprove: approve,
  onDiscard,
  showAccountRates = false,
}: SourcingLimitsFormProps) {
  return (
    <section className="space-y-3">
      <h4 className="text-sm font-semibold">Limits</h4>
      {employees && (
        <p className="text-xs text-muted-foreground" data-testid="text-scope-locked">
          Internal scope: external sourcing and providers are locked off.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <div className="min-w-0 space-y-2 sm:col-span-2 xl:col-span-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!employees && form.allowExternal}
              disabled={!canEdit || employees || pending}
              onChange={(e) =>
                set({
                  allowExternal: e.target.checked,
                  providers: e.target.checked ? form.providers : [],
                })
              }
              data-testid="checkbox-allow-external"
            />
            Allow external providers (planning only)
          </label>
          <div className="flex flex-wrap gap-x-4 gap-y-1" role="group" aria-label="Providers">
            {PROVIDERS.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!employees && form.allowExternal && form.providers.includes(p.id)}
                  disabled={!canEdit || employees || !form.allowExternal || pending}
                  onChange={(e) =>
                    set({
                      providers: e.target.checked
                        ? [...form.providers, p.id]
                        : form.providers.filter((x) => x !== p.id),
                    })
                  }
                  data-testid={`checkbox-provider-${p.id}`}
                />
                {p.label}
              </label>
            ))}
          </div>
          {errors.providers && !employees && (
            <p role="alert" className="text-[11px] text-destructive" data-testid="error-providers">
              {errors.providers}
            </p>
          )}
        </div>
        <Field
          id="maxCandidates"
          label="Planned candidate target"
          hint="1 to 25. Planned stopping limit, not enforced yet."
          error={errors.maxCandidates}
        >
          <Input
            id="maxCandidates"
            inputMode="numeric"
            value={form.maxCandidates}
            disabled={!canEdit || pending}
            onChange={(e) => set({ maxCandidates: e.target.value })}
            data-testid="input-max-candidates"
          />
        </Field>
        <Field
          id="maxDurationSeconds"
          label="Planned runtime (seconds)"
          hint="30 to 900. Planned stopping limit, not enforced yet."
          error={errors.maxDurationSeconds}
        >
          <Input
            id="maxDurationSeconds"
            inputMode="numeric"
            value={form.maxDurationSeconds}
            disabled={!canEdit || pending}
            onChange={(e) => set({ maxDurationSeconds: e.target.value })}
            data-testid="input-max-duration"
          />
        </Field>
        <Field
          id="maxRuns"
          label="Max outstanding holds"
          hint="1 to 20. Caps prepared holds that exist at the same time."
          error={errors.maxRuns}
        >
          <Input
            id="maxRuns"
            inputMode="numeric"
            value={form.maxRuns}
            disabled={!canEdit || pending}
            onChange={(e) => set({ maxRuns: e.target.value })}
            data-testid="input-max-runs"
          />
        </Field>
        <Field
          id="runBudget"
          label="Safety allocation per hold (USD)"
          hint="Operational planning cap, not a subscription bill or monthly allowance."
          error={errors.runBudget}
        >
          <Input
            id="runBudget"
            inputMode="decimal"
            value={form.runBudget}
            disabled={!canEdit || pending}
            onChange={(e) => set({ runBudget: e.target.value })}
            data-testid="input-run-budget"
          />
        </Field>
        <Field
          id="totalBudget"
          label="Total safety allocation cap (USD)"
          hint="Up to $100,000.00 and at least the per-hold amount."
          error={errors.totalBudget}
        >
          <Input
            id="totalBudget"
            inputMode="decimal"
            value={form.totalBudget}
            disabled={!canEdit || pending}
            onChange={(e) => set({ totalBudget: e.target.value })}
            data-testid="input-total-budget"
          />
        </Field>
      </div>
      {showAccountRates && (
        <AccountRatesForm form={form} errors={errors} disabled={!canEdit || pending} set={set} />
      )}
      {dirty && (
        <p className="text-xs text-muted-foreground" data-testid="text-sourcing-dirty">
          Unsaved edits. Background refreshes will not overwrite them.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {canEdit && (
          <Button
            size="sm"
            onClick={save}
            disabled={pending || !limits || (!dirty && !!policy)}
            data-testid="button-save-limits"
          >
            {pending && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />}
            Save limits
          </Button>
        )}
        {canEdit && dirty && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={onDiscard}
            data-testid="button-discard-limits"
          >
            Discard edits
          </Button>
        )}
        {canApprove && (
          <Button
            size="sm"
            variant="outline"
            onClick={approve}
            disabled={pending || !policy || dirty || !currentJourney || stale || approvedFresh}
            data-testid="button-approve-limits"
          >
            Approve for current journey
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Saving revokes any earlier approval. Approval binds the exact current brief and approved
        journey
        {currentJourney ? ` (version ${currentJourney.version})` : ""} and does not activate
        anything.
        {!currentJourney && canApprove && " No current approved journey is available to bind."}
        {dirty && policy && " Save or discard edits before approving."}
      </p>
    </section>
  );
}
