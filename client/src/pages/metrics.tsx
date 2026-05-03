import { useQuery } from "@tanstack/react-query";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { TrendingUp, Target, Activity } from "lucide-react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { StatCard } from "@/components/stats/stat-card";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminAuth } from "@/hooks/use-admin-auth";
import type { MetricsData } from "@/lib/api";

const STATUS_COLORS: Record<string, string> = {
  cold: "#3b82f6",
  warm: "#eab308",
  hot: "#ef4444",
  converted: "#22c55e",
  lost: "#9ca3af",
};

const tooltipStyle = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--card-border))",
  borderRadius: "6px",
  fontSize: "12px",
};

function ChartCard({ title, children, isLoading, testId }: { title: string; children: React.ReactNode; isLoading?: boolean; testId?: string }) {
  return (
    <Card className="p-6 border border-card-border" data-testid={testId}>
      <h3 className="text-sm font-medium text-muted-foreground mb-4">{title}</h3>
      {isLoading ? <Skeleton className="h-56 w-full" /> : children}
    </Card>
  );
}

const fmtDay = (d: string) => {
  const dt = new Date(d + "T00:00:00");
  return `${dt.getDate()}/${dt.getMonth() + 1}`;
};

export default function Metrics() {
  const { isLoading: authLoading, isAuthenticated } = useAdminAuth();

  const { data, isLoading } = useQuery<MetricsData>({
    queryKey: ["/admin/metrics"],
    queryFn: async () => {
      const res = await fetch("/admin/metrics");
      if (!res.ok) throw new Error("Failed to fetch metrics");
      return res.json();
    },
    enabled: isAuthenticated,
  });

  if (authLoading) return null;

  const idsTrend = (data?.identitiesPerDay ?? []).map(r => ({ ...r, label: fmtDay(r.day) }));
  const leadsTrend = (data?.leadsPerDay ?? []).map(r => ({ ...r, label: fmtDay(r.day) }));
  const whTrend = (data?.webhooksPerDay ?? []).map(r => ({ ...r, label: fmtDay(r.day) }));
  const statusData = (data?.leadStatusBreakdown ?? []).map(r => ({
    name: r.status.charAt(0).toUpperCase() + r.status.slice(1),
    value: r.count,
    fill: STATUS_COLORS[r.status] ?? "#9ca3af",
  }));

  return (
    <AdminLayout title="Metrics" subtitle="Trends, conversion, and delivery health">
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard
            title="Lead Conversion Rate"
            value={`${data?.leadConversionRate ?? 0}%`}
            icon={Target}
            description={data ? `${data.leadsConverted} converted of ${data.leadsConverted + data.leadsLost} closed` : "—"}
            isLoading={isLoading}
            testId="stat-conversion-rate"
          />
          <StatCard
            title="Webhook Success Rate"
            value={`${data?.webhookSuccessRate ?? 100}%`}
            icon={Activity}
            description={data ? `${data.webhookTotal} total events` : "—"}
            isLoading={isLoading}
            testId="stat-webhook-success-rate"
          />
          <StatCard
            title="30-Day New Identities"
            value={idsTrend.reduce((s, r) => s + r.count, 0)}
            icon={TrendingUp}
            description="Members registered last 30 days"
            isLoading={isLoading}
            testId="stat-identities-30d"
          />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <ChartCard title="New BeFiter IDs (last 30 days)" isLoading={isLoading} testId="chart-identities-trend">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={idsTrend} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={4} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Line type="monotone" dataKey="count" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} name="New IDs" />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="New Leads (last 30 days)" isLoading={isLoading} testId="chart-leads-trend">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={leadsTrend} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={4} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Line type="monotone" dataKey="count" stroke="#eab308" strokeWidth={2} dot={false} name="New Leads" />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Lead Status Breakdown" isLoading={isLoading} testId="chart-lead-status">
            {statusData.length === 0 ? (
              <div className="h-56 flex items-center justify-center text-sm text-muted-foreground">No leads yet</div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={statusData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
                    {statusData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </ChartCard>

          <ChartCard title="Webhook Deliveries (last 14 days)" isLoading={isLoading} testId="chart-webhooks-trend">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={whTrend} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="success" stackId="a" fill="#22c55e" name="Delivered" radius={[0, 0, 0, 0]} />
                <Bar dataKey="dead" stackId="a" fill="#ef4444" name="Dead" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      </div>
    </AdminLayout>
  );
}
