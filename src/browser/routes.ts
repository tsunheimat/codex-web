// Memory-router pages that are safe to mirror into the browser URL so
// refresh, history, and deep links keep working. Window- or flow-scoped
// routes (onboarding, login, diff windows, overlays) are intentionally
// absent: reloading into them without their host window state is wrong.
const MIRRORED_PAGE_PATTERN =
  /^\/(?:automations|inbox|library|plugins|projects|pull-requests|remote-connections|sites|skills)$/;
// The memory router defines /remote/:taskId but no bare /remote page, so
// only task-scoped remote paths are mirrorable.
const MIRRORED_SECTION_PATTERN =
  /^\/(?:settings|security)(?:\/|$)|^\/remote\/[^/]+$/;

const MAX_MIRRORED_PATH_LENGTH = 512;
const MAX_MIRRORED_SEARCH_LENGTH = 2048;

function sanitizeBrowserSearch(search: string): string {
  if (
    search === "" ||
    search === "?" ||
    !search.startsWith("?") ||
    search.length > MAX_MIRRORED_SEARCH_LENGTH ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f#]/.test(search)
  ) {
    return "";
  }
  return search;
}

function isMirroredPagePath(pathname: string): boolean {
  if (
    pathname.length > MAX_MIRRORED_PATH_LENGTH ||
    !/^\/[A-Za-z0-9\-._~%/]*$/.test(pathname) ||
    pathname.includes("//") ||
    /(^|\/)\.\.?(\/|$)/.test(pathname)
  ) {
    return false;
  }
  return (
    MIRRORED_PAGE_PATTERN.test(pathname) ||
    MIRRORED_SECTION_PATTERN.test(pathname)
  );
}

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
    memoryPath: mapBrowserPathToRoute(pathname, search),
  };
}

export function currentThreadIdFromBrowserPath(
  pathname: string,
): string | null {
  const conversation = parseBrowserConversationPath(pathname);
  return conversation?.kind === "codex" ? conversation.threadId : null;
}

export function currentConversationIdFromBrowserPath(
  pathname: string,
): string | null {
  return parseBrowserConversationPath(pathname)?.threadId ?? null;
}

type BrowserConversationPath = {
  kind: "chatgpt" | "codex";
  threadId: string;
};

function parseBrowserConversationPath(
  pathname: string,
): BrowserConversationPath | null {
  const match = pathname.match(
    /^(?:\/thread\/(?<codex>[^/]+)|\/work\/conversation\/(?<chatgpt>[^/]+))$/,
  );
  if (!match) {
    return null;
  }
  try {
    const encodedThreadId = match.groups?.codex ?? match.groups?.chatgpt;
    if (encodedThreadId === undefined) {
      return null;
    }
    const threadId = decodeURIComponent(encodedThreadId);
    if (
      !(
        threadId.length > 0 &&
        threadId.length <= 128 &&
        // eslint-disable-next-line no-control-regex
        !/[\u0000-\u001f\u007f/?#]/.test(threadId)
      )
    ) {
      return null;
    }
    return {
      kind: match.groups?.chatgpt === undefined ? "codex" : "chatgpt",
      threadId,
    };
  } catch {
    return null;
  }
}

function mapBrowserPathToRoute(pathname: string, search = ""): string {
  const preservedSearch = sanitizeBrowserSearch(search);
  const conversation = parseBrowserConversationPath(pathname);
  if (conversation !== null) {
    const encodedThreadId = encodeURIComponent(conversation.threadId);
    // ChatGPT Work conversations keep their query state (for example
    // temporary-chat=true) so refresh restores the same conversation mode.
    return conversation.kind === "chatgpt"
      ? `/work/conversation/${encodedThreadId}${preservedSearch}`
      : `/local/${conversation.threadId}${preservedSearch}`;
  }
  if (isMirroredPagePath(pathname)) {
    return `${pathname}${preservedSearch}`;
  }
  return pathname === "/" ? `/${preservedSearch}` : "/";
}

export function mapMemoryPathToBrowserPath(pathname: string, search = "") {
  const preservedSearch = sanitizeBrowserSearch(search);

  if (pathname === "/") {
    return { path: `/${preservedSearch}`, titleChange: "Codex" };
  }

  const match = pathname.match(/^\/local\/([^/?#]+)$/);
  if (match) {
    return {
      path: `/thread/${encodeURIComponent(match[1])}${preservedSearch}`,
    };
  }

  const chatGptRoute = parseBrowserConversationPath(pathname);
  if (chatGptRoute?.kind === "chatgpt") {
    return {
      path: `/work/conversation/${encodeURIComponent(chatGptRoute.threadId)}${preservedSearch}`,
    };
  }

  if (isMirroredPagePath(pathname)) {
    return { path: `${pathname}${preservedSearch}` };
  }

  return null;
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
  dispatchNavigateToRoute(
    mapBrowserPathToRoute(window.location.pathname, window.location.search),
  );
});
