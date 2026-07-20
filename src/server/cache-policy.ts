const HASHED_ASSET_PATTERN =
  /\/[A-Za-z0-9_.~-]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9.]+$/;

export function cacheControlForRequestPath(requestPath: string): string {
  const pathname = requestPath.split("?", 1)[0] ?? requestPath;
  if (
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname.startsWith("/assets/preload.js")
  ) {
    return "no-cache";
  }
  if (pathname.startsWith("/assets/") && HASHED_ASSET_PATTERN.test(pathname)) {
    return "public, max-age=31536000, immutable";
  }
  return "no-cache";
}

export function cacheControlForResponse(
  requestPath: string,
  statusCode: number,
  contentType: string | undefined,
): string {
  const pathPolicy = cacheControlForRequestPath(requestPath);
  if (pathPolicy === "no-cache") {
    return pathPolicy;
  }
  if (
    statusCode < 200 ||
    statusCode >= 300 ||
    contentType === undefined ||
    contentType.toLowerCase().includes("text/html")
  ) {
    return "no-cache";
  }
  return pathPolicy;
}
