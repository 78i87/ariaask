import { useId } from "react";
import "./TextField.css";

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  supportingText?: string;
  error?: boolean;
  autoFocus?: boolean;
  name?: string;
  onSubmit?: () => void;
  multiline?: boolean;
  rows?: number;
}

export function TextField({ label, value, onChange, supportingText, error, autoFocus, name, onSubmit, multiline, rows }: TextFieldProps) {
  const id = useId();
  return (
    <div
      className={`m3-textfield${error ? " m3-textfield--error" : ""}${multiline ? " m3-textfield--multiline" : ""}`}
    >
      <div className="m3-textfield__box">
        {multiline ? (
          <textarea
            id={id}
            name={name}
            className="m3-textfield__input body-large"
            value={value}
            rows={rows ?? 3}
            autoFocus={autoFocus}
            placeholder=" "
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <input
            id={id}
            name={name}
            className="m3-textfield__input body-large"
            value={value}
            autoFocus={autoFocus}
            placeholder=" "
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && onSubmit) onSubmit();
            }}
          />
        )}
        <label htmlFor={id} className="m3-textfield__label">
          {label}
        </label>
      </div>
      {supportingText && <div className="m3-textfield__supporting body-medium">{supportingText}</div>}
    </div>
  );
}
