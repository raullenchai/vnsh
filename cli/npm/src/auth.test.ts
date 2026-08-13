import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { clearToken, credentialPath, loadToken, saveToken } from "./auth.js";

const directories: string[] = [];

afterEach(() => {
  delete process.env.VNSH_CONFIG;
  delete process.env.VNSH_TOKEN;
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function useTemporaryConfig() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vnsh-auth-test-"));
  directories.push(directory);
  process.env.VNSH_CONFIG = path.join(directory, "credentials.json");
}

describe("CLI account credentials", () => {
  it("stores the token privately and only returns it for the matching host", () => {
    useTemporaryConfig();
    saveToken("https://vnsh.dev", "secret-token");

    expect(loadToken("https://vnsh.dev")).toBe("secret-token");
    expect(loadToken("https://self-hosted.example")).toBeNull();
    expect(fs.statSync(credentialPath()).mode & 0o777).toBe(0o600);
  });

  it("lets an environment token override the saved login", () => {
    useTemporaryConfig();
    saveToken("https://vnsh.dev", "saved-token");
    process.env.VNSH_TOKEN = "automation-token";
    expect(loadToken("https://vnsh.dev")).toBe("automation-token");
  });

  it("removes a saved login idempotently", () => {
    useTemporaryConfig();
    saveToken("https://vnsh.dev", "secret-token");
    expect(clearToken()).toBe(true);
    expect(clearToken()).toBe(false);
    expect(loadToken("https://vnsh.dev")).toBeNull();
  });
});
