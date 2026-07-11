import { Icon } from "./Icon";
import "./Segmented.css";

interface SegmentedProps {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  /** Compact, shrink-to-fit variant for sub-choices nested under a primary toggle. */
  dense?: boolean;
}

export function Segmented({ options, value, onChange, ariaLabel, dense }: SegmentedProps) {
  return (
    <div className={`m3-segmented${dense ? " m3-segmented--dense" : ""}`} role="radiogroup" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          className={`m3-segmented__btn ${dense ? "label-medium" : "label-large"}${value === opt.value ? " m3-segmented__btn--selected" : ""}`}
          onClick={() => onChange(opt.value)}
        >
          {value === opt.value && <Icon name="check" size={dense ? 16 : 18} />}
          {opt.label}
        </button>
      ))}
    </div>
  );
}
