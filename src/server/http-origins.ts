export function originAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowed: string[],
): boolean {
  if (!origin) return true;
  if (allowed.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) && url.host === host;
  } catch {
    return false;
  }
}
