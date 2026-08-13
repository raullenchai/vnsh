import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";

interface CredentialFile {
  host: string;
  token: string;
}

interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export function credentialPath(): string {
  return (
    process.env.VNSH_CONFIG ||
    path.join(os.homedir(), ".config", "vnsh", "credentials.json")
  );
}

export function loadToken(host: string): string | null {
  if (process.env.VNSH_TOKEN) return process.env.VNSH_TOKEN;
  try {
    const saved = JSON.parse(
      fs.readFileSync(credentialPath(), "utf8"),
    ) as CredentialFile;
    return saved.host === host && typeof saved.token === "string"
      ? saved.token
      : null;
  } catch {
    return null;
  }
}

export function saveToken(host: string, token: string): void {
  const file = credentialPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ host, token })}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

export function clearToken(): boolean {
  try {
    fs.unlinkSync(credentialPath());
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function openBrowser(url: string): boolean {
  try {
    const command =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]];
    const child = spawn(command[0] as string, command[1] as string[], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function deviceLogin(
  host: string,
  onVerification: (details: DeviceStart) => void,
): Promise<string> {
  const accountHost =
    new URL(host).hostname === "vnsh.dev" ? "https://account.vnsh.dev" : host;
  const start = await fetch(`${accountHost}/api/auth/device`, {
    method: "POST",
    headers: { "X-Vnsh-Client": "cli-login" },
  });
  if (!start.ok)
    throw new Error(`Could not start login (HTTP ${start.status})`);
  const device = (await start.json()) as DeviceStart;
  onVerification(device);
  const deadline = Date.now() + device.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, device.interval) * 1000),
    );
    const response = await fetch(`${accountHost}/api/auth/device/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vnsh-Client": "cli-login",
      },
      body: JSON.stringify({ device_code: device.device_code }),
    });
    if (response.status === 202) continue;
    if (!response.ok) throw new Error(`Login failed (HTTP ${response.status})`);
    const result = (await response.json()) as { token?: string };
    if (!result.token)
      throw new Error("Login response did not include a token");
    return result.token;
  }
  throw new Error("Login timed out. Run `vn login` to try again.");
}
