import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import AIEngineUsageTab, { labelForSource, SOURCE_LABELS } from './AIEngineUsageTab';
import { aiEngine } from '@/lib/aiEngine';

vi.mock('@/lib/aiEngine', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    aiEngine: {
      ...actual.aiEngine,
      getUsageRecords: vi.fn(),
      getAiFeatures: vi.fn(),
    },
  };
});

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children }) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => <div data-testid="bar" />,
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: () => <div data-testid="y-axis" />,
  CartesianGrid: () => <div data-testid="cartesian-grid" />,
  Tooltip: () => <div data-testid="tooltip" />,
}));

describe('AIEngineUsageTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('labelForSource', () => {
    it('returns predefined human label when found in SOURCE_LABELS', () => {
      expect(labelForSource('admin')).toBe(SOURCE_LABELS.admin);
      expect(labelForSource('images:cover')).toBe(SOURCE_LABELS['images:cover']);
    });

    it('formats ai: prefixed features using catalogue or fallback slug', () => {
      const catalogue = {
        summarize: { label: 'Summary Generation' },
      };
      expect(labelForSource('ai:summarize', catalogue)).toBe('AI — Summary Generation');
      expect(labelForSource('ai:unknown_feat', catalogue)).toBe('AI — unknown_feat');
    });

    it('falls back to raw source string when not recognized', () => {
      expect(labelForSource('custom-unknown-source')).toBe('custom-unknown-source');
    });
  });

  describe('component rendering', () => {
    it('shows loading state initially', () => {
      aiEngine.getUsageRecords.mockReturnValue(new Promise(() => {}));
      aiEngine.getAiFeatures.mockReturnValue(new Promise(() => {}));

      const { container } = render(<AIEngineUsageTab />);
      expect(container.querySelector('.animate-spin')).toBeInTheDocument();
    });

    it('shows error message if usage fetch fails', async () => {
      aiEngine.getUsageRecords.mockRejectedValue(new Error('Permission denied'));
      aiEngine.getAiFeatures.mockResolvedValue({ catalogue: {} });

      render(<AIEngineUsageTab />);

      await waitFor(() => {
        expect(screen.getByText('Usage could not be read')).toBeInTheDocument();
        expect(screen.getByText('Permission denied')).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    });

    it('renders empty state when no records are returned', async () => {
      aiEngine.getUsageRecords.mockResolvedValue([]);
      aiEngine.getAiFeatures.mockResolvedValue({ catalogue: {} });

      render(<AIEngineUsageTab />);

      await waitFor(() => {
        expect(screen.getByText('No usage logged yet')).toBeInTheDocument();
      });
    });

    it('renders usage statistics and table when records exist', async () => {
      aiEngine.getUsageRecords.mockResolvedValue([
        {
          id: 'rec-1',
          source: 'admin',
          provider: 'google',
          model: 'gemini-1.5-pro',
          totalTokens: 150,
          estimatedCostUsd: 0.002,
          timestamp: new Date().toISOString(),
        },
      ]);
      aiEngine.getAiFeatures.mockResolvedValue({ catalogue: {} });

      render(<AIEngineUsageTab />);

      await waitFor(() => {
        expect(screen.getByText('Est. Cost (USD)')).toBeInTheDocument();
        expect(screen.getByText('Total Tokens')).toBeInTheDocument();
        expect(screen.getAllByText('Admin playground').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('google').length).toBeGreaterThanOrEqual(1);
      });
    });
  });
});
