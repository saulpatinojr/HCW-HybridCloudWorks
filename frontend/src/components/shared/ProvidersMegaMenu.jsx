import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';
import { PROVIDER_TIERS } from '@/data/providerTiers';

export default function ProvidersMegaMenu({
  id = 'providers',
  label = 'Providers',
  active = false,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleClickOutside = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const menuId = `${id}-megamenu`;

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((val) => !val)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls={menuId}
        aria-label={`Toggle ${label.toLowerCase()} menu`}
        className={cn(
          'text-[11px] font-semibold uppercase tracking-wide transition-all px-2.5 py-2 rounded-full border whitespace-nowrap inline-flex items-center justify-center gap-1 cursor-pointer',
          active || open
            ? 'text-(--dark-gray) dark:text-(--light-gray) bg-secondary/15 border-secondary/40 shadow-sm'
            : 'text-slate-600 dark:text-slate-400 border-transparent hover:text-(--dark-gray) dark:hover:text-(--light-gray) hover:bg-secondary/15 hover:border-secondary/40'
        )}
      >
        {label}
        <span
          className={cn(
            'material-symbols-outlined text-[13px] transition-transform duration-200',
            open && 'rotate-180'
          )}
          aria-hidden="true"
        >
          expand_more
        </span>
      </button>

      {open && (
        <div
          id={menuId}
          role="region"
          aria-label={`${label} Directory`}
          data-testid="providers-megamenu"
          className="absolute top-[calc(100%+8px)] left-1/2 -translate-x-1/2 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl p-6 min-w-[760px] max-w-[860px] z-100 animate-in fade-in slide-in-from-top-2 duration-200"
        >
          <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-200 dark:border-slate-800">
            <div>
              <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-primary">
                Multi-Cloud Architecture Ecosystems
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Categorized by Cloud, Platform, and Service operational tiers
              </p>
            </div>
            <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
              9 Active Hubs
            </span>
          </div>

          <div className="grid grid-cols-3 gap-6">
            {PROVIDER_TIERS.map((tier) => (
              <div key={tier.id} className="flex flex-col gap-3">
                <div className="pb-1.5 border-b border-slate-200/80 dark:border-slate-800/80">
                  <h4 className="text-xs font-bold text-slate-900 dark:text-white uppercase tracking-wider flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary" aria-hidden="true" />
                    {tier.title}
                  </h4>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-tight mt-0.5">
                    {tier.subtitle}
                  </p>
                </div>
                <ul className="flex flex-col gap-1.5">
                  {tier.providers.map((p) => (
                    <li key={p.id}>
                      <Link
                        to={p.path}
                        onClick={() => setOpen(false)}
                        className="group flex flex-col p-2.5 rounded-xl hover:bg-slate-100/80 dark:hover:bg-slate-800/80 transition-all border border-transparent hover:border-slate-200 dark:hover:border-slate-700"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-slate-900 dark:text-white group-hover:text-primary transition-colors flex items-center gap-1.5">
                            <span className="material-symbols-outlined text-[15px] text-slate-500 group-hover:text-primary transition-colors">
                              {p.icon}
                            </span>
                            {p.name}
                          </span>
                          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-slate-200/60 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-300/40 dark:border-slate-700/60">
                            {p.badge}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-1 mt-1 leading-normal">
                          {p.role}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
