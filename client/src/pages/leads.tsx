import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Search } from "lucide-react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminAuth } from "@/hooks/use-admin-auth";
import { format } from "date-fns";
import type { Lead } from "@shared/schema";

const STATUS_OPTIONS = ["all", "cold", "warm", "hot", "converted", "lost"];

const STATUS_STYLES: Record<string, string> = {
  cold: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  warm: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
  hot: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  converted: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  lost: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_STYLES[status] ?? STATUS_STYLES.cold;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize ${cls}`} data-testid={`badge-status-${status}`}>
      {status}
    </span>
  );
}

export default function Leads() {
  const { isLoading: authLoading, isAuthenticated } = useAdminAuth();
  const [, setLocation] = useLocation();
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const limit = 50;

  const { data, isLoading } = useQuery<{ results: Lead[]; total: number }>({
    queryKey: ["/admin/leads", query, statusFilter, page],
    queryFn: async () => {
      const params = new URLSearchParams({
        q: query,
        page: String(page),
        limit: String(limit),
      });
      if (statusFilter !== "all") params.set("status", statusFilter);
      const res = await fetch(`/admin/leads?${params}`);
      if (!res.ok) throw new Error("Failed to fetch leads");
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
    <AdminLayout title="Leads" subtitle={data ? `${data.total} total leads` : undefined}>
      <div className="space-y-4">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              data-testid="input-leads-search"
              placeholder="Search by name, phone or email..."
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSearch()}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
            <SelectTrigger className="w-40" data-testid="select-lead-status">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map(s => (
                <SelectItem key={s} value={s} data-testid={`option-status-${s}`}>
                  {s === "all" ? "All statuses" : s.charAt(0).toUpperCase() + s.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={handleSearch} data-testid="button-leads-search">Search</Button>
        </div>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Brand / Branch</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Package</TableHead>
                <TableHead>Follow-up</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 8 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : data?.results.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-10 text-muted-foreground">
                    No leads found
                  </TableCell>
                </TableRow>
              ) : (
                data?.results.map(lead => (
                  <TableRow
                    key={lead.id}
                    data-testid={`row-lead-${lead.id}`}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setLocation(`/admin/lead/${lead.id}`)}
                  >
                    <TableCell className="font-medium" data-testid={`text-lead-name-${lead.id}`}>
                      {lead.fullName}
                    </TableCell>
                    <TableCell data-testid={`text-lead-phone-${lead.id}`}>{lead.phone}</TableCell>
                    <TableCell className="text-muted-foreground" data-testid={`text-lead-email-${lead.id}`}>
                      {lead.email ?? "—"}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm font-medium" data-testid={`text-lead-brand-${lead.id}`}>{lead.brandName}</div>
                      <div className="text-xs text-muted-foreground" data-testid={`text-lead-branch-${lead.id}`}>{lead.branchName}</div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={lead.leadStatus} />
                    </TableCell>
                    <TableCell>
                      {lead.interestedPackage ? (
                        <div>
                          <div className="text-sm" data-testid={`text-lead-package-${lead.id}`}>{lead.interestedPackage}</div>
                          {lead.offeredPrice && (
                            <div className="text-xs text-muted-foreground">₹{lead.offeredPrice}</div>
                          )}
                        </div>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground" data-testid={`text-lead-followup-${lead.id}`}>
                      {lead.followUpDate ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground" data-testid={`text-lead-created-${lead.id}`}>
                      {lead.createdAt ? format(new Date(lead.createdAt), "dd MMM yyyy") : "—"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)} data-testid="button-leads-prev">
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} data-testid="button-leads-next">
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
