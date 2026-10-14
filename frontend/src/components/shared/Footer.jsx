import React from 'react';
import { Link } from 'react-router';
import PlacedNewsletterSignup from '@/components/shared/PlacedNewsletterSignup';

// Hoisted to module scope so jsx-ast-utils can statically resolve `href`
// in the JSX below. Inlining `import.meta.env.X` directly into a JSX prop
// emits a noisy "MetaProperty could not be resolved" warning at lint time
// (jsx-a11y rules walk the AST trying to evaluate href). See GH #147.
const SOCIAL_X_URL = import.meta.env.VITE_SOCIAL_X_URL;
const SOCIAL_LINKEDIN_URL = import.meta.env.VITE_SOCIAL_LINKEDIN_URL;
const SOCIAL_GITHUB_URL = import.meta.env.VITE_SOCIAL_GITHUB_URL;

export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    // Background comes from the tokenized footer chrome (--header-bg) in index.css
    <footer className="mt-8 py-6 border-t border-glass-border">
      {/* Shown only when the owner's signup placement includes the footer (#557). */}
      <PlacedNewsletterSignup
        where="footer"
        source="footer"
        className="max-w-[1400px] mx-auto px-4 md:px-6 w-full mb-6"
      />
      <div className="max-w-[1400px] mx-auto px-4 md:px-6 w-full flex flex-col md:flex-row items-center justify-between gap-2 md:gap-0">
        {/* Left: Copyright. No "All rights reserved": the site's code is
            Apache-2.0 (LICENSE, #780), and the Terms page covers content. */}
        <div className="flex-1 flex flex-col md:flex-row items-center md:items-start md:justify-start">
          <span className="text-slate-600 dark:text-slate-400 text-xs font-mono">
            © {currentYear} Hybrid Cloud Works.
          </span>
        </div>

        {/* Center: grouped links centered (About · Contact · Privacy · Terms · Admin) */}
        <div className="flex-1 flex items-center justify-center">
          <nav className="flex items-center gap-4 sm:gap-6 text-xs">
            <Link
              to="/about"
              className="text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-300 font-mono uppercase tracking-wide transition-colors"
            >
              About
            </Link>
            <Link
              to="/contact"
              className="text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-300 font-mono uppercase tracking-wide transition-colors"
            >
              Contact
            </Link>
            <a
              href="/privacy-policy"
              className="text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-300 font-mono uppercase tracking-wide transition-colors"
            >
              Privacy Policy
            </a>
            <a
              href="/terms-of-service"
              className="text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-300 font-mono uppercase tracking-wide transition-colors"
            >
              Terms
            </a>
            <Link
              to="/admin"
              className="text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-300 font-mono uppercase tracking-wide transition-colors"
            >
              Admin
            </Link>
          </nav>
        </div>

        {/* Right: Social Icons — shown only when profile URLs are configured */}
        <div className="flex-1 flex flex-row items-center justify-end gap-4 mt-2 md:mt-0">
          {SOCIAL_X_URL && (
            <a
              className="text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
              href={SOCIAL_X_URL}
              aria-label="X (Twitter)"
              target="_blank"
              rel="noopener noreferrer"
            >
              <svg aria-hidden="true" className="size-4 fill-current" viewBox="0 0 24 24">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              <span className="sr-only">X (Twitter)</span>
            </a>
          )}
          {SOCIAL_LINKEDIN_URL && (
            <a
              className="text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
              href={SOCIAL_LINKEDIN_URL}
              aria-label="LinkedIn"
              target="_blank"
              rel="noopener noreferrer"
            >
              <svg aria-hidden="true" className="size-4 fill-current" viewBox="0 0 24 24">
                <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
              </svg>
              <span className="sr-only">LinkedIn</span>
            </a>
          )}
          {SOCIAL_GITHUB_URL && (
            <a
              className="text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
              href={SOCIAL_GITHUB_URL}
              aria-label="GitHub"
              target="_blank"
              rel="noopener noreferrer"
            >
              <svg aria-hidden="true" className="size-4 fill-current" viewBox="0 0 24 24">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.042-1.416-4.042-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
              <span className="sr-only">GitHub</span>
            </a>
          )}
        </div>
      </div>
    </footer>
  );
}
