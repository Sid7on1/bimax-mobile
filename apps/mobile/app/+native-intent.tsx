/** Bound and validate external deep links before routing/third-party query decoding. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  if (path.length > 8192) return "/";
  try {
    decodeURIComponent(path);
    const configured = process.env.EXPO_PUBLIC_AUTH_REDIRECT_URL;
    if (configured && path.startsWith("https:")) {
      const url = new URL(path),
        expected = new URL(configured);
      if (url.origin === expected.origin && url.pathname === expected.pathname)
        return "/auth-callback?code=" + encodeURIComponent(url.searchParams.get("code") ?? "");
    }
    return path;
  } catch {
    return "/";
  }
}
