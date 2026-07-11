import type { ReactNode } from "react";
import type { SessionActivity } from "../../lib/types";
import { Icon } from "../../components/Icon";
import { CyraAvatar, StudentAvatar } from "./MessageBubble";
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

const TEACHING_SETUP_STEPS = [
  { key: "sources", label: "Find useful readings" },
  { key: "profile", label: "Shape Aria's starting point" },
  { key: "map", label: "Build your knowledge outline" },
  { key: "opening", label: "Prepare the opening question" },
] as const;

const INTERVIEW_SETUP_STEPS = [
  { key: "sources", label: "Research the role and company" },
  { key: "profile", label: "Review your CV and job description" },
  { key: "map", label: "Build the interview coverage map" },
  { key: "opening", label: "Prepare the opening question" },
] as const;

function setupIndex(activity: SessionActivity | null): number {
  if (!activity || activity.kind === "researching") return 0;
  if (activity.kind === "building-student-profile") return 1;
  if (activity.kind === "building-knowledge-map") return 2;
  return 3;
}

export function SetupProgress({
  activity,
  sourceCount,
  interview = false,
}: {
  activity: SessionActivity | null;
  sourceCount: number;
  interview?: boolean;
}) {
  const current = setupIndex(activity);
  const steps = interview ? INTERVIEW_SETUP_STEPS : TEACHING_SETUP_STEPS;
  const researchDetail =
    activity?.kind === "researching" && activity.phase === "downloading"
      ? `Downloading ${activity.completed ?? 0} of ${activity.total ?? 0}`
      : interview
        ? "Searching for role and company context"
        : "Searching trusted public sources";
  return (
    <section
      className="setup-progress"
      aria-label={interview ? "Preparing your interview" : "Preparing your teaching session"}
      aria-live="polite"
    >
      <div className="setup-progress__intro">
        {interview ? <CyraAvatar pulsing /> : <StudentAvatar pulsing />}
        <div>
          <strong className="title-small">
            {interview ? "Cyra is preparing your interview" : "Aria is preparing your session"}
          </strong>
          <span className="body-medium">You can leave this page open while each step completes.</span>
        </div>
      </div>
      <ol className="setup-progress__steps">
        {steps.map((step, index) => (
          <li key={step.key} className={index < current ? "is-done" : index === current ? "is-current" : ""}>
            <span className="setup-progress__marker">
              {index < current ? <Icon name="check" size={16} /> : <span>{index + 1}</span>}
            </span>
            <span>
              <strong className="body-medium">{step.label}</strong>
              {index === 0 && index === current && <small>{researchDetail}</small>}
              {index === 0 && index < current && sourceCount > 0 && <small>{sourceCount} sources ready</small>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
