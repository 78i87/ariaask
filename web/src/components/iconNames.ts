/**
 * Every Material Symbol the app uses — the single source of truth for the
 * subset font. The Google Fonts URL in index.html only ships these glyphs
 * (icon_names=…): a name outside the subset renders as literal ligature text.
 * Two guards keep that from happening:
 *   - Icon (and every component with an icon prop) types its name as IconName,
 *     so using an unlisted icon is a typecheck error;
 *   - vite.config.ts injects this list into the font URL at dev/build time,
 *     so index.html can never drift from the code.
 * To add an icon: add it here, use it — nothing else.
 */
export const ICON_NAMES = [
  "add",
  "archive",
  "arrow_back",
  "arrow_downward",
  "center_focus_strong",
  "check",
  "close",
  "cloud_off",
  "contact_page",
  "content_copy",
  "dark_mode",
  "delete",
  "description",
  "edit",
  "error",
  "fact_check",
  "flag",
  "history_edu",
  "hub",
  "keyboard_arrow_down",
  "keyboard_arrow_up",
  "library_books",
  "light_mode",
  "login",
  "logout",
  "menu_book",
  "more_horiz",
  "more_vert",
  "open_in_new",
  "picture_as_pdf",
  "priority_high",
  "right_panel_close",
  "right_panel_open",
  "school",
  "search",
  "send",
  "settings",
  "stop",
  "travel_explore",
  "unarchive",
  "upload_file",
  "work",
  "zoom_in",
  "zoom_out",
] as const;

export type IconName = (typeof ICON_NAMES)[number];
