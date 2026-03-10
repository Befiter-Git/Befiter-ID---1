import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Search } from "lucide-react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminAuth } from "@/hooks/use-admin-auth";
import { format } from "date-fns";
import type { BefiterIdWithLinks } from "@shared/schema";

export default function Identities() {
  const { isLoading: authLoading, isAuthenticated } = useAdminAuth();
  const [, setLocation] = useLocation();
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
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
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(6)].map((_, i) => (
                  <TableRow key={i}>
                    {[...Array(5)].map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : !data?.results.length ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-12 text-muted-foreground" data-testid="identities-empty">
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
                    <TableCell className="text-muted-foreground font-mono text-sm">{identity.phone}</TableCell>
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
    </AdminLayout>
  );
}
