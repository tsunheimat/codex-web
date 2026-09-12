import { spawn } from "node:child_process";
import { shellQuote, sshArguments, type Backend } from "./config";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// The same bounded helper runs on the selected execution machine. User paths
// travel in stdin JSON, never inside shell command text. Python is a target
// prerequisite only for file operations, not for app-server connectivity.
const HELPER = String.raw`
import sys, os, json, pathlib, base64, uuid
def main():
    req = json.load(sys.stdin)
    root = pathlib.Path(req['root']).resolve(strict=True)
    if not root.is_dir(): raise ValueError('Workspace root is not a directory')
    def checked(value):
        target = pathlib.Path(value)
        if not target.is_absolute(): target = root / target
        target = target.resolve(strict=True)
        if target != root and root not in target.parents: raise ValueError('Path is outside the configured workspace')
        return target
    action = req['action']
    if action == 'list':
        target = checked(req.get('path') or '.')
        entries = []
        for entry in target.iterdir():
            if len(entries) >= 1000: raise ValueError('Directory exceeds 1000 entries')
            try:
                resolved = checked(str(entry))
                entries.append({'name': entry.name, 'path': str(resolved), 'directory': resolved.is_dir()})
            except (ValueError, OSError): pass
        return {'path': str(target), 'root': str(root), 'entries': sorted(entries, key=lambda e: (not e['directory'], e['name'].lower()))}
    if action == 'read':
        target = checked(req['path'])
        if not target.is_file(): raise ValueError('Expected a regular file')
        with target.open('rb') as f: data = f.read(10485761)
        if len(data) > 10485760: raise ValueError('File exceeds 10 MiB')
        return {'name': target.name, 'data': base64.b64encode(data).decode('ascii')}
    if action == 'upload':
        data = base64.b64decode(req['data'], validate=True)
        if len(data) > 10485760: raise ValueError('Upload exceeds 10 MiB')
        folder = root / '.codex-web-uploads'
        folder.mkdir(mode=0o700, exist_ok=True)
        if folder.is_symlink(): raise ValueError('Upload directory must not be a symlink')
        checked(str(folder))
        # Keep uploads across gateway restarts. The documented quota is per
        # backend and files are removed only through explicit host maintenance.
        total = sum(f.stat().st_size for f in folder.iterdir() if f.is_file())
        if total + len(data) > 104857600: raise ValueError('Workspace upload quota (100 MiB) reached')
        suffix = pathlib.Path(req.get('name', '')).suffix.lower()
        if suffix not in ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.txt', '.pdf', '.md', '.csv']: suffix = '.bin'
        target = folder / (uuid.uuid4().hex + suffix)
        fd = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as f: f.write(data)
        return {'path': str(target), 'bytes': len(data), 'name': req.get('name', '')}
    raise ValueError('Unsupported file action')
try:
    print(json.dumps(main()))
except Exception as error:
    print(json.dumps({'error': str(error)}))
    sys.exit(1)
`;

export async function fileOperation(
  backend: Backend,
  request: Record<string, unknown>,
): Promise<any> {
  const t = backend.transport;
  if (t.type !== "stdio" && t.type !== "ssh")
    throw Object.assign(new Error("This connection has no host file channel"), {
      statusCode: 409,
    });
  const args =
    t.type === "ssh"
      ? [
          ...sshArguments(t.ssh),
          "-T",
          t.ssh.host,
          `python3 -c ${shellQuote(HELPER)}`,
        ]
      : ["-c", HELPER];
  const child = spawn(t.type === "ssh" ? "ssh" : "python3", args, {
    stdio: "pipe",
  });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Host file operation timed out"));
    }, 30_000);
    timer.unref();
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 16 * 1024 * 1024) {
        child.kill("SIGKILL");
        reject(new Error("Host file response too large"));
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(output);
        if (code || result.error)
          reject(
            Object.assign(
              new Error(result.error ?? "Host file operation failed"),
              { statusCode: 400 },
            ),
          );
        else resolve(result);
      } catch {
        reject(
          new Error(
            "Host file channel unavailable; check Python 3 and SSH access",
          ),
        );
      }
    });
    child.stdin.end(JSON.stringify({ ...request, root: backend.cwd }));
  });
}
