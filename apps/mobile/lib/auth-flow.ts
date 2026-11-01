/** Native sign-in policy shared by the login screen and callback route. */
export type AuthHealth = { ok: true } | { ok: false; message: string };
export const AUTH_UNAVAILABLE =
  "Cannot reach Bimax sign-in. Check your connection and try again. If this continues, the sign-in service needs attention.";

export async function authServiceHealth(
  serviceUrl: string,
  publicKey: string,
  request: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<AuthHealth> {
  let endpoint: URL;
  try {
    endpoint = new URL(serviceUrl);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !publicKey
    )
      return { ok: false, message: "Bimax sign-in is not configured for this build." };
    endpoint.pathname = endpoint.pathname.replace(/\/$/, "") + "/auth/v1/health";
  } catch {
    return { ok: false, message: "Bimax sign-in is not configured for this build." };
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Sign-in service timed out"));
      }, timeoutMs);
    });
    const response = await Promise.race([
      request(endpoint.toString(), {
        headers: { apikey: publicKey },
        signal: controller.signal,
        redirect: "error",
      }),
      deadline,
    ]);
    return response.ok ? { ok: true } : { ok: false, message: AUTH_UNAVAILABLE };
  } catch {
    return { ok: false, message: AUTH_UNAVAILABLE };
  } finally {
    clearTimeout(timer);
  }
}

export function oauthRedirect(expoGo: boolean, configured: string | undefined): string {
  if (expoGo)
    throw new Error(
      "Google and GitHub sign-in require an installed Bimax development build. In Expo Go, use email sign-in.",
    );
  if (!configured) throw new Error("Social sign-in is not configured. Use email sign-in.");
  const url = new URL(configured);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/auth/callback" ||
    url.search ||
    url.hash
  )
    throw new Error("Social sign-in needs the configured verified callback. Use email sign-in.");
  return url.toString();
}

export interface CodeExchange {
  (code: string): Promise<{ session: unknown; error: unknown }>;
}
export async function exchangeLoginCode(code: unknown, exchange: CodeExchange): Promise<void> {
  if (typeof code !== "string" || !code.trim() || code.length > 4096)
    throw new Error("Sign-in did not return an authorization code. Please try again.");
  const result = await exchange(code);
  if (result.error || !result.session)
    throw new Error("Sign-in could not be completed. Please try again.");
}

export async function signInWithBrowser(options: {
  expoGo: boolean;
  redirect: string | undefined;
  serviceUrl: string;
  health: () => Promise<AuthHealth>;
  authorize: (redirect: string) => Promise<{ url: string | null; error: unknown }>;
  open: (url: string, redirect: string) => Promise<{ type: string; url?: string }>;
  exchange: CodeExchange;
}): Promise<boolean> {
  // Refuse unsupported runtimes before generating a PKCE request or opening Safari.
  const redirect = oauthRedirect(options.expoGo, options.redirect);
  const health = await options.health();
  if (!health.ok) throw new Error(health.message);
  const authorization = await options.authorize(redirect);
  if (authorization.error || !authorization.url)
    throw new Error("Could not start sign-in. Please try again.");
  const url = new URL(authorization.url);
  if (
    url.origin !== new URL(options.serviceUrl).origin ||
    url.pathname !== "/auth/v1/authorize" ||
    url.username ||
    url.password
  )
    throw new Error("Unexpected sign-in destination.");
  const result = await options.open(url.toString(), redirect);
  if (result.type === "cancel" || result.type === "dismiss") return false;
  if (result.type !== "success" || !result.url)
    throw new Error("Sign-in did not complete. Please try again.");
  const actual = new URL(result.url),
    expected = new URL(redirect);
  if (
    actual.origin !== expected.origin ||
    actual.pathname !== expected.pathname ||
    actual.username ||
    actual.password ||
    actual.hash ||
    actual.searchParams.has("error")
  )
    throw new Error("Unexpected sign-in callback.");
  const codes = actual.searchParams.getAll("code");
  if (codes.length !== 1) throw new Error("Sign-in did not return one authorization code.");
  await exchangeLoginCode(codes[0], options.exchange);
  return true;
}
