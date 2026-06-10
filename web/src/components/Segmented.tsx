import { Icon } from "./Icon";
import "./Segmented.css";

interface SegmentedProps {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}

export function Segmented({ options, value, onChange, ariaLabel }: SegmentedProps) {
  return (
    <div className="m3-segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          className={`m3-segmented__btn label-large${value === opt.value ? " m3-segmented__btn--selected" : ""}`}
          onClick={() => onChange(opt.value)}
        >
          {value === opt.value && <Icon name="check" size={18} />}
          {opt.label}
        </button>
      ))}
    </div>
  );
}
