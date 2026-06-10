import { Icon } from "./Icon";
import "./Fab.css";

interface FabProps {
  icon: string;
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
