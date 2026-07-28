/**
 * AiDisclosureBanner.tsx — Candidate-facing AEDT / AI use disclosure (T011)
 *
 * ─── Why this component exists ───────────────────────────────────────────────
 * NYC LL144 § 5-301, CO SB24-205, IL AIVI, and the EU AI Act (high-risk
 * employment) each require that, BEFORE an automated employment decision
 * tool is used on a candidate, the candidate is informed that AI is in
 * use and is given a chance to acknowledge. This banner is the
 * single source-of-truth surface for that requirement inside the
 * candidate portal.
 *
 * ─── Behaviour ───────────────────────────────────────────────────────────────
 * • On mount, calls GET /api/portal/disclosures/active with the
 *   candidate's known context. The backend resolves applicable
 *   jurisdictions via classifyJurisdictions and returns the active
 *   disclosure templates + policy version IDs.
 * • If `shouldDisplay === true` AND the candidate has not previously
 *   acknowledged this exact templates+policy combo (localStorage
 *   cache to avoid re-prompting on every reload), render the banner.
 * • "Acknowledge" posts to /api/portal/disclosures/ack with the
 *   surface=`portal_banner` and the exact templateIds + policyVersionIds.
 *   The server writes an append-only ack row + a decision_events row.
 * • "Read full notice" links to /portal/aedt-notice which renders the
 *   long-form copy.
 *
 * ─── Failure mode ────────────────────────────────────────────────────────────
 * If the API call fails, the banner does NOT render. The audit
 * trail relies on the ack POST succeeding; if we cannot fetch the
 * templates we cannot ask for an informed ack, so we stay silent
 * rather than show stale or wrong copy. Server-side metrics will
 * alert on a sudden drop in ack volume.
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ShieldCheck, Info, Loader2 } from "lucide-react";
import { apiBase, apiFetch } from "@/lib/api";

interface DisclosureTemplate {
  jurisdictionCode: string;
  templateId: string;
  subject: string | null;
  bodyMarkdown: string;
}

interface DisclosureResponse {
  jurisdictions: string[];
  requireDisclosure: boolean;
  requireAppeal: boolean;
  requireAudit: boolean;
  policyVersionIds: string[];
  contributingBasis: string[];
  templates: DisclosureTemplate[];
  shouldDisplay: boolean;
}

/* localStorage cache key. We key on the concatenated ack payload so a
 * new template version or new jurisdiction re-prompts the candidate.
 * Format: `disclosure_ack:<sha-like>:<surface>` — kept simple, this
 * is opt-out memory, not a security boundary. */
function ackCacheKey(payload: { jurisdictionCodes: string[]; templateIds: string[]; policyVersionIds: string[] }) {
  const joined = [
    payload.jurisdictionCodes.slice().sort().join(","),
    payload.templateIds.slice().sort().join(","),
    payload.policyVersionIds.slice().sort().join(","),
  ].join("|");
  return `disclosure_ack:portal_banner:${joined}`;
}

export function AiDisclosureBanner() {
  const [data, setData] = useState<DisclosureResponse | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch(`${apiBase}/portal/disclosures/active`);
        if (!r.ok) return;
        const json: DisclosureResponse = await r.json();
        if (cancelled) return;
        if (!json.shouldDisplay) return;
        /* Suppress if the candidate already acked this exact bundle on
         * this device. They can always re-read the long-form notice. */
        const cacheKey = ackCacheKey({
          jurisdictionCodes: json.jurisdictions,
          templateIds: json.templates.map((t) => t.templateId),
          policyVersionIds: json.policyVersionIds,
        });
        if (localStorage.getItem(cacheKey)) return;
        setData(json);
      } catch {
        /* swallow — see file-level docstring "Failure mode" */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!data || dismissed) return null;

  const onAck = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const body = {
        jurisdictionCodes: data.jurisdictions,
        disclosureTemplateIds: data.templates.map((t) => t.templateId),
        policyVersionIds: data.policyVersionIds,
        surface: "portal_banner",
      };
      const r = await apiFetch(`${apiBase}/portal/disclosures/ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const msg = await r.text().catch(() => "");
        throw new Error(msg || `HTTP ${r.status}`);
      }
      localStorage.setItem(
        ackCacheKey({
          jurisdictionCodes: body.jurisdictionCodes,
          templateIds: body.disclosureTemplateIds,
          policyVersionIds: body.policyVersionIds,
        }),
        new Date().toISOString(),
      );
      setDismissed(true);
    } catch (err: any) {
      setError(err?.message ?? "Failed to record acknowledgement");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="region"
      aria-label="AI disclosure"
      className="mb-6 rounded-xl border border-amber-300/30 bg-amber-300/5 px-4 py-3 text-sm"
      data-testid="ai-disclosure-banner"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0 text-amber-300">
          <ShieldCheck className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-foreground">
            This employer uses an AI system to help evaluate candidates
          </div>
          <p className="mt-1 text-muted-foreground leading-relaxed">
            Under {data.jurisdictions.join(", ")} law you are entitled to know that
            an automated employment decision tool may be used as part of your
            application, and to request an alternative selection process or
            reasonable accommodation. A human reviewer makes the final hiring
            decision in every case.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Link
              href="/portal/aedt-notice"
              className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2"
            >
              <Info className="w-3 h-3" /> Read the full notice
            </Link>
            <button
              type="button"
              onClick={onAck}
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60"
              data-testid="ai-disclosure-ack"
            >
              {submitting ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              I understand
            </button>
            {error ? (
              <span className="text-xs text-destructive">{error}</span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export default AiDisclosureBanner;
