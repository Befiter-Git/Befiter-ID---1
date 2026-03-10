import { AdminNav } from "./admin-nav";

interface AdminLayoutProps {
  children: React.ReactNode;
  title: string;
  subtitle?: string;
}

export function AdminLayout({ children, title, subtitle }: AdminLayoutProps) {
  return (
    <div className="flex min-h-screen bg-background">
      <AdminNav />
      <main className="flex-1 flex flex-col min-w-0">
        <header className="px-8 py-6 border-b border-border bg-card">
          <h1 className="text-xl font-semibold text-foreground" data-testid="page-title">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p>}
        </header>
        <div className="flex-1 px-8 py-6">
          {children}
        </div>
      </main>
    </div>
  );
}
