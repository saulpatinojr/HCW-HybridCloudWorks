/**
 * The "Topics Covered" list on an education hub's featured certification
 * card: a small heading and a two-column grid of topics, each with a tick.
 * Used by the AWS and Azure hubs, which lay out the rest of the card
 * themselves.
 *
 * `size` picks one of two spacings ('sm' for the tighter AWS card, 'md' for
 * Azure's), and `iconColor` the tick's colour class.
 */
import React from 'react';

const SIZES = {
  sm: { heading: 'text-xs mb-2', grid: 'gap-2 mb-5', icon: 'text-[14px]', text: 'text-xs' },
  md: { heading: 'text-sm mb-3', grid: 'gap-3 mb-8', icon: 'text-[16px]', text: 'text-sm' },
};

export default function FeaturedTopicList({ topics, size, iconColor }) {
  const look = SIZES[size];
  return (
    <>
      <h3 className={`${look.heading} font-bold text-foreground uppercase tracking-wider`}>
        Topics Covered
      </h3>
      <div className={`grid grid-cols-2 ${look.grid}`}>
        {topics.map((topic, i) => (
          <div key={i} className="flex items-center gap-2">
            <span
              className={`${iconColor} material-symbols-outlined ${look.icon}`}
              aria-hidden="true"
            >
              check_circle
            </span>
            <span className={`text-foreground ${look.text}`}>{topic}</span>
          </div>
        ))}
      </div>
    </>
  );
}
