import fs from "node:fs/promises";
import path from "node:path";

export type SshOptions = {
  host: string;
  port?: number;
  identityFile?: string;
  knownHostsFile: string;
};
export type Backend = {
  id: string;
  label: string;
  cwd: string;
  transport:
    | { type: "stdio"; command: string; args: string[] }
    | { type: "websocket"; url: string; tokenEnv?: string }
    | { type: "unix"; socketPath: string }
    | { type: "desktop"; agentTokenEnv: string }
    | { type: "ssh"; ssh: SshOptions; command: string; args: string[] }
    | {
        type: "ssh-websocket";
        ssh: SshOptions;
        host: string;
        port: number;
        tokenEnv?: string;
      }
    | {
        type: "companion";
        agentTokenEnv: string;
        command: string;
        args: string[];
      };
};
export type GatewayConfig = {
  host: string;
  port: number;
  statePath: string;
  token: string;
  allowedOrigins: string[];
  backends: Backend[];
};

export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function sshArguments(ssh: SshOptions): string[] {
  // These options must precede host/config defaults; never auto-accept a key.
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${ssh.knownHostsFile}`,
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    ...(ssh.port ? ["-p", String(ssh.port)] : []),
    ...(ssh.identityFile
      ? ["-i", ssh.identityFile, "-o", "IdentitiesOnly=yes"]
      : []),
  ];
}

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a configuration object");
  return value as Record<string, any>;
}
function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value))
    throw new Error(`Invalid ${name}`);
  return value;
}
function port(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535)
    throw new Error("Invalid port");
  return Number(value);
}
function absolute(value: unknown, name: string): string {
  const result = string(value, name);
  if (!path.isAbsolute(result)) throw new Error(`${name} must be absolute`);
  return result;
}
function parseSsh(value: unknown): SshOptions {
  const ssh = record(value);
  const host = string(ssh.host, "SSH host");
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(host))
    throw new Error("Invalid SSH host or config alias");
  return {
    host,
    knownHostsFile: absolute(ssh.knownHostsFile, "knownHostsFile"),
    ...(ssh.port !== undefined ? { port: port(ssh.port) } : {}),
    ...(ssh.identityFile
      ? { identityFile: absolute(ssh.identityFile, "identityFile") }
      : {}),
  };
}
function tokenEnvironment(value: unknown): { tokenEnv?: string } {
  if (value === undefined) return {};
  if (typeof value !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(value))
    throw new Error("Invalid tokenEnv");
  return { tokenEnv: value };
}
function requiredTokenEnvironment(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(value))
    throw new Error("Invalid agentTokenEnv");
  return value;
}

export function parseConfig(input: unknown, token: string): GatewayConfig {
  const value = record(input);
  if (token.length < 32)
    throw new Error(
      "CODEX_WEB_GATEWAY_TOKEN must contain at least 32 characters",
    );
  if (
    !Array.isArray(value.backends) ||
    value.backends.length === 0 ||
    value.backends.length > 32
  )
    throw new Error("Configure 1–32 backends");
  const ids = new Set<string>();
  const backends = value.backends.map((entry: unknown): Backend => {
    const b = record(entry);
    const id = string(b.id, "backend id");
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ids.has(id))
      throw new Error("Backend IDs must be unique URL-safe names");
    ids.add(id);
    const t = record(b.transport);
    let transport: Backend["transport"];
    switch (t.type) {
      case "stdio":
      case "ssh": {
        const command = string(t.command ?? "codex", "command");
        const args = t.args ?? ["app-server", "--listen", "stdio://"];
        if (
          !Array.isArray(args) ||
          args.some((a) => typeof a !== "string" || /[\0\r\n]/.test(a))
        )
          throw new Error("Invalid command arguments");
        transport =
          t.type === "ssh"
            ? { type: "ssh", ssh: parseSsh(t.ssh), command, args }
            : { type: "stdio", command, args };
        break;
      }
      case "websocket": {
        const url = new URL(string(t.url, "WebSocket URL"));
        if (
          !["ws:", "wss:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.hash ||
          url.search
        )
          throw new Error(
            "Use a ws/wss endpoint without embedded credentials, queries or fragments",
          );
        if (
          url.protocol === "ws:" &&
          !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        )
          throw new Error(
            "Remote endpoints require wss; use SSH tunneling for plain ws",
          );
        transport = {
          type: "websocket",
          url: url.href,
          ...tokenEnvironment(t.tokenEnv),
        };
        break;
      }
      case "unix":
        transport = {
          type: "unix",
          socketPath: absolute(t.socketPath, "socketPath"),
        };
        break;
      case "ssh-websocket": {
        const host = string(t.host ?? "127.0.0.1", "tunnel host");
        if (!/^[a-zA-Z0-9_.-]+$/.test(host))
          throw new Error("Invalid tunnel host");
        transport = {
          type: "ssh-websocket",
          ssh: parseSsh(t.ssh),
          host,
          port: port(t.port),
          ...tokenEnvironment(t.tokenEnv),
        };
        break;
      }
      case "companion": {
        const command = string(t.command ?? "codex", "command");
        const args = t.args ?? ["app-server", "--listen", "stdio://"];
        if (
          !Array.isArray(args) ||
          args.some((a) => typeof a !== "string" || /[\0\r\n]/.test(a))
        )
          throw new Error("Invalid command arguments");
        transport = {
          type: "companion",
          agentTokenEnv: requiredTokenEnvironment(t.agentTokenEnv),
          command,
          args,
        };
        break;
      }
      case "desktop": {
        if (
          Object.keys(t).some((key) => !["type", "agentTokenEnv"].includes(key))
        )
          throw new Error(
            "Desktop transport accepts only agentTokenEnv; it cannot launch a runtime",
          );
        transport = {
          type: "desktop",
          agentTokenEnv: requiredTokenEnvironment(t.agentTokenEnv),
        };
        break;
      }
      default:
        throw new Error("Unknown backend transport");
    }
    const cwd = string(b.cwd, "backend cwd");
    if (!(path.posix.isAbsolute(cwd) || path.win32.isAbsolute(cwd)))
      throw new Error("Backend cwd must be absolute on its host");
    return {
      id,
      label: string(b.label ?? id, "backend label"),
      cwd,
      transport,
    };
  });
  const origins = value.allowedOrigins ?? [];
  if (
    !Array.isArray(origins) ||
    origins.some(
      (o) =>
        typeof o !== "string" ||
        !(
          new URL(o).origin === o &&
          ["http:", "https:"].includes(new URL(o).protocol)
        ),
    )
  )
    throw new Error("allowedOrigins must contain exact origins");
  return {
    host: string(value.host ?? "127.0.0.1", "host"),
    port: port(value.port ?? 8215),
    statePath: absolute(value.statePath, "statePath"),
    token,
    allowedOrigins: origins,
    backends,
  };
}

export async function readConfig(filename: string): Promise<GatewayConfig> {
  return parseConfig(
    JSON.parse(await fs.readFile(filename, "utf8")),
    process.env.CODEX_WEB_GATEWAY_TOKEN ?? "",
  );
}
