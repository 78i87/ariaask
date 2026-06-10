import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import "./Snackbar.css";

interface SnackbarOptions {
  actionLabel?: string;
  onAction?: () => void;
}

interface SnackbarApi {
  show: (message: string, opts?: SnackbarOptions) => void;
}

const SnackbarContext = createContext<SnackbarApi>({ show: () => {} });

export function SnackbarProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<{ message: string; opts?: SnackbarOptions } | null>(null);
  const timerRef = useRef<number | null>(null);

  const show = useCallback((message: string, opts?: SnackbarOptions) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setCurrent({ message, opts });
    timerRef.current = window.setTimeout(() => setCurrent(null), 5000);
  }, []);

  return (
    <SnackbarContext.Provider value={{ show }}>
      {children}
      {current && (
        <div className="m3-snackbar" role="status">
          <span className="body-medium">{current.message}</span>
          {current.opts?.actionLabel && (
            <button
              type="button"
              className="m3-snackbar__action label-large"
              onClick={() => {
                setCurrent(null);
                current.opts?.onAction?.();
              }}
            >
              {current.opts.actionLabel}
            </button>
          )}
        </div>
      )}
    </SnackbarContext.Provider>
  );
}

export function useSnackbar(): SnackbarApi {
  return useContext(SnackbarContext);
}
