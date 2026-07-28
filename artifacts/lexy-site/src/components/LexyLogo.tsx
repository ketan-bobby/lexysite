/**
 * LexyLogo.tsx
 * "L3xy AI" brand wordmark used across the marketing site.
 *
 * Renders the official transparent brand logo (public/lexy-ai-logo.png,
 * cleaned + tightly cropped) so it blends with any surface. The `size`
 * prop scales the height (sm / md / lg).
 *
 * Exports: default `LexyLogo` component.
 */
export default function LexyLogo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  // Map the size token to an image height utility.
  const cls = size === "lg" ? "h-12" : size === "sm" ? "h-7" : "h-9";
  return (
    <img
      src={`${import.meta.env.BASE_URL}lexy-ai-logo.png`}
      alt="L3xy AI"
      className={`${cls} w-auto object-contain select-none`}
      draggable={false}
    />
  );
}
