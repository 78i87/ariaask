import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import "./Composer.css";

interface ComposerProps {
  disabled: boolean;
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  placeholder?: string;
  /** Tertiary accent marks the Cyra (expert teacher) composer. */
  accent?: "tertiary";
  autoFocus?: boolean;
  /** Controlled mode (used by the new-Cyra-question draft); omit for internal state. */
  value?: string;
  onChange?: (text: string) => void;
}

export function Composer({
  disabled,
  busy,
  onSend,
  onStop,
  placeholder = "Explain it to your student…",
  accent,
  autoFocus,
  value,
  onChange,
}: ComposerProps) {
  const [inner, setInner] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const text = value !== undefined ? value : inner;
  const setText = (t: string) => {
    if (onChange) onChange(t);
    else setInner(t);
  };

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [text]);

  useEffect(() => {
    if (!autoFocus) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    // mount-only: refocusing on later prop changes would steal the caret
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || busy) return;
    onSend(trimmed);
    setText("");
  };

  return (
    <div className="composer">
      <div className={`composer__pill${accent === "tertiary" ? " composer__pill--tertiary" : ""}`}>
        <textarea
          ref={taRef}
          className="composer__input body-large"
          rows={1}
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {busy ? (
          <button type="button" className="composer__btn composer__btn--stop" aria-label="Stop" onClick={onStop}>
            <Icon name="stop" size={20} fill={1} />
          </button>
        ) : (
          <button
            type="button"
            className={`composer__btn composer__btn--send${accent === "tertiary" ? " composer__btn--send-tertiary" : ""}`}
            aria-label="Send"
            disabled={disabled || !text.trim()}
            onClick={send}
          >
            <Icon name="send" size={20} />
          </button>
        )}
      </div>
    </div>
  );
}
