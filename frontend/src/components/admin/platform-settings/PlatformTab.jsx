/**
 * PlatformTab.jsx — Platform administration & admin lifecycle (AP-B5, #940).
 *
 * Provides:
 * - Listing of all registered administrators from the authoritative Cosmos admins container.
 * - Changing admin roles behind a confirmation dialog (ConfirmModal).
 * - Activating / deactivating admins behind a confirmation dialog.
 * - Guard against demoting or deactivating the last active super_admin.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import ConfirmModal from '@/components/admin/ConfirmModal';
import { getJSON, sendJSON } from '@/lib/api';
import { useAuthReady } from '@/hooks/useAuthReady';
import { Shield, UserX, UserCheck, AlertTriangle, RefreshCw, Loader2 } from 'lucide-react';

export const ADMINS_ROUTE = 'cms/admins';
export const AVAILABLE_ROLES = ['viewer', 'editor', 'publisher', 'super_admin'];

export default function PlatformTab() {
  const { authReady } = useAuthReady();
  const [admins, setAdmins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Confirmation state
  const [confirmTarget, setConfirmTarget] = useState(null); // { type: 'role' | 'status', admin, newRole?, newActive? }

  const loadAdmins = useCallback(async () => {
    if (!authReady) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getJSON(ADMINS_ROUTE);
      setAdmins(data?.admins || []);
    } catch (err) {
      setError(err?.message || 'Failed to load admins');
    } finally {
      setLoading(false);
    }
  }, [authReady]);

  useEffect(() => {
    loadAdmins();
  }, [loadAdmins]);

  const handleRoleChangeSelect = (admin, newRole) => {
    if (newRole === admin.role) return;
    setActionError(null);
    setConfirmTarget({
      type: 'role',
      admin,
      newRole,
    });
  };

  const handleStatusToggle = (admin) => {
    setActionError(null);
    setConfirmTarget({
      type: 'status',
      admin,
      newActive: !admin.active,
    });
  };

  const handleConfirmAction = async () => {
    if (!confirmTarget) return;
    setBusy(true);
    setActionError(null);

    const { type, admin, newRole, newActive } = confirmTarget;
    try {
      if (type === 'role') {
        await sendJSON(`${ADMINS_ROUTE}/${encodeURIComponent(admin.id)}`, 'PATCH', {
          role: newRole,
          reason: `Role changed to ${newRole} from Platform tab`,
        });
      } else if (type === 'status') {
        await sendJSON(`${ADMINS_ROUTE}/${encodeURIComponent(admin.id)}`, 'PATCH', {
          active: newActive,
          reason: `${newActive ? 'Activated' : 'Deactivated'} from Platform tab`,
        });
      }
      setConfirmTarget(null);
      await loadAdmins();
    } catch (err) {
      setActionError(err?.message || 'Operation failed');
    } finally {
      setBusy(false);
    }
  };

  const roleBadgeVariant = (role) => {
    switch (role) {
      case 'super_admin':
        return 'destructive';
      case 'publisher':
        return 'default';
      case 'editor':
        return 'secondary';
      default:
        return 'outline';
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between pb-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Shield className="h-5 w-5 text-primary" aria-hidden="true" />
              Administrators & Platform Access
            </CardTitle>
            <CardDescription className="mt-1">
              Authoritative list of administrators configured for the platform. Role changes and deactivations
              are protected by super-admin authorization and require explicit confirmation.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={loadAdmins}
            disabled={loading}
            aria-label="Refresh administrators"
            className="flex items-center gap-1.5"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="mb-4 rounded-md border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive flex items-center gap-2" role="alert">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {actionError && (
            <div className="mb-4 rounded-md border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive flex items-center gap-2" role="alert">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{actionError}</span>
            </div>
          )}

          {loading ? (
            <div className="flex h-40 items-center justify-center text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin mr-2" />
              Loading administrators...
            </div>
          ) : admins.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No administrators found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm" aria-label="Administrators">
                <thead className="border-b border-border text-xs uppercase text-muted-foreground">
                  <tr>
                    <th scope="col" className="py-3 px-4 font-medium">Administrator</th>
                    <th scope="col" className="py-3 px-4 font-medium">Role</th>
                    <th scope="col" className="py-3 px-4 font-medium">Status</th>
                    <th scope="col" className="py-3 px-4 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {admins.map((admin) => (
                    <tr key={admin.id} className="hover:bg-muted/30">
                      <td className="py-3 px-4">
                        <div className="font-medium text-foreground">{admin.email || admin.id}</div>
                        <div className="text-xs text-muted-foreground font-mono">{admin.id}</div>
                      </td>
                      <td className="py-3 px-4">
                        <Badge variant={roleBadgeVariant(admin.role)} className="capitalize">
                          {admin.role?.replace('_', ' ')}
                        </Badge>
                      </td>
                      <td className="py-3 px-4">
                        {admin.active ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                            <UserCheck className="h-3.5 w-3.5" /> Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                            <UserX className="h-3.5 w-3.5" /> Inactive
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <label htmlFor={`role-select-${admin.id}`} className="sr-only">
                            Change role for {admin.email || admin.id}
                          </label>
                          <select
                            id={`role-select-${admin.id}`}
                            value={admin.role}
                            onChange={(e) => handleRoleChangeSelect(admin, e.target.value)}
                            aria-label={`Change role for ${admin.email || admin.id}`}
                            className="h-8 rounded-md border border-input bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            {AVAILABLE_ROLES.map((r) => (
                              <option key={r} value={r}>
                                {r.replace('_', ' ')}
                              </option>
                            ))}
                          </select>

                          <Button
                            variant={admin.active ? 'ghost' : 'outline'}
                            size="sm"
                            className="h-8 px-2 text-xs"
                            onClick={() => handleStatusToggle(admin)}
                            aria-label={admin.active ? `Deactivate ${admin.email || admin.id}` : `Activate ${admin.email || admin.id}`}
                          >
                            {admin.active ? 'Deactivate' : 'Activate'}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Confirmation modal for role change or status toggle */}
      <ConfirmModal
        open={confirmTarget !== null}
        busy={busy}
        title={
          confirmTarget?.type === 'role'
            ? 'Change Administrator Role'
            : confirmTarget?.newActive
            ? 'Activate Administrator'
            : 'Deactivate Administrator'
        }
        description={
          confirmTarget?.type === 'role'
            ? `Are you sure you want to change the role of ${confirmTarget?.admin?.email || confirmTarget?.admin?.id} from "${confirmTarget?.admin?.role?.replace('_', ' ')}" to "${confirmTarget?.newRole?.replace('_', ' ')}"?`
            : confirmTarget?.newActive
            ? `Are you sure you want to activate ${confirmTarget?.admin?.email || confirmTarget?.admin?.id}? They will regain admin access.`
            : `Are you sure you want to deactivate ${confirmTarget?.admin?.email || confirmTarget?.admin?.id}? They will lose admin access immediately.`
        }
        confirmLabel={
          confirmTarget?.type === 'role'
            ? 'Change Role'
            : confirmTarget?.newActive
            ? 'Activate'
            : 'Deactivate'
        }
        destructive={confirmTarget?.type === 'status' && !confirmTarget?.newActive}
        onConfirm={handleConfirmAction}
        onCancel={() => {
          if (!busy) setConfirmTarget(null);
        }}
      />
    </div>
  );
}
