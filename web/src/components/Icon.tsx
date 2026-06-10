import "./Icon.css";

interface IconProps {
  name: string;
  size?: number;
  fill?: 0 | 1;
  className?: string;
}

export function Icon({ name, size = 24, fill = 0, className }: IconProps) {
  return (
    <span
      className={`m3-icon material-symbols-rounded${className ? ` ${className}` : ""}`}
      style={{
        fontSize: size,
        fontVariationSettings: `'FILL' ${fill}, 'opsz' ${Math.min(Math.max(size, 20), 48)}, 'wght' 400, 'GRAD' 0`,
      }}
      aria-hidden="true"
    >
      {name}
    </span>
  );
}
