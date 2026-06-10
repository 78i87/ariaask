import { forwardRef } from "react";
import { Icon } from "./Icon";
import "./IconButton.css";

interface IconButtonProps {
  icon: string;
  ariaLabel: string;
  variant?: "standard" | "tonal";
  fill?: 0 | 1;
  disabled?: boolean;
  onClick?: (e: React.MouseEvent) => void;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, ariaLabel, variant = "standard", fill = 0, disabled, onClick },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={`m3-icon-button m3-icon-button--${variant}`}
      aria-label={ariaLabel}
      title={ariaLabel}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} fill={fill} />
    </button>
  );
});
