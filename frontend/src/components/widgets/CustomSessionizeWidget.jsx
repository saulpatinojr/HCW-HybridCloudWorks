/**
 * CustomSessionizeWidget: speaking engagements from the Sessionize API merged
 * with the published `speakerevents` snapshot (overrides, manual entries and
 * tombstones), rendering the newer of the deploy-time JSON and the live
 * publish. The loading is sessionizeFeed.js, the merge and the sections
 * sessionizeEvents.js, the geocoding sessionizeGeocode.js and one card
 * SessionCard.jsx; this file is the page's state. Dates, the upcoming rule and
 * the id-then-name match are lib/speakingEvents, shared with the admin hub
 * (ADR 0033, Spotlight slice).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import SessionCard from './SessionCard';
import { groupSessions, sessionView } from './sessionizeEvents';
import { loadSessions } from './sessionizeFeed';

export { loadSpeakingSnapshot } from './sessionizeFeed';

/**
 * True once the element is within 300px of the viewport, so nothing is
 * fetched for a widget nobody scrolls to. Fires once, then the observer
 * disconnects — no overhead after the initial load.
 */
function useNearViewport(ref) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: '300px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return near;
}

/** The full-size image, closed by Escape, a click outside or the button. */
function ImageLightbox({ src, onClose }) {
  const modalRef = useRef();
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    const handleClickOutside = (event) => {
      if (modalRef.current && !modalRef.current.contains(event.target)) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 cursor-pointer"
      onClick={onClose}
    >
      <motion.div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        initial={{ scale: 0.85, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.85, opacity: 0 }}
        transition={{ type: 'spring', damping: 20, stiffness: 300 }}
        className="relative max-w-2xl max-h-[85vh] cursor-default"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={src}
          alt="Event"
          className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-2xl"
        />
        <button
          onClick={onClose}
          className="absolute -top-4 -right-4 text-white bg-black/70 hover:bg-black/90 rounded-full p-2 transition-colors"
          aria-label="Close image viewer"
        >
          <span className="material-symbols-outlined">close</span>
        </button>
      </motion.div>
    </motion.div>
  );
}

/** One titled section of cards; nothing at all when it has no events. */
function SessionSection({ title, events, currentYear, expandedCard, setExpandedCard, onImage }) {
  if (events.length === 0) return null;
  return (
    <div className="space-y-8">
      <h4
        className="text-xl text-slate-900 dark:text-white uppercase tracking-wider"
        style={{ fontFamily: 'Mona Sans, Inter, sans-serif' }}
      >
        {title}
      </h4>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {events.map((session, index) => {
          const view = sessionView(session, index, currentYear);
          const isExpanded = expandedCard === view.key;
          return (
            <SessionCard
              key={view.key}
              view={view}
              isExpanded={isExpanded}
              onToggle={() => setExpandedCard(isExpanded ? null : view.key)}
              onImage={() => onImage(view.imageUrl)}
            />
          );
        })}
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="glass-card p-5 rounded-xl animate-pulse flex flex-col gap-4 h-52">
      <div className="flex gap-4">
        <div className="flex-1 space-y-2">
          <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-3/4" />
          <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded w-1/2 mt-1" />
        </div>
        <div className="w-20 h-20 bg-slate-200 dark:bg-slate-700 rounded-lg shrink-0" />
      </div>
      <div className="space-y-2 flex-1">
        <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded" />
        <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded w-5/6" />
        <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded w-4/6" />
      </div>
      <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded w-1/3 mt-auto" />
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-8">
      <div className="h-5 w-36 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}

const CustomSessionizeWidget = ({ speakerId: speakerIdProp = null }) => {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedImage, setSelectedImage] = useState(null);
  const [expandedCard, setExpandedCard] = useState(null);
  const containerRef = useRef();
  const isInView = useNearViewport(containerRef);
  const closeImage = useCallback(() => setSelectedImage(null), []);

  useEffect(() => {
    if (!isInView) return; // Don't fetch until widget is near the viewport
    loadSessions(speakerIdProp)
      .then(setSessions)
      .catch((err) => {
        setError('Failed to load sessions');
        console.error('API error:', err);
      })
      .finally(() => setLoading(false));
  }, [speakerIdProp, isInView]);

  // `groups.year` is the year the page treats as current: the calendar year
  // from 1 February, and still the year before through January (#1777).
  const groups = groupSessions(sessions, new Date());
  const currentYear = groups.year;
  const sectionProps = { currentYear, expandedCard, setExpandedCard, onImage: setSelectedImage };

  return (
    <div ref={containerRef} className="space-y-8">
      {loading && <LoadingSkeleton />}
      {!loading && error && <div className="text-center py-8 text-slate-500 text-sm">{error}</div>}
      {!loading && !error && (
        <>
          <div>
            <SessionSection title="Coming Soon" events={groups.comingSoon} {...sectionProps} />
          </div>
          {groups.newYear.length > 0 && (
            <div className="pt-12">
              <SessionSection
                title={`${currentYear + 1} Speaking Engagements`}
                events={groups.newYear}
                {...sectionProps}
              />
            </div>
          )}
          <div className="pt-12">
            <SessionSection
              title={`${currentYear} Speaking Engagements`}
              events={groups.thisYear}
              {...sectionProps}
            />
          </div>
          <div className="pt-12">
            <SessionSection
              title={`${currentYear - 1} Speaking Engagements`}
              events={groups.lastYear}
              {...sectionProps}
            />
          </div>
          {sessions.length === 0 && (
            <div className="text-center py-8 text-slate-500 text-sm">
              No speaking engagements found.
            </div>
          )}
        </>
      )}

      <AnimatePresence>
        {selectedImage && <ImageLightbox src={selectedImage} onClose={closeImage} />}
      </AnimatePresence>
    </div>
  );
};

export default CustomSessionizeWidget;
