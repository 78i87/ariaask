import type { ReactNode } from "react";
import "./Card.css";

interface CardProps {
  onClick?: () => void;
  className?: string;
  children: ReactNode;
}

export function Card({ onClick, className, children }: CardProps) {
  const cls = `m3-card${onClick ? " m3-card--interactive" : ""}${className ? ` ${className}` : ""}`;
  // A div (not a button) so interactive children like an overflow menu are valid HTML.
  if (onClick) {
    return (
      <div
        className={cls}
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
      >
        {children}
      </div>
    );
  }
  return <div className={cls}>{children}</div>;
}
