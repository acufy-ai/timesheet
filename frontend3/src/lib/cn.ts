import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// className combiner. clsx handles conditional toggles and arrays; twMerge
// resolves conflicting Tailwind utility classes (so a later `text-red-500`
// wins over an earlier `text-blue-500`).
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
