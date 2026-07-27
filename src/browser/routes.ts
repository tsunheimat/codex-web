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

function mapBrowserPathToRoute(pathname: string): string {
  const conversation = parseBrowserConversationPath(pathname);
  if (conversation === null) {
    return "/";
  }
  const encodedThreadId = encodeURIComponent(conversation.threadId);
  return conversation.kind === "chatgpt"
    ? `/work/conversation/${encodedThreadId}`
    : `/local/${conversation.threadId}`;
}

export function mapMemoryPathToBrowserPath(pathname: string) {
  if (pathname === "/") {
    return { path: "/", titleChange: "Codex" };
  }

  const match = pathname.match(/^\/local\/([^/?#]+)$/);
  if (match) {
    return { path: `/thread/${encodeURIComponent(match[1])}` };
  }

  const chatGptRoute = parseBrowserConversationPath(pathname);
  if (chatGptRoute?.kind !== "chatgpt") {
    return null;
  }
  return {
    path: `/work/conversation/${encodeURIComponent(chatGptRoute.threadId)}`,
  };
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
