import { useEffect, useState, type ReactNode } from "react";
import "./TopAppBar.css";

interface TopAppBarProps {
  leading?: ReactNode;
  headline?: ReactNode;
  trailing?: ReactNode;
  /** Element whose scroll position drives the scrolled background; defaults to window. */
  scrollContainer?: HTMLElement | null;
}

export function TopAppBar({ leading, headline, trailing, scrollContainer }: TopAppBarProps) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const target: HTMLElement | Window = scrollContainer ?? window;
    const read = () =>
      setScrolled((scrollContainer ? scrollContainer.scrollTop : window.scrollY) > 0);
    read();
    target.addEventListener("scroll", read, { passive: true });
    return () => target.removeEventListener("scroll", read);
  }, [scrollContainer]);

  return (
    <header className="m3-top-app-bar" data-scrolled={scrolled || undefined}>
      <div className="m3-top-app-bar__leading">{leading}</div>
      <div className="m3-top-app-bar__headline">{headline}</div>
      <div className="m3-top-app-bar__trailing">{trailing}</div>
    </header>
  );
}
