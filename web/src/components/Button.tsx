import type { ReactNode } from "react";
import { Icon } from "./Icon";
import "./Button.css";

interface ButtonProps {
  variant?: "filled" | "tonal" | "text";
  icon?: string;
  disabled?: boolean;
  type?: "button" | "submit";
  destructive?: boolean;
  onClick?: () => void;
  children: ReactNode;
}

export function Button({
  variant = "filled",
  icon,
  disabled,
  type = "button",
  destructive,
  onClick,
  children,
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`m3-button m3-button--${variant}${destructive ? " m3-button--destructive" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      {icon && <Icon name={icon} size={18} />}
      <span className="label-large">{children}</span>
    </button>
  );
}
