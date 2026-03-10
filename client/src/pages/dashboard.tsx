import { useQuery } from "@tanstack/react-query";
import { Users, UserPlus, Shield, Link2 } from "lucide-react";
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

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <AppBreakdownChart data={data?.appBreakdown ?? []} isLoading={isLoading} />
        </div>
      </div>
    </AdminLayout>
  );
}
