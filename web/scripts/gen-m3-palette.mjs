// One-off Material 3 scheme generator for tokens.css palette blocks.
// Usage: node web/scripts/gen-m3-palette.mjs "#42A5F5"
import {
  argbFromHex,
  hexFromArgb,
  Hct,
  SchemeTonalSpot,
  MaterialDynamicColors,
} from "@material/material-color-utilities";

const SEED = process.argv[2] ?? "#42A5F5";

// [css-var-suffix, MaterialDynamicColors accessor] — order matches tokens.css.
const ROLES = [
  ["primary", MaterialDynamicColors.primary],
  ["on-primary", MaterialDynamicColors.onPrimary],
  ["primary-container", MaterialDynamicColors.primaryContainer],
  ["on-primary-container", MaterialDynamicColors.onPrimaryContainer],
  ["secondary", MaterialDynamicColors.secondary],
  ["on-secondary", MaterialDynamicColors.onSecondary],
  ["secondary-container", MaterialDynamicColors.secondaryContainer],
  ["on-secondary-container", MaterialDynamicColors.onSecondaryContainer],
  ["tertiary", MaterialDynamicColors.tertiary],
  ["on-tertiary", MaterialDynamicColors.onTertiary],
  ["tertiary-container", MaterialDynamicColors.tertiaryContainer],
  ["on-tertiary-container", MaterialDynamicColors.onTertiaryContainer],
  ["error", MaterialDynamicColors.error],
  ["on-error", MaterialDynamicColors.onError],
  ["error-container", MaterialDynamicColors.errorContainer],
  ["on-error-container", MaterialDynamicColors.onErrorContainer],
  ["surface", MaterialDynamicColors.surface],
  ["on-surface", MaterialDynamicColors.onSurface],
  ["surface-variant", MaterialDynamicColors.surfaceVariant],
  ["on-surface-variant", MaterialDynamicColors.onSurfaceVariant],
  ["outline", MaterialDynamicColors.outline],
  ["outline-variant", MaterialDynamicColors.outlineVariant],
  ["surface-dim", MaterialDynamicColors.surfaceDim],
  ["surface-bright", MaterialDynamicColors.surfaceBright],
  ["surface-container-lowest", MaterialDynamicColors.surfaceContainerLowest],
  ["surface-container-low", MaterialDynamicColors.surfaceContainerLow],
  ["surface-container", MaterialDynamicColors.surfaceContainer],
  ["surface-container-high", MaterialDynamicColors.surfaceContainerHigh],
  ["surface-container-highest", MaterialDynamicColors.surfaceContainerHighest],
  ["inverse-surface", MaterialDynamicColors.inverseSurface],
  ["inverse-on-surface", MaterialDynamicColors.inverseOnSurface],
  ["inverse-primary", MaterialDynamicColors.inversePrimary],
  ["scrim", MaterialDynamicColors.scrim],
  ["shadow", MaterialDynamicColors.shadow],
];

for (const isDark of [false, true]) {
  const scheme = new SchemeTonalSpot(Hct.fromInt(argbFromHex(SEED)), isDark, 0.0);
  console.log(`\n/* ${isDark ? "dark" : "light"} — TonalSpot, seed ${SEED} */`);
  for (const [name, color] of ROLES) {
    console.log(`  --md-sys-color-${name}: ${hexFromArgb(color.getArgb(scheme))};`);
  }
}
