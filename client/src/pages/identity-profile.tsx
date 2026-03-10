import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { ArrowLeft, Lock, Edit2, Save, X, Trash2 } from "lucide-react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { AuditLogTable } from "@/components/identity/audit-log-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useAdminAuth } from "@/hooks/use-admin-auth";
import { queryClient } from "@/lib/queryClient";
import { format } from "date-fns";
import type { BefiterIdWithLinks } from "@shared/schema";

type EditableSection = "core" | "address" | "personal" | "health" | null;

function ReadOnlyField({ label, value, locked }: { label: string; value?: string | null; locked?: boolean }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground flex items-center gap-1">
        {label}
        {locked && <Lock className="w-3 h-3" />}
      </Label>
      <p className="text-sm font-medium text-foreground min-h-[20px]" data-testid={`field-${label.toLowerCase().replace(/\s+/g, "-")}`}>
        {value || <span className="text-muted-foreground">—</span>}
      </p>
    </div>
  );
}

function PreviousPhonesField({ phones }: { phones?: string[] | null }) {
  return (
    <div className="space-y-1 col-span-2">
      <Label className="text-xs text-muted-foreground flex items-center gap-1">
        Previous Phone Numbers
        <Lock className="w-3 h-3" />
      </Label>
      {!phones || phones.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="field-previous-phones-empty">—</p>
      ) : (
        <div className="flex flex-wrap gap-1.5 mt-1" data-testid="field-previous-phones">
          {phones.map((phone, i) => (
            <span
              key={i}
              className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-xs font-mono"
              data-testid={`prev-phone-${i}`}
            >
              {phone}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function EditableField({ label, name, value, onChange, locked }: {
  label: string;
  name: string;
  value: string;
  onChange: (name: string, value: string) => void;
  locked?: boolean;
}) {
  if (locked) {
    return <ReadOnlyField label={label} value={value} locked />;
  }
  return (
    <div className="space-y-1">
      <Label htmlFor={name} className="text-xs text-muted-foreground">{label}</Label>
      <Input
        id={name}
        value={value}
        onChange={(e) => onChange(name, e.target.value)}
        className="h-8 text-sm"
        data-testid={`input-${name}`}
      />
    </div>
  );
}

interface SectionCardProps {
  title: string;
  sectionKey: EditableSection;
  editing: EditableSection;
  onEdit: (key: EditableSection) => void;
  onSave: () => void;
  onCancel: () => void;
  isSaving: boolean;
  children: React.ReactNode;
}

function SectionCard({ title, sectionKey, editing, onEdit, onSave, onCancel, isSaving, children }: SectionCardProps) {
  const isEditing = editing === sectionKey;
  return (
    <Card className="p-5 border border-card-border" data-testid={`section-${sectionKey}`}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {!isEditing ? (
          <Button variant="ghost" size="sm" onClick={() => onEdit(sectionKey)} data-testid={`button-edit-${sectionKey}`}>
            <Edit2 className="w-3.5 h-3.5 mr-1" /> Edit
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button size="sm" onClick={onSave} disabled={isSaving} data-testid={`button-save-${sectionKey}`}>
              <Save className="w-3.5 h-3.5 mr-1" /> {isSaving ? "Saving..." : "Save"}
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancel} data-testid={`button-cancel-${sectionKey}`}>
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">{children}</div>
    </Card>
  );
}

export default function IdentityProfile() {
  const { befiterId } = useParams<{ befiterId: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { isLoading: authLoading, isAuthenticated } = useAdminAuth();

  const [editing, setEditing] = useState<EditableSection>(null);
  const [editData, setEditData] = useState<Record<string, string>>({});
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const { data, isLoading } = useQuery<{ identity: BefiterIdWithLinks }>({
    queryKey: ["/admin/identity", befiterId],
    queryFn: async () => {
      const res = await fetch(`/admin/identity/${befiterId}`);
      if (!res.ok) throw new Error("Failed to fetch identity");
      return res.json();
    },
    enabled: isAuthenticated && !!befiterId,
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/admin/identity/${befiterId}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Delete failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/admin/identities"] });
      toast({ title: "Identity deleted" });
      setLocation("/admin/identities");
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (body: Record<string, string>) => {
      const res = await fetch(`/admin/identity/${befiterId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Update failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/admin/identity", befiterId] });
      setEditing(null);
      setEditData({});
      toast({ title: "Identity updated successfully" });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const identity = data?.identity;

  const handleEdit = (section: EditableSection) => {
    if (!identity) return;
    const snapshot: Record<string, string> = {};
    const allFields = { ...identity } as Record<string, unknown>;
    for (const [k, v] of Object.entries(allFields)) {
      snapshot[k] = v == null ? "" : String(v);
    }
    setEditData(snapshot);
    setEditing(section);
  };

  const handleChange = (name: string, value: string) => {
    setEditData(prev => ({ ...prev, [name]: value }));
  };

  const handleSave = () => {
    updateMutation.mutate(editData);
  };

  const handleCancel = () => {
    setEditing(null);
    setEditData({});
  };

  const val = (field: string): string => {
    if (editing && editData[field] !== undefined) return editData[field];
    const v = (identity as Record<string, unknown> | undefined)?.[field];
    return v == null ? "" : String(v);
  };

  if (authLoading || isLoading) {
    return (
      <AdminLayout title="Identity Profile">
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-40 w-full" />)}
        </div>
      </AdminLayout>
    );
  }

  if (!identity) {
    return (
      <AdminLayout title="Identity Not Found">
        <p className="text-muted-foreground">This identity could not be found.</p>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title="Identity Profile" subtitle={identity.fullName}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => setLocation("/admin/identities")} data-testid="button-back">
              <ArrowLeft className="w-4 h-4 mr-1" /> Back
            </Button>
            <div className="flex items-center gap-2 ml-2">
              <span className="text-xs text-muted-foreground font-mono" data-testid="text-befiter-id">{identity.id}</span>
              <Badge variant="secondary" data-testid="badge-identity-tag">{identity.identityTag}</Badge>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={() => setShowDeleteConfirm(true)}
            disabled={deleteMutation.isPending}
            data-testid="button-delete-identity"
          >
            <Trash2 className="w-4 h-4 mr-1" />
            {deleteMutation.isPending ? "Deleting..." : "Delete Identity"}
          </Button>
        </div>

        <Tabs defaultValue="profile" data-testid="tabs-profile">
          <TabsList>
            <TabsTrigger value="profile" data-testid="tab-profile">Profile</TabsTrigger>
            <TabsTrigger value="audit" data-testid="tab-audit">Audit History</TabsTrigger>
          </TabsList>

          <TabsContent value="profile" className="space-y-4 mt-4">
            <SectionCard
              title="Core Identity"
              sectionKey="core"
              editing={editing}
              onEdit={handleEdit}
              onSave={handleSave}
              onCancel={handleCancel}
              isSaving={updateMutation.isPending}
            >
              {editing === "core" ? (
                <>
                  <EditableField label="Full Name" name="fullName" value={val("fullName")} onChange={handleChange} />
                  <EditableField label="Current Phone" name="currentPhone" value={val("currentPhone")} onChange={handleChange} locked />
                  <EditableField label="Email" name="email" value={val("email")} onChange={handleChange} locked />
                  <EditableField label="Date of Birth" name="dateOfBirth" value={val("dateOfBirth")} onChange={handleChange} />
                  <EditableField label="Gender" name="gender" value={val("gender")} onChange={handleChange} />
                  <EditableField label="Profile Photo URL" name="profilePhoto" value={val("profilePhoto")} onChange={handleChange} />
                  <PreviousPhonesField phones={identity.previousPhones} />
                </>
              ) : (
                <>
                  <ReadOnlyField label="Full Name" value={identity.fullName} />
                  <ReadOnlyField label="Current Phone" value={identity.currentPhone} locked />
                  <ReadOnlyField label="Email" value={identity.email} locked />
                  <ReadOnlyField label="Date of Birth" value={identity.dateOfBirth ?? undefined} />
                  <ReadOnlyField label="Gender" value={identity.gender ?? undefined} />
                  <ReadOnlyField label="Profile Photo" value={identity.profilePhoto ?? undefined} />
                  <PreviousPhonesField phones={identity.previousPhones} />
                </>
              )}
            </SectionCard>

            <SectionCard
              title="Address"
              sectionKey="address"
              editing={editing}
              onEdit={handleEdit}
              onSave={handleSave}
              onCancel={handleCancel}
              isSaving={updateMutation.isPending}
            >
              {(["country", "state", "city", "pincode", "locality"] as const).map((field) => (
                editing === "address" ? (
                  <EditableField key={field} label={field.charAt(0).toUpperCase() + field.slice(1)} name={field} value={val(field)} onChange={handleChange} />
                ) : (
                  <ReadOnlyField key={field} label={field.charAt(0).toUpperCase() + field.slice(1)} value={(identity as Record<string, unknown>)[field] as string | null} />
                )
              ))}
            </SectionCard>

            <SectionCard
              title="Personal Details"
              sectionKey="personal"
              editing={editing}
              onEdit={handleEdit}
              onSave={handleSave}
              onCancel={handleCancel}
              isSaving={updateMutation.isPending}
            >
              {editing === "personal" ? (
                <>
                  <EditableField label="Occupation" name="occupation" value={val("occupation")} onChange={handleChange} />
                  <EditableField label="Marital Status" name="maritalStatus" value={val("maritalStatus")} onChange={handleChange} />
                  <EditableField label="Emergency Contact Name" name="emergencyContactName" value={val("emergencyContactName")} onChange={handleChange} />
                  <EditableField label="Emergency Contact Phone" name="emergencyContactPhone" value={val("emergencyContactPhone")} onChange={handleChange} />
                  <EditableField label="Language Preference" name="languagePreference" value={val("languagePreference")} onChange={handleChange} />
                </>
              ) : (
                <>
                  <ReadOnlyField label="Occupation" value={identity.occupation ?? undefined} />
                  <ReadOnlyField label="Marital Status" value={identity.maritalStatus ?? undefined} />
                  <ReadOnlyField label="Emergency Contact Name" value={identity.emergencyContactName ?? undefined} />
                  <ReadOnlyField label="Emergency Contact Phone" value={identity.emergencyContactPhone ?? undefined} />
                  <ReadOnlyField label="Language Preference" value={identity.languagePreference ?? undefined} />
                </>
              )}
            </SectionCard>

            <SectionCard
              title="Health Profile"
              sectionKey="health"
              editing={editing}
              onEdit={handleEdit}
              onSave={handleSave}
              onCancel={handleCancel}
              isSaving={updateMutation.isPending}
            >
              {editing === "health" ? (
                <>
                  <EditableField label="Height (cm)" name="height" value={val("height")} onChange={handleChange} />
                  <EditableField label="Weight (kg)" name="weight" value={val("weight")} onChange={handleChange} />
                  <EditableField label="Blood Group" name="bloodGroup" value={val("bloodGroup")} onChange={handleChange} />
                  <EditableField label="Medical History" name="medicalHistory" value={val("medicalHistory")} onChange={handleChange} />
                </>
              ) : (
                <>
                  <ReadOnlyField label="Height (cm)" value={identity.height ? String(identity.height) : undefined} />
                  <ReadOnlyField label="Weight (kg)" value={identity.weight ? String(identity.weight) : undefined} />
                  <ReadOnlyField label="Blood Group" value={identity.bloodGroup ?? undefined} />
                  <ReadOnlyField label="Medical History" value={identity.medicalHistory ?? undefined} />
                </>
              )}
            </SectionCard>

            <Card className="p-5 border border-card-border" data-testid="section-app-links">
              <h3 className="text-sm font-semibold text-foreground mb-4">App Links</h3>
              {identity.appLinks.length === 0 ? (
                <p className="text-sm text-muted-foreground">No apps linked yet.</p>
              ) : (
                <div className="space-y-2">
                  {identity.appLinks.map((link) => (
                    <div key={link.id} className="flex items-center justify-between py-2 border-b border-border last:border-0" data-testid={`app-link-${link.id}`}>
                      <div>
                        <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-medium">{link.appName}</span>
                        <p className="text-xs text-muted-foreground mt-1 font-mono">User ID: {link.appUserId}</p>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {link.linkedAt ? format(new Date(link.linkedAt), "MMM d, yyyy") : "—"}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="audit" className="mt-4">
            <AuditLogTable befiterId={befiterId!} />
          </TabsContent>
        </Tabs>
      </div>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent data-testid="modal-confirm-delete-identity">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete BeFiter Identity?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <strong>{identity.fullName}</strong>'s BeFiter ID, all linked app records, and their full audit history. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-identity">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                deleteMutation.mutate();
                setShowDeleteConfirm(false);
              }}
              data-testid="button-confirm-delete-identity"
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminLayout>
  );
}
