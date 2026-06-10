import "./ProgressIndicator.css";

export function ProgressIndicator({ size = 40 }: { size?: number }) {
  const stroke = size <= 24 ? 3 : 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg
      className="m3-progress"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="progressbar"
      aria-label="Loading"
    >
      <circle
        className="m3-progress__track"
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
      />
      <circle
        className="m3-progress__bar"
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${c * 0.75} ${c * 0.25}`}
        style={{ ["--c" as string]: `${c}px` }}
      />
    </svg>
  );
}
