// utils.ts — Shared UI helpers. `cn` merges conditional class names (clsx) and
// de-duplicates conflicting Tailwind classes (tailwind-merge). Used everywhere.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
