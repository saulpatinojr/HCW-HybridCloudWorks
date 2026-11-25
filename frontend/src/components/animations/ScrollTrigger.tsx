/**
 * ScrollTrigger Component
 *
 * Triggers Framer Motion animations when element enters/leaves viewport
 * Smooth fade-in and slide-up animations perfect for cards, headings, and content
 *
 * @example
 * ```tsx
 * <ScrollTrigger>
 *   <Card>Featured content</Card>
 * </ScrollTrigger>
 * ```
 */

import React, { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { useIntersectionObserver } from '@/hooks/useIntersectionObserver';
import { animationVariants } from './animationVariants';

export interface ScrollTriggerProps {
  children: ReactNode;
  /**
   * Animation type: 'fadeIn', 'slideUp', 'slideInLeft', 'slideInRight', 'scale'
   * @default 'fadeIn'
   */
  animation?: 'fadeIn' | 'slideUp' | 'slideInLeft' | 'slideInRight' | 'scale';
  /**
   * Duration in seconds
   * @default 0.6
   */
  duration?: number;
  /**
   * Delay before animation starts (seconds)
   * @default 0
   */
  delay?: number;
  /**
   * If true, animation triggers only once
   * @default true
   */
  once?: boolean;
  /**
   * Threshold for intersection observer (0-1)
   * @default 0.1
   */
  threshold?: number;
  /**
   * Additional className for the wrapper
   */
  className?: string;
}

export function ScrollTrigger({
  children,
  animation = 'fadeIn',
  duration = 0.6,
  delay = 0,
  once = true,
  threshold = 0.1,
  className,
}: ScrollTriggerProps) {
  const { ref, isVisible, hasBeenVisible } = useIntersectionObserver({
    threshold,
    once,
  });

  // Determine which state to show: if visible OR (if once=false and hasBeenVisible)
  const shouldShow = isVisible || (once === false && hasBeenVisible);

  const variants = animationVariants[animation];

  return (
    <motion.div
      ref={ref}
      className={className}
      initial="hidden"
      animate={shouldShow ? 'visible' : 'hidden'}
      variants={variants}
      transition={{
        duration,
        delay,
        ease: 'easeOut',
      }}
    >
      {children}
    </motion.div>
  );
}
