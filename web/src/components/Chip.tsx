import { Icon } from "./Icon";
import "./Chip.css";

interface ChipProps {
  label: string;
  icon?: string;
  onClick?: () => void;
  onRemove?: () => void;
  selected?: boolean;
  className?: string;
}

export function Chip({ label, icon, onClick, onRemove, selected, className }: ChipProps) {
  const cls = `m3-chip${selected ? " m3-chip--selected" : ""}${onClick ? " m3-chip--clickable" : ""}${className ? ` ${className}` : ""}`;
  const content = (
    <>
      {icon && <Icon name={icon} size={18} />}
      <span className="m3-chip__label label-large">{label}</span>
      {onRemove && (
        <button
          type="button"
          className="m3-chip__remove"
          aria-label={`Remove ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <Icon name="close" size={16} />
        </button>
      )}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick}>
        {content}
      </button>
    );
  }
  return <div className={cls}>{content}</div>;
}
