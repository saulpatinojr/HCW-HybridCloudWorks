/**
 * StaggerList Component
 *
 * Staggered animation for lists and grids
 * Each child animates in sequence with a delay between them
 * Perfect for content listings, card grids, and feature lists
 *
 * @example
 * ```tsx
 * <StaggerList>
 *   <Card>Item 1</Card>
 *   <Card>Item 2</Card>
 *   <Card>Item 3</Card>
 * </StaggerList>
 * ```
 */

import React, { ReactNode, Children } from 'react';
import { motion } from 'framer-motion';
import { useIntersectionObserver } from '@/hooks/useIntersectionObserver';
import { animationVariants } from './animationVariants';

export interface StaggerListProps {
  children: ReactNode;
  /**
   * Delay between each child animation (seconds)
   * @default 0.1
   */
  staggerDelay?: number;
  /**
   * Duration of each child's animation (seconds)
   * @default 0.5
   */
  duration?: number;
  /**
   * Animation type for each child
   * @default 'slideUp'
   */
  animation?: 'fadeIn' | 'slideUp' | 'slideInLeft' | 'slideInRight' | 'scale';
  /**
   * If true, animations trigger only once
   * @default true
   */
  once?: boolean;
  /**
   * Threshold for intersection observer
   * @default 0.1
   */
  threshold?: number;
  /**
   * CSS class for the container
   */
  className?: string;
}

export function StaggerList({
  children,
  staggerDelay = 0.1,
  duration = 0.5,
  animation = 'slideUp',
  once = true,
  threshold = 0.1,
  className,
}: StaggerListProps) {
  const { ref, isVisible, hasBeenVisible } = useIntersectionObserver({
    threshold,
    once,
  });

  const shouldShow = isVisible || (once === false && hasBeenVisible);
  const variants = animationVariants[animation];

  // Container animation with stagger effect
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: staggerDelay,
        delayChildren: 0,
      },
    },
  };

  return (
    <motion.div
      ref={ref}
      className={className}
      initial="hidden"
      animate={shouldShow ? 'visible' : 'hidden'}
      variants={containerVariants}
    >
      {Children.map(children, (child, index) => (
        <motion.div
          key={index}
          variants={variants}
          transition={{
            duration,
            ease: 'easeOut',
          }}
        >
          {child}
        </motion.div>
      ))}
    </motion.div>
  );
}
