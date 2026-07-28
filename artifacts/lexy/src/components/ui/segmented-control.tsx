import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type SegmentedOption = {
  key: string;
  label: string;
  count?: React.ReactNode;
};

type PuckRect = { left: number; top: number; width: number; height: number };

/**
 * Apple-style segmented control: a single rounded track holding all options,
 * with one absolutely-positioned "puck" that slides behind the selected option.
 * Colours + slide animation (and reduced-motion fallback) live in index.css
 * under `.seg-control` / `.seg-puck`.
 */
export function SegmentedControl({
  options,
  value,
  onChange,
  className,
  "aria-label": ariaLabel,
}: {
  options: SegmentedOption[];
  value: string;
  onChange: (key: string) => void;
  className?: string;
  "aria-label"?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [puck, setPuck] = useState<PuckRect | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const el = btnRefs.current[value];
      if (!el) return;
      const c = container.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      const next: PuckRect = {
        left: b.left - c.left,
        top: b.top - c.top,
        width: b.width,
        height: b.height,
      };
      setPuck((prev) =>
        prev &&
        prev.left === next.left &&
        prev.top === next.top &&
        prev.width === next.width &&
        prev.height === next.height
          ? prev
          : next,
      );
    };

    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(container);
    Object.values(btnRefs.current).forEach((b) => b && ro.observe(b));
    return () => ro.disconnect();
  }, [value, options.length]);

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "seg-control relative inline-flex w-max flex-wrap items-center gap-0.5 rounded-full p-[3px]",
        className,
      )}
    >
      {puck && (
        <span
          aria-hidden="true"
          className="seg-puck pointer-events-none absolute left-0 top-0 z-0 rounded-full"
          style={{
            width: puck.width,
            height: puck.height,
            transform: `translate(${puck.left}px, ${puck.top}px)`,
          }}
        />
      )}
      {options.map((opt) => {
        const selected = opt.key === value;
        return (
          <button
            key={opt.key}
            type="button"
            aria-pressed={selected}
            ref={(el) => {
              btnRefs.current[opt.key] = el;
            }}
            onClick={() => onChange(opt.key)}
            className={cn(
              "relative z-10 whitespace-nowrap rounded-full px-3 py-1.5 text-sm transition-colors",
              selected
                ? "font-semibold text-foreground"
                : "font-normal text-muted-foreground hover:text-foreground",
            )}
          >
            {opt.label}
            {opt.count != null && (
              <span className="ml-1.5 font-normal text-faint dark:text-inherit dark:opacity-60">{opt.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
