import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";
import "./Dialog.css";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  icon?: string;
  headline: string;
  children: ReactNode;
  actions: ReactNode;
  width?: number;
}

export function Dialog({ open, onClose, icon, headline, children, actions, width = 560 }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="m3-dialog"
      style={{ width: `min(${width}px, calc(100vw - 32px))` }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="m3-dialog__content">
        {icon && (
          <div className="m3-dialog__icon">
            <Icon name={icon} />
          </div>
        )}
        <h2 className={`m3-dialog__headline headline-small${icon ? " m3-dialog__headline--centered" : ""}`}>
          {headline}
        </h2>
        <div className="m3-dialog__body">{children}</div>
        <div className="m3-dialog__actions">{actions}</div>
      </div>
    </dialog>
  );
}
