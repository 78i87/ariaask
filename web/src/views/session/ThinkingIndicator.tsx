import { StudentAvatar } from "./MessageBubble";
import "./ThinkingIndicator.css";

export function ThinkingIndicator({ label }: { label?: string }) {
  return (
    <div className="thinking">
      <StudentAvatar pulsing />
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
