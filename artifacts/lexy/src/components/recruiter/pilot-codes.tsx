/**
 * Enterprise pilot codes — account redeem card + platform-admin manager.
 */
import { useEffect, useState } from "react";
import { authHeaders } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Sparkles, KeyRound } from "lucide-react";
import { format, parseISO } from "date-fns";

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

export type PilotInfo = {
  id: string;
  tenantId: string;
  code: string;
  label: string;
  createdAt: string;
  endedAt: string | null;
};

async function pf(path: string, init: RequestInit = {}) {
  const r = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeaders() },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || j.error || `Request failed (${r.status})`);
  return j;
}

export function fetchPilotMe(): Promise<{ pilot: PilotInfo | null; complimentary: boolean }> {
  return pf("/pilot-codes/me");
}

const fmt = (s: string) => format(parseISO(s), "MMM d, yyyy");
const Err = ({ m }: { m: string | null }) =>
  m ? (
    <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {m}
    </div>
  ) : null;

/** Account-side: shows complimentary state, or a redeem form for admins. */
export function PilotAccountCard({
  pilot,
  complimentary,
  canRedeem,
  onChanged,
}: {
  pilot: PilotInfo | null;
  complimentary: boolean;
  canRedeem: boolean;
  onChanged: () => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function redeem() {
    setBusy(true);
    setErr(null);
    try {
      await pf("/pilot-codes/redeem", {
        method: "POST",
        body: JSON.stringify({ code: code.trim().toUpperCase() }),
      });
      setCode("");
      onChanged();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (complimentary) {
    return (
      <Card className="border border-primary/40 bg-primary/5">
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" />
              Complimentary Enterprise
            </CardTitle>
            <Badge>Pilot</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="stat-label">Plan</p>
              <p className="font-semibold mt-0.5">Enterprise</p>
            </div>
            <div>
              <p className="stat-label">Features</p>
              <p className="font-semibold mt-0.5">Full features</p>
            </div>
            <div>
              <p className="stat-label">Lexy fees</p>
              <p className="font-semibold mt-0.5">$0</p>
            </div>
            <div>
              <p className="stat-label">Duration</p>
              <p className="font-semibold mt-0.5">Until explicitly ended</p>
            </div>
          </div>
          {pilot && (
            <p className="text-xs text-muted-foreground">
              {pilot.label} · code {pilot.code} · since {fmt(pilot.createdAt)}. Covers this account
              and its client accounts.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            No card is on file and nothing is auto-billed. Charges from external providers (for
            example voice, email or data vendors) still apply.
          </p>
        </CardContent>
      </Card>
    );
  }
  if (!canRedeem) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-primary" />
          Enterprise pilot code
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Have a pilot code? Redeem it for Complimentary Enterprise with $0 Lexy fees.
          External-provider charges still apply.
        </p>
        <div className="flex gap-2 flex-wrap">
          <Input
            className="max-w-xs uppercase"
            maxLength={64}
            placeholder="PILOT-CODE"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ""))}
          />
          <Button disabled={busy || !code} onClick={redeem}>
            {busy && <Loader2 className="w-4 h-4 animate-spin mr-2" />}Redeem
          </Button>
        </div>
        <Err m={err} />
      </CardContent>
    </Card>
  );
}

type Admin = {
  codes: {
    id: string;
    code: string;
    label: string;
    maxRedemptions: number;
    redemptionCount: number;
    disabled: boolean;
    createdAt: string;
  }[];
  grants: {
    id: string;
    tenantId: string;
    tenantName: string;
    code: string;
    label: string;
    createdAt: string;
    endedAt: string | null;
  }[];
};

/** Platform-admin: manage codes, grant to a tenant, end grants. */
export function PilotAdminPanel({
  tenants,
  onChanged,
}: {
  tenants: { id: string; name: string }[];
  onChanged: () => void;
}) {
  const [data, setData] = useState<Admin | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [max, setMax] = useState("1");
  const [target, setTarget] = useState("");
  const [grantCode, setGrantCode] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = () =>
    pf("/pilot-codes/admin")
      .then(setData)
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);

  async function run(key: string, fn: () => Promise<any>, after?: () => void) {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      after?.();
      await load();
      onChanged();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  const maxN = Number(max);
  const valid =
    /^[A-Z0-9-]{1,64}$/.test(code) &&
    label.trim().length > 0 &&
    label.length <= 120 &&
    Number.isInteger(maxN) &&
    maxN >= 1 &&
    maxN <= 10000;
  const sel = "h-9 rounded-md border border-input bg-background px-2 text-sm";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-primary" />
          Enterprise pilot codes
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Complimentary Enterprise, $0 Lexy fees, until explicitly ended. Covers the account and its
          client accounts. No card or autobilling.
        </p>
        <Err m={err} />
        <div className="flex gap-2 flex-wrap items-end">
          <Input
            className="w-44"
            placeholder="CODE"
            maxLength={64}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ""))}
          />
          <Input
            className="w-56"
            placeholder="Label"
            maxLength={120}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Input
            className="w-28"
            type="number"
            min={1}
            max={10000}
            value={max}
            onChange={(e) => setMax(e.target.value)}
            aria-label="Max redemptions"
          />
          <Button
            disabled={!valid || busy === "create"}
            onClick={() =>
              run(
                "create",
                () =>
                  pf("/pilot-codes/admin", {
                    method: "POST",
                    body: JSON.stringify({ code, label: label.trim(), maxRedemptions: maxN }),
                  }),
                () => {
                  setCode("");
                  setLabel("");
                  setMax("1");
                },
              )
            }
          >
            {busy === "create" && <Loader2 className="w-4 h-4 animate-spin mr-2" />}Create code
          </Button>
        </div>

        {!data && !err && (
          <div className="text-sm text-muted-foreground flex items-center">
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
            Loading codes…
          </div>
        )}
        {data && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                  <tr>
                    <th className="text-left py-2 pr-3">Code</th>
                    <th className="text-left py-2 pr-3">Label</th>
                    <th className="text-left py-2 pr-3">Used</th>
                    <th className="text-left py-2 pr-3">Status</th>
                    <th className="text-left py-2" />
                  </tr>
                </thead>
                <tbody>
                  {data.codes.map((c) => (
                    <tr key={c.id} className="border-b border-border/40">
                      <td className="py-2 pr-3 font-mono text-xs">{c.code}</td>
                      <td className="py-2 pr-3">{c.label}</td>
                      <td className="py-2 pr-3">
                        {c.redemptionCount} / {c.maxRedemptions}
                      </td>
                      <td className="py-2 pr-3">
                        {c.disabled ? (
                          <Badge variant="outline">Disabled</Badge>
                        ) : (
                          <Badge variant="outline">Active</Badge>
                        )}
                      </td>
                      <td className="py-2 text-right">
                        {!c.disabled && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs"
                            disabled={busy === c.id}
                            title="Stops future redemptions only; existing grants stay"
                            onClick={() =>
                              run(c.id, () =>
                                pf(`/pilot-codes/admin/${c.id}/disable`, {
                                  method: "POST",
                                  body: "{}",
                                }),
                              )
                            }
                          >
                            {busy === c.id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              "Disable"
                            )}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.codes.length === 0 && (
                <p className="text-center text-muted-foreground py-6 text-sm">
                  No pilot codes yet. Create one above.
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                Disabling a code blocks future redemptions only; existing grants remain active.
              </p>
            </div>

            <div className="flex gap-2 flex-wrap items-end border-t border-border pt-4">
              <select className={sel} value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Grant to account…</option>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <select
                className={sel}
                value={grantCode}
                onChange={(e) => setGrantCode(e.target.value)}
              >
                <option value="">Code…</option>
                {data.codes
                  .filter((c) => !c.disabled && c.redemptionCount < c.maxRedemptions)
                  .map((c) => (
                    <option key={c.id} value={c.code}>
                      {c.code}
                    </option>
                  ))}
              </select>
              <Button
                variant="outline"
                disabled={!target || !grantCode || busy === "grant"}
                onClick={() =>
                  run(
                    "grant",
                    () =>
                      pf("/pilot-codes/redeem", {
                        method: "POST",
                        body: JSON.stringify({ code: grantCode, tenantId: target }),
                      }),
                    () => {
                      setTarget("");
                      setGrantCode("");
                    },
                  )
                }
              >
                {busy === "grant" && <Loader2 className="w-4 h-4 animate-spin mr-2" />}Grant
              </Button>
              <span className="text-xs text-muted-foreground">Root accounts only.</span>
            </div>

            <div className="overflow-x-auto">
              <p className="stat-label mb-2">Active and past grants</p>
              <table className="w-full text-sm">
                <tbody>
                  {data.grants.map((g) => (
                    <tr key={g.id} className="border-b border-border/40">
                      <td className="py-2 pr-3 font-medium">{g.tenantName}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{g.code}</td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">
                        {g.label} · {fmt(g.createdAt)}
                      </td>
                      <td className="py-2 text-right">
                        {g.endedAt ? (
                          <span className="text-xs text-muted-foreground">
                            Ended {fmt(g.endedAt)}
                          </span>
                        ) : confirmId === g.id ? (
                          <div className="flex flex-col items-end gap-1">
                            <span className="text-xs max-w-xs text-right">
                              Ending restores the account's normal plan and Lexy fees. No card is
                              charged. Continue?
                            </span>
                            <div className="flex gap-1">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 text-xs"
                                onClick={() => setConfirmId(null)}
                              >
                                Cancel
                              </Button>
                              <Button
                                size="sm"
                                variant="destructive"
                                className="h-8 text-xs"
                                disabled={busy === g.id}
                                onClick={() =>
                                  run(
                                    g.id,
                                    () =>
                                      pf(`/pilot-codes/admin/grants/${g.id}/end`, {
                                        method: "POST",
                                        body: JSON.stringify({ confirm: true }),
                                      }),
                                    () => setConfirmId(null),
                                  )
                                }
                              >
                                {busy === g.id ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  "End grant"
                                )}
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs"
                            onClick={() => setConfirmId(g.id)}
                          >
                            End grant
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.grants.length === 0 && (
                <p className="text-center text-muted-foreground py-6 text-sm">
                  No accounts have redeemed a pilot code.
                </p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
