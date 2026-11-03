/**
 * The summary as the server answers it before Azure and the AI ledger have
 * ever been read, and when Azure cannot be read at all: generated from the
 * real buildSummary (functions/src/lib/cost/snapshot.js) with an empty
 * ledger, then given `ai.monthToDate: null`, which is what the server
 * deployed on 2026-11-01 sent. That answer broke every tab on 2026-11-02
 * ("Cannot read properties of null (reading 'monthToDate')"), so these are
 * what the page must draw without the figures a reading fills in.
 */

export const NEVER_READ = Object.freeze({
  ok: true,
  readAt: null,
  stale: true,
  currency: 'USD',
  period: {
    month: '2026-11',
    start: '2026-11-01',
    end: '2026-11-30',
    today: '2026-11-02',
    daysElapsed: 2,
    daysInMonth: 30,
  },
  azure: {
    available: false,
    neverRead: true,
    reason: 'The Azure figures have not been read yet.',
    scopes: [],
    totals: null,
  },
  ai: {
    previousMonth: null,
    providers: [],
    monthToDate: null,
    budgetUsd: null,
  },
  services: {
    count: 0,
    monthlyEquivalent: 0,
    annualEquivalent: 0,
    byCategory: [],
    upcoming: [],
    overdue: [],
    items: [],
  },
  signals: [
    {
      id: 'data:never-read',
      severity: 'info',
      area: 'data',
      title: 'The cost figures have not been read yet',
      detail: 'Press Refresh on the Cost page, or wait for the hourly watch to read them.',
      href: '/admin/cost?tab=overview',
    },
  ],
  sources: [
    {
      id: 'services',
      ok: true,
      error: null,
      readAt: '2026-11-02T00:30:00.000Z',
    },
  ],
  history: [],
  settings: {
    aiMonthlyBudgetUsd: null,
    renewalLeadDays: 7,
    telegram: true,
    monthlyDigest: true,
    refreshHours: 6,
  },
});

export const AZURE_UNREADABLE = Object.freeze({
  ok: true,
  readAt: '2026-11-02T00:25:00.000Z',
  stale: false,
  currency: 'USD',
  period: {
    month: '2026-11',
    start: '2026-11-01',
    end: '2026-11-30',
    today: '2026-11-02',
    daysElapsed: 2,
    daysInMonth: 30,
  },
  azure: {
    available: false,
    reason: 'COST_SCOPES is not set, so this process knows no Azure scope to read.',
    scopes: [],
    totals: null,
  },
  ai: {
    previousMonth: null,
    providers: [],
    monthToDate: null,
    budgetUsd: null,
  },
  services: {
    count: 0,
    monthlyEquivalent: 0,
    annualEquivalent: 0,
    byCategory: [],
    upcoming: [],
    overdue: [],
    items: [],
  },
  signals: [
    {
      id: 'azure:unavailable',
      severity: 'warning',
      area: 'data',
      title: 'Azure costs could not be read',
      detail: 'COST_SCOPES is not set, so this process knows no Azure scope to read.',
      href: '/admin/cost?tab=azure',
    },
  ],
  sources: [
    {
      id: 'azure',
      ok: false,
      error: 'COST_SCOPES is not set, so this process knows no Azure scope to read.',
      readAt: '2026-11-02T00:25:00.000Z',
    },
    {
      id: 'services',
      ok: true,
      error: null,
      readAt: '2026-11-02T00:30:00.000Z',
    },
  ],
  history: [],
  settings: {
    aiMonthlyBudgetUsd: null,
    renewalLeadDays: 7,
    telegram: true,
    monthlyDigest: true,
    refreshHours: 6,
  },
});
