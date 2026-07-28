/**
 * components/share/PushToClientModal.tsx — Push Candidate to Client Talent Pool
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * A dialog that lets a recruiter select one of their client tenants from a
 * dropdown and push the current candidate into that client's talent pool,
 * with an optional personal note. Submits to POST /api/talent-pool/:candidateId.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   pages/recruiter/candidates/[id].tsx  — candidate profile action menu
 *   pages/recruiter/pipeline.tsx         — pipeline card action button
 */

import { useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@workspace/react-hooks/use-toast";
import { useQuery } from "@tanstack/react-query";
import { Building2, Send, Loader2, CheckCircle2 } from "lucide-react";
import { apiFetch, apiBase } from "@/lib/api";

interface Client {
  id: string;
  name: string;
  industry?: string | null;
  clientType?: string | null;
  status?: string | null;
}

interface PushToClientModalProps {
  open: boolean;
  onClose: () => void;
  candidateId: string;
  candidateName: string;
}

export function PushToClientModal({ open, onClose, candidateId, candidateName }: PushToClientModalProps) {
  const { toast } = useToast();

  const [selectedClientId, setSelectedClientId] = useState<string>("");
  const [note, setNote] = useState("");
  const [pushing, setPushing] = useState(false);
  const [pushed, setPushed] = useState(false);
  const [pushedClientName, setPushedClientName] = useState("");

  const { data, isLoading } = useQuery<{ clients: Client[] }>({
    queryKey: ["clients-list"],
    queryFn: async () => {
      const res = await apiFetch(`${apiBase}/clients`);
      if (!res.ok) throw new Error("Failed to load clients");
      return res.json();
    },
    enabled: open,
    staleTime: 30_000,
  });

  const clients = data?.clients ?? [];
  const selectedClient = clients.find(c => c.id === selectedClientId);

  const handleClose = () => {
    setSelectedClientId("");
    setNote("");
    setPushing(false);
    setPushed(false);
    setPushedClientName("");
    onClose();
  };

  const handlePush = async () => {
    if (!selectedClientId) return;
    setPushing(true);
    try {
      const res = await apiFetch(`${apiBase}/candidates/${candidateId}/push-to-client`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientTenantId: selectedClientId, note: note.trim() || undefined }),
      });
      const data = await res.json();
      if (res.status === 409) {
        toast({
          title: "Already in pool",
          description: data.message ?? "This candidate is already in that client's pool.",
          variant: "destructive",
        });
        return;
      }
      if (!res.ok) throw new Error(data.error ?? "Push failed");
      setPushedClientName(data.clientName ?? selectedClient?.name ?? "client");
      setPushed(true);
      toast({
        title: "Candidate pushed",
        description: `${candidateName} has been added to ${data.clientName}'s talent pool.`,
      });
    } catch (err: any) {
      toast({
        title: "Push failed",
        description: err.message ?? "Something went wrong. Please try again.",
        variant: "destructive",
      });
    } finally {
      setPushing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md border-border/50 bg-card">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-bold">
            <Building2 className="w-4 h-4 text-primary" />
            Push to Client Pool
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Add <span className="font-medium text-foreground">{candidateName}</span> to a client's talent pool for consideration.
          </DialogDescription>
        </DialogHeader>

        {pushed ? (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <div className="w-14 h-14 rounded-full bg-emerald-500/15 flex items-center justify-center">
              <CheckCircle2 className="w-7 h-7 text-emerald-400" />
            </div>
            <div>
              <p className="font-semibold text-foreground">{candidateName} pushed successfully</p>
              <p className="text-sm text-muted-foreground mt-1">
                Added to <span className="font-medium text-foreground">{pushedClientName}</span>'s talent pool
              </p>
            </div>
            <Button onClick={handleClose} className="mt-2 w-full">Done</Button>
          </div>
        ) : (
          <div className="space-y-5 pt-1">
            {/* Client selector */}
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Select Client
              </label>
              {isLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading clients…
                </div>
              ) : clients.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">No clients found in the system.</p>
              ) : (
                <Select value={selectedClientId} onValueChange={setSelectedClientId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a client…" />
                  </SelectTrigger>
                  <SelectContent>
                    {clients.map(client => (
                      <SelectItem key={client.id} value={client.id}>
                        <div className="flex items-center gap-2">
                          <span>{client.name}</span>
                          {client.industry && (
                            <span className="text-[10px] text-muted-foreground">· {client.industry}</span>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Selected client info */}
            {selectedClient && (
              <div className="flex flex-wrap items-center gap-2 p-3 rounded-lg bg-muted/30 border border-border/40">
                <Building2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span className="text-sm font-medium">{selectedClient.name}</span>
                {selectedClient.industry && (
                  <Badge variant="outline" className="text-[10px]">{selectedClient.industry}</Badge>
                )}
                {selectedClient.clientType && (
                  <Badge variant="outline" className="text-[10px] capitalize">{selectedClient.clientType.replace("_", " ")}</Badge>
                )}
              </div>
            )}

            {/* Optional note */}
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Note <span className="normal-case font-normal text-muted-foreground/70">(optional)</span>
              </label>
              <Textarea
                placeholder="e.g. Strong match for the senior dev role, fast-track review recommended…"
                className="resize-none text-sm"
                rows={3}
                value={note}
                onChange={e => setNote(e.target.value)}
              />
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                className="flex-1 gap-2"
                disabled={!selectedClientId || pushing}
                onClick={handlePush}
              >
                {pushing ? (
                  <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Pushing…</>
                ) : (
                  <><Send className="w-3.5 h-3.5" /> Push to Pool</>
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
