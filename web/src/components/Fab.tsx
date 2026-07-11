import { Icon } from "./Icon";
import type { IconName } from "./iconNames";
import "./Fab.css";

interface FabProps {
  icon: IconName;
  label: string;
  onClick: () => void;
  className?: string;
}

export function Fab({ icon, label, onClick, className }: FabProps) {
  return (
    <button type="button" className={`m3-fab${className ? ` ${className}` : ""}`} onClick={onClick}>
      <Icon name={icon} />
      <span className="title-medium">{label}</span>
    </button>
  );
}
