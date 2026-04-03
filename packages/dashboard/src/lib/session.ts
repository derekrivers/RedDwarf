const tokenStorageKey = "reddwarf-operator-token";
const themeStorageKey = "reddwarf-dashboard-theme";

export type DashboardTheme = "light" | "dark";

export function readOperatorToken(): string {
  return window.sessionStorage.getItem(tokenStorageKey) ?? "";
}

export function writeOperatorToken(token: string): void {
  window.sessionStorage.setItem(tokenStorageKey, token);
}

export function clearOperatorToken(): void {
  window.sessionStorage.removeItem(tokenStorageKey);
}

export function readTheme(): DashboardTheme {
  return window.sessionStorage.getItem(themeStorageKey) === "light" ? "light" : "dark";
}

export function writeTheme(theme: DashboardTheme): void {
  window.sessionStorage.setItem(themeStorageKey, theme);
}
