/**
 * spinner.tsx — shadcn/ui primitive ("spinner").
 * Generated, reusable UI component built on Radix/Tailwind.
 * Styling/behavior is standard shadcn boilerplate; see shadcn/ui docs.
 */
import { Loader2Icon } from "lucide-react";

import { cn } from "@/lib/utils";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
