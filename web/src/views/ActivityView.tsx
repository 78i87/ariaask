import { useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import { ProgressIndicator } from "../components/ProgressIndicator";
import { CoachShell } from "./CoachShell";
import { useLearningShell } from "./LearningShell";
import { SessionView } from "./SessionView";

/** Resolve a canonical activity URL to the existing kind-specific surface. */
export function ActivityView() {
  const { id, aid } = useParams<{ id: string; aid: string }>();
  const navigate = useNavigate();
  const {
    projects: { notebooks },
  } = useLearningShell();
  const project = notebooks?.find((candidate) => candidate.id === id && !candidate.archivedAt);
  const activity = project?.activities.find((candidate) => candidate.id === aid);

  useEffect(() => {
    if (
      notebooks !== null &&
      (!project || !activity || (activity.kind === "interview" && !activity.setupComplete))
    ) {
      navigate(project ? `/project/${project.id}` : "/", { replace: true });
    }
  }, [notebooks, project, activity, navigate]);

  if (!activity) {
    return (
      <main className="project-view project-view--loading">
        <ProgressIndicator />
      </main>
    );
  }

  return activity.kind === "coach" ? <CoachShell /> : <SessionView />;
}
