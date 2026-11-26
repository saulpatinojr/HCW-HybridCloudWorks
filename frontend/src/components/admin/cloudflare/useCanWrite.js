/**
 * Whether the signed-in admin may change Cloudflare (super_admin, as the
 * server's write routes require). An unknown role (no provider above, which
 * only happens in a test) reads as yes, the same choice RoleGate makes: the
 * server still answers every request on its own.
 */
import { useAdminRole } from '@/hooks/useAdminRole';
import { satisfiesRole } from '@/config/adminNav';

export const WRITE_ROLE = 'super_admin';

export default function useCanWrite() {
  const role = useAdminRole();
  return role === null || satisfiesRole(role, WRITE_ROLE);
}
