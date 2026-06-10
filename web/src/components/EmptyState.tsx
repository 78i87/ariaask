import type { ReactNode } from "react";
import { Icon } from "./Icon";
import "./EmptyState.css";

interface EmptyStateProps {
  icon: string;
  headline: string;
  body?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, headline, body, action }: EmptyStateProps) {
  return (
    <div className="m3-empty-state">
      <div className="m3-empty-state__icon">
        <Icon name={icon} size={48} />
      </div>
      <h2 className="headline-small">{headline}</h2>
      {body && <p className="body-medium">{body}</p>}
      {action}
    </div>
  );
}
