/**
 * Modern Admin Portal Configuration (v2)
 *
 * BREAKING CHANGES from previous version:
 * - NO more VITE_ADMIN_EMAILS environment variable
 * - NO more VITE_ADMIN_UIDS environment variable
 * - NO more frontend allowlists
 * - Admin status fetched dynamically from backend
 *
 * This makes it impossible to hardcode, expose, or manually maintain admin lists.
 */

// Admin Role Definitions (read-only mirror of backend)
export const ADMIN_ROLES = {
  VIEWER: { level: 1, name: 'viewer', description: 'View-only access' },
  EDITOR: { level: 2, name: 'editor', description: 'Can edit and review content' },
  PUBLISHER: { level: 3, name: 'publisher', description: 'Can publish content' },
  SUPER_ADMIN: { level: 4, name: 'super_admin', description: 'Full access' },
};

// Admin Permissions (read-only mirror of backend)
export const PERMISSIONS = {
  viewer: ['read:content', 'read:dashboard'],
  editor: ['read:content', 'read:dashboard', 'write:content', 'review:content'],
  publisher: [
    'read:content',
    'read:dashboard',
    'write:content',
    'review:content',
    'publish:content',
  ],
  super_admin: [
    'read:content',
    'read:dashboard',
    'write:content',
    'review:content',
    'publish:content',
    'manage:admins',
  ],
};

// Admin Routes (UI navigation)
export const ADMIN_ROUTES = {
  DASHBOARD: '/admin',
  QUEUE: '/admin/review-queue',
  REVIEW: '/admin/review-queue/:id',
  EDITOR: '/admin/editor/:id',
  PUBLISHED: '/admin/publish',
  LIVE_PAGES: '/admin/live-pages',
  CALENDAR: '/admin/calendar',
  SUBMIT: '/admin/new-content',
  // Amplify integrations
  RECORDING_HUB: '/admin/recording-hub',
  SOCIAL_HUB: '/admin/social-hub',
  LINKIE: '/admin/linkie-hub',
  MAILING_LIST: '/admin/newsletter-hub',
  // Platform
  HEALTH: '/admin/health',
  INTEGRATIONS: '/admin/integrations',
  LABS: '/admin/labs',
};

// ============================================================================
// ADMIN STATUS (DYNAMIC)
// ============================================================================

/**
 * Cached admin status (updated on login and periodically)
 * This gets populated by getCurrentAdminStatus() and useAdminAuth() hook
 */
let cachedAdminStatus = {
  isAdmin: false,
  uid: null,
  email: null,
  role: null,
  permissions: [],
  active: false,
};

export function getCachedAdminStatus() {
  return { ...cachedAdminStatus };
}

export function setCachedAdminStatus(status) {
  cachedAdminStatus = { ...status };
}

// ============================================================================
// PERMISSION CHECKING
// ============================================================================

/**
 * Check if current user has a permission.
 * Used for dynamic UX gating.
 */
export function hasPermission(permission) {
  if (!cachedAdminStatus.permissions || !Array.isArray(cachedAdminStatus.permissions)) {
    return false;
  }
  return cachedAdminStatus.permissions.includes(permission);
}

/**
 * Check if user has a required role level.
 * Respects role hierarchy.
 */
export function hasRole(requiredRole) {
  const userRoleLevel = ADMIN_ROLES[cachedAdminStatus.role?.toUpperCase()]?.level || 0;
  const requiredLevel = ADMIN_ROLES[requiredRole?.toUpperCase()]?.level || 999;
  return userRoleLevel >= requiredLevel;
}

/**
 * Check if user is an authorized admin (any level).
 */
export function isAuthorizedAdmin() {
  return cachedAdminStatus.isAdmin === true && cachedAdminStatus.active === true;
}

/**
 * Check if user is super admin (full permissions).
 */
export function isSuperAdmin() {
  return cachedAdminStatus.role === 'super_admin';
}

// ============================================================================
// FRONTEND GUARD UTILITIES
// ============================================================================

/**
 * Get admin status for UI display.
 * Called by components to show current user's admin role.
 */
export function getAdminDisplayInfo() {
  if (!cachedAdminStatus.isAdmin) {
    return null;
  }

  return {
    email: cachedAdminStatus.email,
    role: cachedAdminStatus.role,
    roleDisplay: cachedAdminStatus.role?.charAt(0).toUpperCase() + cachedAdminStatus.role?.slice(1),
    permissions: cachedAdminStatus.permissions,
  };
}

/**
 * List all possible roles (for admin management UI).
 */
export function getAvailableRoles() {
  return Object.entries(ADMIN_ROLES).map(([key, val]) => ({
    id: val.name,
    name: key,
    level: val.level,
    description: val.description,
  }));
}
