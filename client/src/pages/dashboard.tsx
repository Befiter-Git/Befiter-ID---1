import { useQuery } from "@tanstack/react-query";
import { Users, UserPlus, Shield, Link2, UserSearch, Flame, CalendarClock, Send, AlertTriangle, CheckCircle2 } from "lucide-react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { StatCard } from "@/components/stats/stat-card";
import { AppBreakdownChart } from "@/components/stats/app-breakdown-chart";
import { useAdminAuth } from "@/hooks/use-admin-auth";
import { Skeleton } from "@/components/ui/skeleton";
import type { DashboardStats } from "@/lib/api";

export default function Dashboard() {
  const { isLoading: authLoading, isAuthenticated } = useAdminAuth();

  const { data, isLoading } = useQuery<DashboardStats>({
    queryKey: ["/admin/stats"],
    queryFn: async () => {
      const res = await fetch("/admin/stats");
      if (!res.ok) throw new Error("Failed to fetch stats");
      return res.json();
    },
    enabled: isAuthenticated,
  });

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }

  return (
    <AdminLayout title="Dashboard" subtitle="Overview of all BeFiter identities">
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <StatCard
            title="Total BeFiter IDs"
            value={data?.totalIds ?? 0}
            icon={Users}
            description="All registered identities"
            isLoading={isLoading}
            testId="stat-total-ids"
          />
          <StatCard
            title="Created This Month"
            value={data?.thisMonth ?? 0}
            icon={UserPlus}
            description="New identities this month"
            isLoading={isLoading}
            testId="stat-this-month"
          />
          <StatCard
            title="App Links"
            value={data?.appBreakdown.reduce((sum, a) => sum + a.count, 0) ?? 0}
            icon={Link2}
            description="Total cross-app connections"
            isLoading={isLoading}
            testId="stat-app-links"
          />
          <StatCard
            title="Duplicates Prevented"
            value={data?.duplicatePrevention ?? 0}
            icon={Shield}
            description="Lookups that found existing records"
            isLoading={isLoading}
            testId="stat-duplicates-prevented"
          />
        </div>

        <div>
          <h2 className="text-sm font-semibold text-muted-foreground mb-3">Leads</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <StatCard
              title="Total Leads"
              value={data?.leads.total ?? 0}
              icon={UserSearch}
              description="All leads in the system"
              isLoading={isLoading}
              testId="stat-total-leads"
            />
            <StatCard
              title="Leads This Month"
              value={data?.leads.thisMonth ?? 0}
              icon={UserPlus}
              description="New leads created this month"
              isLoading={isLoading}
              testId="stat-leads-this-month"
            />
            <StatCard
              title="Hot Leads"
              value={data?.leads.byStatus.find(s => s.status === "hot")?.count ?? 0}
              icon={Flame}
              description="Currently marked as hot"
              isLoading={isLoading}
              testId="stat-hot-leads"
            />
            <StatCard
              title="Follow-ups Due"
              value={data?.leads.followUpsDue ?? 0}
              icon={CalendarClock}
              description="Open leads with follow-up date passed"
              isLoading={isLoading}
              testId="stat-followups-due"
            />
          </div>
        </div>

        <div>
          <h2 className="text-sm font-semibold text-muted-foreground mb-3">Outbound Webhooks</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatCard
              title="Pending"
              value={data?.webhooks.pending ?? 0}
              icon={Send}
              description="Queued for delivery or retry"
              isLoading={isLoading}
              testId="stat-webhooks-pending"
            />
            <StatCard
              title="Dead"
              value={data?.webhooks.dead ?? 0}
              icon={AlertTriangle}
              description="Failed all retries — needs attention"
              isLoading={isLoading}
              testId="stat-webhooks-dead"
            />
            <StatCard
              title="Delivered (24h)"
              value={data?.webhooks.deliveredLast24h ?? 0}
              icon={CheckCircle2}
              description="Successfully sent in last 24 hours"
              isLoading={isLoading}
              testId="stat-webhooks-delivered"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <AppBreakdownChart data={data?.appBreakdown ?? []} isLoading={isLoading} />
        </div>
      </div>
    </AdminLayout>
  );
}
