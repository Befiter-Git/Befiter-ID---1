import { useQuery } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import type { IdentityUpdate } from "@shared/schema";

interface AuditLogTableProps {
  befiterId: string;
}

export function AuditLogTable({ befiterId }: AuditLogTableProps) {
  const { data, isLoading } = useQuery<{ log: IdentityUpdate[] }>({
    queryKey: ["/admin/audit", befiterId],
    queryFn: async () => {
      const res = await fetch(`/admin/audit/${befiterId}`);
      if (!res.ok) throw new Error("Failed to fetch audit log");
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }

  const log = data?.log ?? [];

  if (log.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground" data-testid="audit-empty">
        No audit history found for this identity.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-card-border overflow-hidden" data-testid="audit-log-table">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50">
            <TableHead>Field</TableHead>
            <TableHead>Old Value</TableHead>
            <TableHead>New Value</TableHead>
            <TableHead>Changed By</TableHead>
            <TableHead>Changed At</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {log.map((entry) => (
            <TableRow key={entry.id} data-testid={`audit-row-${entry.id}`}>
              <TableCell className="font-medium text-sm">{entry.fieldChanged}</TableCell>
              <TableCell className="text-sm text-muted-foreground max-w-[150px] truncate">{entry.oldValue ?? "—"}</TableCell>
              <TableCell className="text-sm max-w-[150px] truncate">{entry.newValue ?? "—"}</TableCell>
              <TableCell className="text-sm">
                <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-medium">
                  {entry.appName}
                </span>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {entry.changedAt ? format(new Date(entry.changedAt), "MMM d, yyyy HH:mm") : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
