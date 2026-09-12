export type BrowserServerConfig = { serverBaseUrl?: string };
declare global {
  interface Window {
    __CODEX_WEB_CONFIG__?: BrowserServerConfig;
  }
}

/** Set window.__CODEX_WEB_CONFIG__ before preload to deploy the UI separately. */
export function backendUrl(route: string): URL {
  const page = new URL(window.location.href);
  const base = new URL(
    window.__CODEX_WEB_CONFIG__?.serverBaseUrl ?? page.origin,
    page,
  );
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("Invalid Codex Web server URL");
  if (page.protocol === "https:" && base.protocol !== "https:")
    throw new Error("An HTTPS frontend requires an HTTPS backend");
  base.pathname = base.pathname.replace(/\/$/, "") + "/";
  return new URL(route.replace(/^\//, ""), base);
}

export function backendWebSocketUrl(route: string): URL {
  const url = backendUrl(route);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}
