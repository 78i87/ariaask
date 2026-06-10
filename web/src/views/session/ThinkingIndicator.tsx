import type { ReactNode } from "react";
import { StudentAvatar } from "./MessageBubble";
import "./ThinkingIndicator.css";

export function ThinkingIndicator({ label, avatar }: { label?: string; avatar?: ReactNode }) {
  return (
    <div className="thinking">
      {avatar ?? <StudentAvatar pulsing />}
      <div className="thinking__bubble">
        {label ? (
          <span className="thinking__label body-medium">{label}</span>
        ) : (
          <span className="thinking__dots">
            <span />
            <span />
            <span />
          </span>
        )}
      </div>
    </div>
  );
}
