import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface AppBreakdownChartProps {
  data: { appName: string; count: number }[];
  isLoading?: boolean;
}

export function AppBreakdownChart({ data, isLoading }: AppBreakdownChartProps) {
  return (
    <Card className="p-6 border border-card-border" data-testid="chart-app-breakdown">
      <h3 className="text-sm font-medium text-muted-foreground mb-4">App Links Breakdown</h3>
      {isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : data.length === 0 ? (
        <div className="h-48 flex items-center justify-center">
          <p className="text-muted-foreground text-sm">No app links yet</p>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis dataKey="appName" tick={{ fontSize: 12 }} className="text-muted-foreground" />
            <YAxis tick={{ fontSize: 12 }} className="text-muted-foreground" />
            <Tooltip
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--card-border))",
                borderRadius: "6px",
                fontSize: "12px",
              }}
            />
            <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} name="Links" />
          </BarChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}
