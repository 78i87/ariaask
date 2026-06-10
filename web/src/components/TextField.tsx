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
}

export function TextField({ label, value, onChange, supportingText, error, autoFocus, name, onSubmit }: TextFieldProps) {
  const id = useId();
  return (
    <div className={`m3-textfield${error ? " m3-textfield--error" : ""}`}>
      <div className="m3-textfield__box">
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
        <label htmlFor={id} className="m3-textfield__label">
          {label}
        </label>
      </div>
      {supportingText && <div className="m3-textfield__supporting body-medium">{supportingText}</div>}
    </div>
  );
}
