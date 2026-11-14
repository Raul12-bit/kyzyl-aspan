import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet';
export type ButtonSize = 'sm' | 'md' | 'lg';

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', extra?: string) {
  return cn('btn', `btn--${variant}`, size !== 'md' && `btn--${size}`, extra);
}
