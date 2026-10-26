'use client';

import { MotionConfig, motion } from 'motion/react';

/**
 * THE FRONT PAGE'S SCROLL MOTION.
 *
 * `HomeReveal` lets a section's words arrive as they come into view — a short
 * rise, once, so a long page reads as a sequence rather than a wall. Under
 * `prefers-reduced-motion` the rise is dropped and only the fade remains
 * (`MotionConfig reducedMotion="user"`). The markup is the same on the server
 * and the client either way: branching on `useReducedMotion()` here rendered
 * a plain `<div>` on the client and a styled one on the server, which is a
 * hydration mismatch on every reduced-motion visit. (The scroll-tied
 * `RouteSteps` went with the four-step section it drew; the hero's own lines
 * rise with the CSS `.mask-rise` vocabulary.)
 */

export function HomeReveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  return (
    <MotionConfig reducedMotion="user">
      <motion.div
        initial={{ opacity: 0, y: 18 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '0px 0px -12% 0px' }}
        transition={{ duration: 0.7, delay, ease: [0.2, 0.7, 0.2, 1] }}
      >
        {children}
      </motion.div>
    </MotionConfig>
  );
}
