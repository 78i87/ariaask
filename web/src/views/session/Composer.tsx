import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import "./Composer.css";

interface ComposerProps {
  disabled: boolean;
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function Composer({ disabled, busy, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [text]);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || busy) return;
    onSend(trimmed);
    setText("");
  };

  return (
    <div className="composer">
      <div className="composer__pill">
        <textarea
          ref={taRef}
          className="composer__input body-large"
          rows={1}
          placeholder="Explain it to your student…"
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
            className="composer__btn composer__btn--send"
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
