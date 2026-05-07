import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AlertTriangle, Mail } from "lucide-react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAdminAuth } from "@/hooks/use-admin-auth";
import { queryClient } from "@/lib/queryClient";
import { format } from "date-fns";
import type { BefiterIdWithLinks } from "@shared/schema";

export default function IntakeIssues() {
  const { isLoading: authLoading, isAuthenticated } = useAdminAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [fixing, setFixing] = useState<{ id: string; fullName: string; rejected: string | null } | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const limit = 50;

  const { data, isLoading } = useQuery<{ results: BefiterIdWithLinks[]; total: number }>({
    queryKey: ["/admin/intake-issues", page],
    queryFn: async () => {
      const res = await fetch(`/admin/intake-issues?page=${page}&limit=${limit}`);
      if (!res.ok) throw new Error("Failed to load intake issues");
      return res.json();
    },
    enabled: isAuthenticated,
  });

  const fixMutation = useMutation({
    mutationFn: async ({ id, email }: { id: string; email: string }) => {
      const res = await fetch(`/admin/intake-issues/${id}/fix-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Failed to fix email");
      return body;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/admin/intake-issues"] });
      toast({ title: "Email updated", description: "The identity has been removed from the intake issues queue." });
      setFixing(null);
      setNewEmail("");
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  if (authLoading) return null;

  const totalPages = data ? Math.ceil(data.total / limit) : 1;

  return (
    <AdminLayout title="Intake Issues" subtitle="Records created with invalid or missing email at intake">
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="intake-issues-explanation">
          <AlertTriangle className="w-4 h-4 text-amber-500" />
          These identities were created with a placeholder email because the original value was malformed or missing.
          The original raw value is shown below — confirm the correct address with the member, then save it.
        </div>

        <div className="rounded-lg border border-card-border overflow-hidden" data-testid="intake-issues-table">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Rejected email</TableHead>
                <TableHead>Placeholder</TableHead>
                <TableHead>Created</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(4)].map((_, i) => (
                  <TableRow key={i}>
                    {[...Array(6)].map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : !data?.results.length ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-12 text-muted-foreground" data-testid="intake-issues-empty">
                    No intake issues — every identity has a valid email.
                  </TableCell>
                </TableRow>
              ) : (
                data.results.map((identity) => (
                  <TableRow key={identity.id} className="hover-elevate" data-testid={`row-intake-${identity.id}`}>
                    <TableCell
                      className="font-medium cursor-pointer"
                      onClick={() => setLocation(`/admin/identity/${identity.id}`)}
                    >
                      {identity.fullName}
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-sm">{identity.currentPhone}</TableCell>
                    <TableCell className="text-sm">
                      <span className="font-mono text-amber-700 dark:text-amber-400" data-testid={`text-rejected-${identity.id}`}>
                        {identity.rejectedEmailAtIntake || <span className="italic text-muted-foreground">(missing)</span>}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs font-mono">{identity.email}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {identity.createdAt ? format(new Date(identity.createdAt), "MMM d, yyyy") : "—"}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setFixing({
                            id: identity.id,
                            fullName: identity.fullName,
                            rejected: identity.rejectedEmailAtIntake ?? null,
                          });
                          setNewEmail(identity.rejectedEmailAtIntake ?? "");
                        }}
                        data-testid={`button-fix-email-${identity.id}`}
                      >
                        <Mail className="w-3.5 h-3.5 mr-1.5" />
                        Set email
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {data && totalPages > 1 && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">Page {page} of {totalPages} ({data.total} total)</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)} data-testid="button-prev-page">Previous</Button>
              <Button variant="outline" size="sm" disabled={page === totalPages} onClick={() => setPage(p => p + 1)} data-testid="button-next-page">Next</Button>
            </div>
          </div>
        )}
      </div>

      <Dialog open={!!fixing} onOpenChange={(open) => { if (!open) { setFixing(null); setNewEmail(""); } }}>
        <DialogContent data-testid="modal-fix-email">
          <DialogHeader>
            <DialogTitle>Set verified email</DialogTitle>
            <DialogDescription>
              Replace the placeholder email for <strong>{fixing?.fullName}</strong>.
              {fixing?.rejected ? <> The original rejected value was <code className="font-mono">{fixing.rejected}</code>.</> : null}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="new-email">New email</Label>
            <Input
              id="new-email"
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="member@example.com"
              data-testid="input-fix-email"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setFixing(null); setNewEmail(""); }} data-testid="button-cancel-fix">Cancel</Button>
            <Button
              onClick={() => fixing && fixMutation.mutate({ id: fixing.id, email: newEmail.trim() })}
              disabled={!newEmail.trim() || fixMutation.isPending}
              data-testid="button-confirm-fix"
            >
              {fixMutation.isPending ? "Saving..." : "Save email"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
