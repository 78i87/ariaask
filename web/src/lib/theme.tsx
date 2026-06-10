import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

type Theme = "light" | "dark";
export type Palette = "blue" | "purple";

const ThemeContext = createContext<{
  theme: Theme;
  toggle: () => void;
  palette: Palette;
  setPalette: (p: Palette) => void;
}>({
  theme: "light",
  toggle: () => {},
  palette: "blue",
  setPalette: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(
    () => (document.documentElement.dataset.theme as Theme | undefined) ?? "light",
  );
  const [palette, setPaletteState] = useState<Palette>(
    () => (document.documentElement.dataset.palette as Palette | undefined) ?? "blue",
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.palette = palette;
  }, [palette]);

  // Follow OS preference until the user toggles manually.
  useEffect(() => {
    if (localStorage.getItem("aria-theme")) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setTheme(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const toggle = useCallback(() => {
    setTheme((t) => {
      const next = t === "light" ? "dark" : "light";
      localStorage.setItem("aria-theme", next);
      return next;
    });
  }, []);

  const setPalette = useCallback((p: Palette) => {
    localStorage.setItem("aria-palette", p);
    setPaletteState(p);
  }, []);

  return <ThemeContext.Provider value={{ theme, toggle, palette, setPalette }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
