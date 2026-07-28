/**
 * pages/recruiter/platform-pricing.tsx — Platform Admin Country Pricing Catalog
 *
 * The admin-editable override layer for country-level subscription PRICE
 * DISPLAY. Tier entitlements (seats / caps / features) are IDENTICAL across
 * every country and live in code — only the displayed PRICE varies per
 * country, and admins edit that here with no deploy.
 *
 * When no catalog row exists for a (country, plan, term) the API resolver
 * falls back to the code rate-card, so every country always resolves a price.
 * Rows created here are explicit OVERRIDES.
 *
 * No in-system payment processing — this is display + record-keeping only.
 * Taxes are billed externally; the taxNote disclosure is shown in the UI.
 *
 * Access: platform_admin only.
 */
import { authHeaders } from "@/lib/api";
import { useState } from "react";
import { Redirect } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { useAuth } from "@/lib/auth-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { CreditCard, Loader2, Plus, Trash2, Info } from "lucide-react";

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

const PLANS = ["starter", "growth", "enterprise"] as const;
const TERMS = ["monthly", "quarterly", "annual"] as const;

type Price = {
  id: string;
  country: string;
  planCode: string;
  billingTerm: string;
  currency: string;
  symbol: string;
  amount: number;
  perSeatAmount: number;
  perHireAmount: number;
  taxNote: string;
  active: boolean;
  updatedAt: string;
};

function authFetch(url: string, init?: RequestInit) {
  return fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
}

export default function PlatformPricing() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ prices: Price[] }>({
    queryKey: ["subscription-prices"],
    queryFn: async () => {
      const r = await authFetch(`${apiBase}/subscription-prices`);
      if (!r.ok) throw new Error((await r.json()).message || "Failed to load");
      return r.json();
    },
    enabled: !!user,
  });

  const createMut = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const r = await authFetch(`${apiBase}/subscription-prices`, { method: "POST", body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error || "Failed to create");
      return j;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["subscription-prices"] }); setCreateOpen(false); setError(null); },
    onError: (e: any) => setError(e.message),
  });

  const updateMut = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: Record<string, unknown> }) => {
      const r = await authFetch(`${apiBase}/subscription-prices/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error || "Failed to update");
      return j;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["subscription-prices"] }),
    onError: (e: any) => setError(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await authFetch(`${apiBase}/subscription-prices/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json()).message || "Failed to delete");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["subscription-prices"] }),
    onError: (e: any) => setError(e.message),
  });

  if (user && user.role !== "platform_admin") return <Redirect to="/dashboard" />;

  const prices = data?.prices ?? [];

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="page-title flex items-center gap-2">
              <CreditCard className="w-7 h-7 text-primary" /> Country Pricing
            </h1>
            <p className="text-muted-foreground mt-1 max-w-2xl">
              Edit the displayed subscription price per country. Tiers (seats, caps, features) are identical everywhere — only the price varies. Countries without a row here fall back to the built-in rate card.
            </p>
          </div>
          <CreatePriceDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            submitting={createMut.isPending}
            onSubmit={(body) => createMut.mutate(body)}
          />
        </div>

        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground flex items-start gap-2">
          <Info className="w-4 h-4 mt-0.5 shrink-0" />
          <span>Amounts are in major currency units (e.g. 799 = $799) for the chosen term. <code>-1</code> means "contact us". Taxes are billed externally — the tax note is shown to customers.</span>
        </div>

        {error && <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Catalog overrides {prices.length > 0 && <span className="text-muted-foreground font-normal">({prices.length})</span>}</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center h-32 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mr-2" />Loading…</div>
            ) : prices.length === 0 ? (
              <p className="text-center text-muted-foreground py-10">No overrides yet — every country uses the built-in rate card. Add one to customize a price.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                    <tr>
                      <th className="text-left py-2 pr-3">Country</th>
                      <th className="text-left py-2 pr-3">Plan</th>
                      <th className="text-left py-2 pr-3">Term</th>
                      <th className="text-left py-2 pr-3">Currency</th>
                      <th className="text-left py-2 pr-3">Amount</th>
                      <th className="text-left py-2 pr-3">Per seat</th>
                      <th className="text-left py-2 pr-3">Per hire</th>
                      <th className="text-left py-2 pr-3">Active</th>
                      <th className="text-left py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {prices.map((p) => (
                      <PriceRow
                        key={p.id}
                        price={p}
                        busy={updateMut.isPending || deleteMut.isPending}
                        onSave={(body) => updateMut.mutate({ id: p.id, body })}
                        onToggle={(active) => updateMut.mutate({ id: p.id, body: { active } })}
                        onDelete={() => deleteMut.mutate(p.id)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}

function PriceRow({ price, busy, onSave, onToggle, onDelete }: {
  price: Price;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => void;
  onToggle: (active: boolean) => void;
  onDelete: () => void;
}) {
  const [amount, setAmount] = useState(String(price.amount));
  const [perSeat, setPerSeat] = useState(String(price.perSeatAmount));
  const [perHire, setPerHire] = useState(String(price.perHireAmount));
  const dirty = amount !== String(price.amount) || perSeat !== String(price.perSeatAmount) || perHire !== String(price.perHireAmount);

  return (
    <tr className="border-b border-border/40 hover:bg-muted/30">
      <td className="py-2 pr-3 font-medium uppercase">{price.country}</td>
      <td className="py-2 pr-3"><Badge variant="outline" className="capitalize">{price.planCode}</Badge></td>
      <td className="py-2 pr-3 capitalize">{price.billingTerm}</td>
      <td className="py-2 pr-3">{price.symbol} {price.currency}</td>
      <td className="py-2 pr-3"><Input value={amount} onChange={(e) => setAmount(e.target.value)} className="w-24 h-8" inputMode="numeric" /></td>
      <td className="py-2 pr-3"><Input value={perSeat} onChange={(e) => setPerSeat(e.target.value)} className="w-20 h-8" inputMode="numeric" /></td>
      <td className="py-2 pr-3"><Input value={perHire} onChange={(e) => setPerHire(e.target.value)} className="w-20 h-8" inputMode="numeric" /></td>
      <td className="py-2 pr-3"><Switch checked={price.active} onCheckedChange={onToggle} disabled={busy} /></td>
      <td className="py-2">
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy || !dirty}
            onClick={() => onSave({ amount: Number(amount), perSeatAmount: Number(perSeat), perHireAmount: Number(perHire) })}>
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
          </Button>
          <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive" disabled={busy} onClick={onDelete} aria-label={`Delete ${price.country.toUpperCase()} ${price.planCode} price`}>
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </td>
    </tr>
  );
}

