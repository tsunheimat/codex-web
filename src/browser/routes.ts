export function mapBrowserPathToInitialRoute(pathname: string, search: string) {
  if (pathname === "/share/receive" && search) {
    const params = new URLSearchParams(search);

    const prompt = ["title", "text", "url"]
      .flatMap((name) => {
        const value = params.get(name);
        return value === null ? [] : [`${name}: ${value}`];
      })
      .join("\n");

    return {
      memoryPath: prompt
        ? `/?${new URLSearchParams({ prompt }).toString()}`
        : "/",
      browserPath: "/",
    };
  }

  return {
    memoryPath: mapBrowserPathToRoute(pathname),
  };
}

export function currentThreadIdFromBrowserPath(
  pathname: string,
): string | null {
  const match = pathname.match(/^\/thread\/([^/]+)$/);
  if (!match) {
    return null;
  }
  try {
    const threadId = decodeURIComponent(match[1]);
    return threadId.length > 0 &&
      threadId.length <= 128 &&
      !/[\u0000-\u001f\u007f/?#]/.test(threadId)
      ? threadId
      : null;
  } catch {
    return null;
  }
}

function mapBrowserPathToRoute(pathname: string): string {
  const threadId = currentThreadIdFromBrowserPath(pathname);
  return threadId === null ? "/" : `/local/${threadId}`;
}

export function mapMemoryPathToBrowserPath(pathname: string) {
  if (pathname === "/") {
    return { path: "/", titleChange: "Codex" };
  }

  const match = pathname.match(/^\/local\/([^/?#]+)$/);
  if (!match) {
    return null;
  }

  return { path: `/thread/${encodeURIComponent(match[1])}` };
}

export function dispatchNavigateToRoute(path: string): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "navigate-to-route",
        path,
      },
    }),
  );
}

window.addEventListener("popstate", () => {
  dispatchNavigateToRoute(mapBrowserPathToRoute(window.location.pathname));
});
