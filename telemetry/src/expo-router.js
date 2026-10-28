/**
 * Screen tracking for Expo Router. Render once inside the root layout:
 *
 *   import { TelemetryScreenTracker } from '@hqpl/telemetry/expo-router';
 *
 *   export default function RootLayout() {
 *     return (
 *       <>
 *         <TelemetryScreenTracker />
 *         <Stack />
 *       </>
 *     );
 *   }
 *
 * Each screen is reported by its route pattern ("/post/[id]") with the real
 * path ("/post/42") as its URL. Route groups such as "(tabs)" are left out.
 */

import { useEffect, useRef } from 'react';
import { usePathname, useSegments } from 'expo-router';
import telemetry from './telemetry.native.js';

export function TelemetryScreenTracker() {
  const pathname = usePathname();
  const segments = useSegments();
  const previous = useRef('');
  const pattern = '/' + segments.filter(segment => !/^\(.+\)$/.test(segment)).join('/');
  const key = `${pattern}|${pathname}`;

  useEffect(() => {
    if (!pathname || key === previous.current) return;
    previous.current = key;
    telemetry.trackPage(pattern, pathname);
  }, [key, pathname, pattern]);

  return null;
}
