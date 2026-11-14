import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { buttonClass, type ButtonSize, type ButtonVariant } from './buttonClass';
import { cn } from './cn';
import { Icon, type IconName } from './Icon';

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, CommonProps & ButtonHTMLAttributes<HTMLButtonElement>>(function Button(
  { variant, size, icon, iconRight, className, children, type = 'button', ...rest },
  ref,
) {
  const iconSize = size === 'sm' ? 16 : 18;
  return (
    <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...rest}>
      {icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={iconSize} /> : null}
    </button>
  );
});

export function ButtonLink({ variant, size, icon, iconRight, className, children, ...rest }: CommonProps & LinkProps) {
  const iconSize = size === 'sm' ? 16 : 18;
  return (
    <Link className={buttonClass(variant, size, className)} {...rest}>
      {icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={iconSize} /> : null}
    </Link>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label: string;
  size?: 'sm' | 'md';
  ghost?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 'md', ghost, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn('icon-btn', size === 'sm' && 'icon-btn--sm', ghost && 'icon-btn--ghost', className)}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 16 : 18} />
    </button>
  );
});
