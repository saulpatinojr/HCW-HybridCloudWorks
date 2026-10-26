import React from 'react';
import { Palette } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NODE_TYPES } from './graphModel';
import { DEFAULT_APPEARANCE, PALETTES } from './mapPreferences';
export default function MapAppearance({ value, onChange }) {
  const palette = PALETTES[value.palette];
  return (
    <details className="rounded-lg border bg-card px-3 py-2 text-sm">
      <summary className="flex cursor-pointer items-center gap-2 font-medium">
        <Palette className="h-4 w-4" />
        Appearance
      </summary>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <fieldset>
          <legend className="mb-2 text-xs font-medium">Canvas palette</legend>
          <div className="flex flex-wrap gap-2">
            {Object.entries(PALETTES).map(([key, theme]) => (
              <button
                type="button"
                key={key}
                aria-pressed={value.palette === key}
                onClick={() => onChange({ ...value, palette: key, colors: {} })}
                className="rounded-md border px-3 py-2 text-xs aria-pressed:ring-2 aria-pressed:ring-primary"
                style={{ background: theme.background, color: theme.text }}
              >
                {theme.label}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="space-y-2 text-xs font-medium">
          Label size · {value.fontSize} px
          <input
            aria-label="Map label size"
            type="range"
            min="9"
            max="14"
            step="1"
            className="block w-full"
            value={value.fontSize}
            onChange={(e) => onChange({ ...value, fontSize: Number(e.target.value) })}
          />
          <span className="block font-normal text-muted-foreground">
            Text stays this size when zooming.
          </span>
        </label>
        <fieldset>
          <legend className="mb-2 text-xs font-medium">Node colors</legend>
          <div className="flex flex-wrap gap-3">
            {Object.entries(NODE_TYPES).map(([type, info]) => (
              <label key={type} className="flex flex-col items-center gap-1 text-[10px]">
                <input
                  type="color"
                  aria-label={`${info.label} color`}
                  className="h-7 w-8 cursor-pointer rounded border p-0.5"
                  value={value.colors[type] || palette.nodes[type]}
                  onChange={(e) =>
                    onChange({ ...value, colors: { ...value.colors, [type]: e.target.value } })
                  }
                />
                {info.label}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="mt-2"
        onClick={() => onChange({ ...DEFAULT_APPEARANCE })}
      >
        Reset appearance
      </Button>
    </details>
  );
}
