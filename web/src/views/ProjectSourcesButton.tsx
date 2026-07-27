import { Icon } from "../components/Icon";
import { ProgressIndicator } from "../components/ProgressIndicator";
import "./ProjectSourcesButton.css";

interface ProjectSourcesButtonProps {
  count: number;
  busy?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  onClick: () => void;
}

/** Shared project-level source control used in every chat header. */
export function ProjectSourcesButton({
  count,
  busy = false,
  disabled = false,
  expanded,
  onClick,
}: ProjectSourcesButtonProps) {
  return (
    <button
      type="button"
      className={`project-sources-button label-large${expanded ? " project-sources-button--expanded" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-expanded={expanded}
    >
      {busy ? <ProgressIndicator size={16} /> : <Icon name="library_books" size={18} />}
      <span className="project-sources-button__label">Sources</span>
      {count > 0 && <span className="project-sources-button__count">{count}</span>}
    </button>
  );
}
