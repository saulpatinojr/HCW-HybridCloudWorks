/**
 * The signed-in admin's role, once, for the whole portal (AP-F4, #928).
 *
 * AdminAuthGuard already holds the registry's answer (`adminStatus.role`) by
 * the time it renders anything under /admin; this context hands that answer
 * down so the layout's menu, the dashboard's Explore strip and every RoleGate
 * read the one value the guard checked, instead of each mounting its own
 * useAdminAuth. A second instance of that hook starts at `null`, subscribes
 * to MSAL and re-reads the status cache before it can say anything, which is
 * a menu that renders the viewer's set and then grows — the flicker this
 * avoids — and one more status fetch per consumer while the cache is cold.
 *
 * `null` means no provider is above the caller: a page rendered outside the
 * guard, or a test. The menu treats that as the viewer's set (adminNav.js
 * visibleNavFor) and RoleGate treats it as nothing to say (RoleGate.jsx).
 * In the app it does not happen: the guard renders children only after the
 * registry has answered with a role.
 */
import React, { createContext, useContext } from 'react';

const AdminRoleContext = createContext(null);

/**
 * `value`, as React names a provider's own prop, rather than `role`: a `role`
 * prop on a JSX element reads as an ARIA role to jsx-a11y, which refuses
 * "editor" as one wherever a test writes it as a literal.
 *
 * @param {{ value?: string | null, children: React.ReactNode }} props
 */
export function AdminRoleProvider({ value, children }) {
  return <AdminRoleContext.Provider value={value ?? null}>{children}</AdminRoleContext.Provider>;
}

/** The role the guard verified, lower-cased as the server answers it, or null. */
export function useAdminRole() {
  return useContext(AdminRoleContext);
}
