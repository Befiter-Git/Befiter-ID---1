import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Search, Trash2 } from "lucide-react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAdminAuth } from "@/hooks/use-admin-auth";
import { queryClient } from "@/lib/queryClient";
import { format } from "date-fns";
import type { BefiterIdWithLinks } from "@shared/schema";

export default function Identities() {
  const { isLoading: authLoading, isAuthenticated } = useAdminAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; fullName: string } | null>(null);
  const limit = 50;

  const { data, isLoading } = useQuery<{ results: BefiterIdWithLinks[]; total: number }>({
    queryKey: ["/admin/identities", query, page],
    queryFn: async () => {
      const params = new URLSearchParams({ q: query, page: String(page), limit: String(limit) });
      const res = await fetch(`/admin/identities?${params}`);
      if (!res.ok) throw new Error("Failed to search");
      return res.json();
    },
    enabled: isAuthenticated,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/admin/identity/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to delete");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/admin/identities"] });
      toast({ title: "Identity deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  if (authLoading) return null;

  const totalPages = data ? Math.ceil(data.total / limit) : 1;

  const handleSearch = () => {
    setQuery(searchInput);
    setPage(1);
  };

  return (
    <AdminLayout title="Identities" subtitle="Search and manage BeFiter member identities">
      <div className="space-y-4">
        <div className="flex gap-2">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search by name, phone, or email..."
              className="pl-9"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              data-testid="input-search-identities"
            />
          </div>
          <Button onClick={handleSearch} data-testid="button-search">Search</Button>
          {query && (
            <Button variant="outline" onClick={() => { setSearchInput(""); setQuery(""); setPage(1); }} data-testid="button-clear-search">
              Clear
            </Button>
          )}
        </div>

        {query && data && (
          <p className="text-sm text-muted-foreground" data-testid="text-search-results">
            {data.total} result{data.total !== 1 ? "s" : ""} for &ldquo;{query}&rdquo;
          </p>
        )}

        <div className="rounded-lg border border-card-border overflow-hidden" data-testid="identities-table">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Apps Linked</TableHead>
                <TableHead>Created</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(6)].map((_, i) => (
                  <TableRow key={i}>
                    {[...Array(6)].map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : !data?.results.length ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-12 text-muted-foreground" data-testid="identities-empty">
                    {query ? "No identities match your search." : "No identities found."}
                  </TableCell>
                </TableRow>
              ) : (
                data.results.map((identity) => (
                  <TableRow
                    key={identity.id}
                    className="cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => setLocation(`/admin/identity/${identity.id}`)}
                    data-testid={`row-identity-${identity.id}`}
                  >
                    <TableCell className="font-medium">{identity.fullName}</TableCell>
                    <TableCell className="text-muted-foreground font-mono text-sm">{identity.currentPhone}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{identity.email}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {identity.appLinks.length === 0 ? (
                          <span className="text-muted-foreground text-sm">—</span>
                        ) : (
                          identity.appLinks.map((link) => (
                            <span key={link.id} className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-medium">
                              {link.appName}
                            </span>
                          ))
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {identity.createdAt ? format(new Date(identity.createdAt), "MMM d, yyyy") : "—"}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        onClick={() => setConfirmDelete({ id: identity.id, fullName: identity.fullName })}
                        disabled={deleteMutation.isPending}
                        data-testid={`button-delete-identity-${identity.id}`}
                      >
                        <Trash2 className="w-4 h-4" />
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
            <p className="text-sm text-muted-foreground">
              Page {page} of {totalPages} ({data.total} total)
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 1}
                onClick={() => setPage(p => p - 1)}
                data-testid="button-prev-page"
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page === totalPages}
                onClick={() => setPage(p => p + 1)}
                data-testid="button-next-page"
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>

      <AlertDialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
        <AlertDialogContent data-testid="modal-confirm-delete-identity">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete BeFiter Identity?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <strong>{confirmDelete?.fullName}</strong>'s BeFiter ID, all linked app records, and their full audit history. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-identity">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirmDelete) {
                  deleteMutation.mutate(confirmDelete.id);
                  setConfirmDelete(null);
                }
              }}
              data-testid="button-confirm-delete-identity"
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminLayout>
  );
}
