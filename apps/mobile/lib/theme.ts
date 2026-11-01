import { tokens } from "../generated/chat-renderer.json";
/** Bimax's default appearance, independent of the phone's system appearance. */
export const colors = {
  background: tokens["--color-bg"],
  surface: tokens["--color-raise"],
  raised: tokens["--color-raise"],
  border: tokens["--color-line"],
  text: tokens["--color-ink"],
  secondary: tokens["--color-dim"],
  muted: tokens["--color-faint"],
  button: tokens["--color-ink"],
  buttonText: tokens["--color-bg"],
  danger: "#ff9a9a",
  dangerSurface: "#3b2424",
  success: "#a4dbb8",
  successSurface: "#20372b",
  warning: "#e9cb8b",
  warningSurface: "#383020",
} as const;
