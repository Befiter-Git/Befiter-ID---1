import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, Copy, Check, AlertCircle } from "lucide-react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAdminAuth } from "@/hooks/use-admin-auth";
import { queryClient } from "@/lib/queryClient";
import { format } from "date-fns";
import type { ApiKeyRecord } from "@/lib/api";

export default function ApiKeys() {
  const { isLoading: authLoading, isAuthenticated } = useAdminAuth();
  const { toast } = useToast();

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newAppName, setNewAppName] = useState("");
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [confirmToggle, setConfirmToggle] = useState<{ id: string; appName: string; currentState: boolean } | null>(null);

  const { data, isLoading } = useQuery<{ keys: ApiKeyRecord[] }>({
    queryKey: ["/admin/api-keys"],
    queryFn: async () => {
      const res = await fetch("/admin/api-keys");
      if (!res.ok) throw new Error("Failed to fetch API keys");
      return res.json();
    },
    enabled: isAuthenticated,
  });

  const createMutation = useMutation({
    mutationFn: async (appName: string) => {
      const res = await fetch("/admin/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appName }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create key");
      }
      return res.json() as Promise<{ key: ApiKeyRecord; rawKey: string }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/admin/api-keys"] });
      setGeneratedKey(data.rawKey);
      setNewAppName("");
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create key", description: err.message, variant: "destructive" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const res = await fetch(`/admin/api-keys/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to update key");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/admin/api-keys"] });
      toast({ title: "API key updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const handleCopy = async () => {
    if (!generatedKey) return;
    await navigator.clipboard.writeText(generatedKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCloseModal = () => {
    setShowCreateModal(false);
    setGeneratedKey(null);
    setNewAppName("");
  };

  if (authLoading) return null;

  return (
    <AdminLayout title="API Keys" subtitle="Manage API keys for connected BeFiter apps">
      <div className="space-y-4">
        <div className="flex justify-end">
          <Button onClick={() => setShowCreateModal(true)} data-testid="button-new-api-key">
            <Plus className="w-4 h-4 mr-2" /> Generate New Key
          </Button>
        </div>

        <div className="rounded-lg border border-card-border overflow-hidden" data-testid="api-keys-table">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>App Name</TableHead>
                <TableHead>Key Preview</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Active</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(3)].map((_, i) => (
                  <TableRow key={i}>
                    {[...Array(5)].map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : !data?.keys.length ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-12 text-muted-foreground" data-testid="api-keys-empty">
                    No API keys yet. Generate one to get started.
                  </TableCell>
                </TableRow>
              ) : (
                data.keys.map((key) => (
                  <TableRow key={key.id} data-testid={`row-api-key-${key.id}`}>
                    <TableCell className="font-medium">{key.appName}</TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {key.keyPrefix}••••••••••
                    </TableCell>
                    <TableCell>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        key.isActive
                          ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                          : "bg-muted text-muted-foreground"
                      }`} data-testid={`status-key-${key.id}`}>
                        {key.isActive ? "Active" : "Inactive"}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {key.createdAt ? format(new Date(key.createdAt), "MMM d, yyyy") : "—"}
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={key.isActive ?? false}
                        onCheckedChange={() => setConfirmToggle({ id: key.id, appName: key.appName, currentState: key.isActive })}
                        disabled={toggleMutation.isPending}
                        data-testid={`toggle-key-${key.id}`}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={showCreateModal} onOpenChange={(open) => { if (!open) handleCloseModal(); }}>
        <DialogContent data-testid="modal-create-key">
          <DialogHeader>
            <DialogTitle>Generate New API Key</DialogTitle>
          </DialogHeader>

          {!generatedKey ? (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="app-name">App Name</Label>
                <Input
                  id="app-name"
                  placeholder="e.g. befiter_store"
                  value={newAppName}
                  onChange={(e) => setNewAppName(e.target.value)}
                  data-testid="input-app-name"
                />
                <p className="text-xs text-muted-foreground">Free text — any value is allowed. Must be unique.</p>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={handleCloseModal} data-testid="button-cancel-create">Cancel</Button>
                <Button
                  onClick={() => createMutation.mutate(newAppName)}
                  disabled={!newAppName.trim() || createMutation.isPending}
                  data-testid="button-generate-key"
                >
                  {createMutation.isPending ? "Generating..." : "Generate"}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-amber-800 dark:text-amber-300">
                  <strong>Save this key now.</strong> You will never see it again after closing this dialog.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Raw API Key</Label>
                <div className="flex gap-2">
                  <Input
                    value={generatedKey}
                    readOnly
                    className="font-mono text-sm"
                    data-testid="text-raw-api-key"
                  />
                  <Button variant="outline" size="icon" onClick={handleCopy} data-testid="button-copy-key">
                    {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
              </div>
              <DialogFooter>
                <Button onClick={handleCloseModal} data-testid="button-done-key">Done — I've saved the key</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmToggle} onOpenChange={() => setConfirmToggle(null)}>
        <AlertDialogContent data-testid="modal-confirm-toggle">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmToggle?.currentState ? "Deactivate" : "Activate"} API Key?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will {confirmToggle?.currentState ? "deactivate" : "activate"} the API key for{" "}
              <strong>{confirmToggle?.appName}</strong>.{" "}
              {confirmToggle?.currentState && "Apps using this key will immediately lose access."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-toggle">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmToggle) {
                  toggleMutation.mutate({ id: confirmToggle.id, isActive: !confirmToggle.currentState });
                  setConfirmToggle(null);
                }
              }}
              data-testid="button-confirm-toggle"
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminLayout>
  );
}
