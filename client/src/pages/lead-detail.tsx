import { useQuery } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { ArrowLeft, Phone, Mail, MapPin, Tag, IndianRupee, Calendar, Clock } from "lucide-react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminAuth } from "@/hooks/use-admin-auth";
import { format } from "date-fns";
import type { Lead } from "@shared/schema";

const STATUS_STYLES: Record<string, string> = {
  cold: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  warm: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
  hot: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  converted: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  lost: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

function Field({ label, value, icon: Icon, testId }: { label: string; value: React.ReactNode; icon?: any; testId?: string }) {
  return (
    <div className="flex items-start gap-3">
      {Icon && <Icon className="w-4 h-4 mt-1 text-muted-foreground shrink-0" />}
      <div className="flex-1 min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-sm font-medium break-words" data-testid={testId}>{value || "—"}</div>
      </div>
    </div>
  );
}

export default function LeadDetail() {
  const { isLoading: authLoading, isAuthenticated } = useAdminAuth();
  const [, params] = useRoute("/admin/lead/:id");
  const id = params?.id;

  const { data: lead, isLoading, error } = useQuery<Lead>({
    queryKey: ["/admin/lead", id],
    queryFn: async () => {
      const res = await fetch(`/admin/lead/${id}`);
      if (!res.ok) throw new Error("Lead not found");
      return res.json();
    },
    enabled: isAuthenticated && !!id,
  });

  if (authLoading) return null;

  if (isLoading) {
    return (
      <AdminLayout title="Lead Details">
        <Skeleton className="h-64 w-full" />
      </AdminLayout>
    );
  }

  if (error || !lead) {
    return (
      <AdminLayout title="Lead Details">
        <div className="text-center py-12">
          <p className="text-muted-foreground mb-4" data-testid="text-lead-not-found">Lead not found</p>
          <Link href="/admin/leads">
            <Button variant="outline" data-testid="button-back-to-leads">
              <ArrowLeft className="w-4 h-4 mr-2" /> Back to leads
            </Button>
          </Link>
        </div>
      </AdminLayout>
    );
  }

  const statusCls = STATUS_STYLES[lead.leadStatus] ?? STATUS_STYLES.cold;

  return (
    <AdminLayout title={lead.fullName} subtitle={`${lead.brandName} · ${lead.branchName}`}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Link href="/admin/leads">
            <Button variant="ghost" size="sm" data-testid="button-back-leads">
              <ArrowLeft className="w-4 h-4 mr-2" /> Back to leads
            </Button>
          </Link>
          <span className={`inline-flex items-center px-3 py-1 rounded text-xs font-medium capitalize ${statusCls}`} data-testid="badge-lead-status">
            {lead.leadStatus}
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader><CardTitle className="text-base">Contact</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <Field label="Full name" value={lead.fullName} testId="text-detail-name" />
              <Field label="Phone" value={lead.phone} icon={Phone} testId="text-detail-phone" />
              <Field label="Email" value={lead.email} icon={Mail} testId="text-detail-email" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Origin</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <Field label="Brand" value={lead.brandName} icon={MapPin} testId="text-detail-brand" />
              <Field label="Branch" value={lead.branchName} testId="text-detail-branch" />
              <Field label="Source" value={lead.leadSource} icon={Tag} testId="text-detail-source" />
              <Field label="Store lead ID" value={<code className="text-xs bg-muted px-1.5 py-0.5 rounded">{lead.storeLeadId}</code>} testId="text-detail-store-id" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Interest & Pricing</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <Field label="Interested service" value={lead.interestedService} testId="text-detail-service" />
              <Field label="Interested package" value={lead.interestedPackage} testId="text-detail-package" />
              <Field label="Package price" value={lead.packagePrice ? `₹${lead.packagePrice}` : null} icon={IndianRupee} testId="text-detail-package-price" />
              <Field label="Offered price" value={lead.offeredPrice ? `₹${lead.offeredPrice}` : null} icon={IndianRupee} testId="text-detail-offered-price" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Timeline</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <Field label="Visit date" value={lead.visitDate} icon={Calendar} testId="text-detail-visit-date" />
              <Field label="Follow-up date" value={lead.followUpDate} icon={Clock} testId="text-detail-followup-date" />
              <Field label="Created" value={lead.createdAt ? format(new Date(lead.createdAt), "dd MMM yyyy, HH:mm") : null} testId="text-detail-created" />
              <Field label="Last updated" value={lead.updatedAt ? format(new Date(lead.updatedAt), "dd MMM yyyy, HH:mm") : null} testId="text-detail-updated" />
            </CardContent>
          </Card>
        </div>
      </div>
    </AdminLayout>
  );
}
