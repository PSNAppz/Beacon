import DotGrid from "./DotGrid";
import { usePrefs } from "../lib/prefsStore";

/**
 * Full-window backdrop sitting behind every page. The canvas listens on
 * `window`, so the layer stays `pointer-events-none` and never intercepts
 * clicks meant for the UI above it.
 */
export function AppBackground() {
  const enabled = usePrefs((s) => s.dotGrid);
  if (!enabled) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-0 bg-bg" aria-hidden="true">
      <DotGrid
        dotSize={3}
        gap={26}
        baseColor="#1E1E21"
        activeColor="#FFFFFF"
        proximity={130}
        shockRadius={220}
        shockStrength={4}
      />
      {/* Sink the grid behind the content so text never fights it. */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-bg/25 to-bg/60" />
    </div>
  );
}
