import { useState } from "react";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { TextField } from "../../components/TextField";
import type { IntakeAnswerPayload, IntakeQuestion } from "../../lib/types";
import "./IntakeForm.css";

const CUSTOM = "__custom__";

interface IntakeFormProps {
  questions: IntakeQuestion[];
  submitting: boolean;
  onSubmit: (answers: IntakeAnswerPayload) => void;
  onSkip: () => void;
}

export function IntakeForm({ questions, submitting, onSubmit, onSkip }: IntakeFormProps) {
  // questionId -> selected option value (or CUSTOM); separate map for custom text.
  const [selected, setSelected] = useState<Record<string, string>>({ level: "standard", research: "yes" });
  const [customText, setCustomText] = useState<Record<string, string>>({});

  const submit = () => {
    const answers: IntakeAnswerPayload = {};
    for (const q of questions) {
      const sel = selected[q.id];
      if (sel === CUSTOM) {
        const text = (customText[q.id] ?? "").trim();
        if (text) answers[q.id] = { custom: text };
      } else if (sel) {
        answers[q.id] = { value: sel };
      }
    }
    onSubmit(answers);
  };

  return (
    <section className="intake" aria-label="Session setup">
      <h2 className="intake__headline headline-small">Tune Aria before you start</h2>
      <p className="intake__supporting body-medium">These choices shape the student you're about to teach.</p>

      {questions.map((q) => (
        <fieldset key={q.id} className="intake__question" disabled={submitting}>
          <legend className="intake__legend label-large">{q.question}</legend>
          <div role="radiogroup" aria-label={q.question} className="intake__options">
            {q.options.map((opt) => {
              const isSelected = selected[q.id] === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  className={`intake__option${isSelected ? " intake__option--selected" : ""}`}
                  onClick={() => setSelected((prev) => ({ ...prev, [q.id]: opt.value }))}
                >
                  <span className="intake__option-label body-large">{opt.label}</span>
                  {isSelected && <Icon name="check" size={20} />}
                </button>
              );
            })}
            {q.allowsCustom && (
              <button
                type="button"
                role="radio"
                aria-checked={selected[q.id] === CUSTOM}
                className={`intake__option${selected[q.id] === CUSTOM ? " intake__option--selected" : ""}`}
                onClick={() => setSelected((prev) => ({ ...prev, [q.id]: CUSTOM }))}
              >
                <span className="intake__option-label body-large">Other…</span>
                {selected[q.id] === CUSTOM && <Icon name="check" size={20} />}
              </button>
            )}
          </div>
          {selected[q.id] === CUSTOM && (
            <div className="intake__custom">
              <TextField
                label="Describe it your way"
                value={customText[q.id] ?? ""}
                onChange={(v) => setCustomText((prev) => ({ ...prev, [q.id]: v }))}
                autoFocus
              />
            </div>
          )}
        </fieldset>
      ))}

      {!questions.some((q) => q.id === "research") && (
        <div className="intake__note body-medium">
          <Icon name="travel_explore" size={18} />
          <span>With no materials uploaded, Aria will read up online before class.</span>
        </div>
      )}

      <div className="intake__actions">
        <Button variant="text" onClick={onSkip} disabled={submitting}>
          Skip
        </Button>
        <Button onClick={submit} disabled={submitting}>
          Start teaching
        </Button>
      </div>
    </section>
  );
}
