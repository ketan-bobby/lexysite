/**
 * skeleton.tsx — shadcn/ui primitive ("skeleton").
 * Generated, reusable UI component built on Radix/Tailwind.
 * Styling/behavior is standard shadcn boilerplate; see shadcn/ui docs.
 */
import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-primary/10", className)} {...props} />;
}

export { Skeleton };