function CreatePriceDialog({ open, onOpenChange, submitting, onSubmit }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  submitting: boolean;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const [country, setCountry] = useState("");
  const [planCode, setPlanCode] = useState<string>("starter");
  const [billingTerm, setBillingTerm] = useState<string>("monthly");
  const [currency, setCurrency] = useState("USD");
  const [symbol, setSymbol] = useState("$");
  const [amount, setAmount] = useState("");
  const [perSeat, setPerSeat] = useState("0");
  const [perHire, setPerHire] = useState("0");
  const [taxNote, setTaxNote] = useState("Prices exclusive of applicable VAT/GST.");

  const valid = country.trim().length === 2 && currency.trim().length > 0 && amount.trim() !== "" && !Number.isNaN(Number(amount));

  function submit() {
    onSubmit({
      country: country.trim().toUpperCase(),
      planCode, billingTerm,
      currency: currency.trim().toUpperCase(),
      symbol: symbol.trim() || "$",
      amount: Number(amount),
      perSeatAmount: Number(perSeat) || 0,
      perHireAmount: Number(perHire) || 0,
      taxNote: taxNote.trim() || undefined,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button className="gap-2"><Plus className="w-4 h-4" /> Add price</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Add country price</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Country (ISO-2)</Label>
            <Input value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} placeholder="US" maxLength={2} />
          </div>
          <div className="space-y-1.5">
            <Label>Plan</Label>
            <Select value={planCode} onValueChange={setPlanCode}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{PLANS.map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Term</Label>
            <Select value={billingTerm} onValueChange={setBillingTerm}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{TERMS.map((t) => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>Currency</Label>
              <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder="USD" />
            </div>
            <div className="space-y-1.5">
              <Label>Symbol</Label>
              <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="$" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Amount ({billingTerm})</Label>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="799" inputMode="numeric" />
          </div>
          <div className="space-y-1.5">
            <Label>Per seat / mo</Label>
            <Input value={perSeat} onChange={(e) => setPerSeat(e.target.value)} inputMode="numeric" />
          </div>
          <div className="space-y-1.5">
            <Label>Per hire</Label>
            <Input value={perHire} onChange={(e) => setPerHire(e.target.value)} inputMode="numeric" />
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label>Tax note</Label>
            <Input value={taxNote} onChange={(e) => setTaxNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={!valid || submitting}>
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
