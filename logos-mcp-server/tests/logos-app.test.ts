import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
const platformMock = vi.hoisted(() => vi.fn());
const promisifyMock = vi.hoisted(
  () =>
    (fn: (...args: unknown[]) => void) =>
    (...args: unknown[]) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        fn(...args, (error: Error | null, stdout: string, stderr: string) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        });
      })
);

vi.mock("child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("util", async () => {
  const actual = await vi.importActual<typeof import("util")>("util");
  return {
    ...actual,
    promisify: promisifyMock,
  };
});

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    platform: platformMock,
  };
});

describe("logos-app", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    execFileMock.mockReset();
    platformMock.mockReset();
    // Default: process checks report Logos as running, launches succeed.
    execFileMock.mockImplementation((...args: unknown[]) => {
      const command = args[0] as string;
      const callback = args[args.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
      if (command === "tasklist") {
        callback(null, "Logos.exe                    1234 Console", "");
      } else if (command === "osascript") {
        callback(null, "true\n", "");
      } else {
        callback(null, "", "");
      }
    });
  });

  it("uses rundll32 on Windows so query-string URLs bypass cmd parsing", async () => {
    platformMock.mockReturnValue("win32");
    const logosApp = await import("../src/services/logos-app.js");

    await logosApp.searchAll("grace & peace");

    expect(execFileMock).toHaveBeenCalledWith(
      "rundll32.exe",
      ["url.dll,FileProtocolHandler", "logos4:///Search?kind=AllSearch&syntax=v2&q=grace%20%26%20peace"],
      { windowsHide: true },
      expect.any(Function)
    );
  });

  it("uses the same Windows launcher for guide URLs with multiple query parameters", async () => {
    platformMock.mockReturnValue("win32");
    const logosApp = await import("../src/services/logos-app.js");

    await logosApp.openGuide("Passage Guide", "Romans 8:28");

    expect(execFileMock).toHaveBeenCalledWith(
      "rundll32.exe",
      ["url.dll,FileProtocolHandler", "logos4:///Guide?t=Passage%20Guide&ref=bible.Ro8.28"],
      { windowsHide: true },
      expect.any(Function)
    );
  });

  it("uses the macOS open command for Logos URLs", async () => {
    platformMock.mockReturnValue("darwin");
    const logosApp = await import("../src/services/logos-app.js");

    await logosApp.openFactbook("Moses");

    expect(execFileMock).toHaveBeenCalledWith(
      "open",
      ["logos4:///Factbook?ref=Moses"],
      expect.any(Function)
    );
  });

  it("uses tasklist to detect a running Logos process on Windows", async () => {
    platformMock.mockReturnValue("win32");
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
      callback(null, "Logos.exe                    1234 Console                    1     12,000 K", "");
    });
    const logosApp = await import("../src/services/logos-app.js");

    await expect(logosApp.isLogosRunning()).resolves.toBe(true);
    expect(execFileMock).toHaveBeenCalledWith(
      "tasklist",
      ["/FI", "IMAGENAME eq Logos.exe", "/NH"],
      expect.any(Function)
    );
  });

  it("returns false when tasklist shows no running Logos process", async () => {
    platformMock.mockReturnValue("win32");
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
      callback(null, "INFO: No tasks are running which match the specified criteria.", "");
    });
    const logosApp = await import("../src/services/logos-app.js");

    await expect(logosApp.isLogosRunning()).resolves.toBe(false);
  });

  it("uses AppleScript to detect a running Logos process on macOS", async () => {
    platformMock.mockReturnValue("darwin");
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
      callback(null, "true\n", "");
    });
    const logosApp = await import("../src/services/logos-app.js");

    await expect(logosApp.isLogosRunning()).resolves.toBe(true);
    expect(execFileMock).toHaveBeenCalledWith(
      "osascript",
      [
        "-e",
        'tell application "System Events" to (name of processes) contains "Logos"',
      ],
      expect.any(Function)
    );
  });

  it("falls back to the Logos web app when Logos is not running (auto mode)", async () => {
    platformMock.mockReturnValue("win32");
    execFileMock.mockImplementation((...args: unknown[]) => {
      const command = args[0] as string;
      const callback = args[args.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
      if (command === "tasklist") {
        callback(null, "INFO: No tasks are running which match the specified criteria.", "");
      } else {
        callback(null, "", "");
      }
    });
    const logosApp = await import("../src/services/logos-app.js");

    const result = await logosApp.openFactbook("Moses");

    expect(result).toMatchObject({
      success: true,
      target: "web",
      command: "https://app.logos.com/factbook?q=Moses",
    });
    expect(result.note).toMatch(/search Factbook/);
    // Only the browser launch of the web URL, never the logos4: protocol URL
    expect(execFileMock).not.toHaveBeenCalledWith(
      "rundll32.exe",
      ["url.dll,FileProtocolHandler", expect.stringContaining("logos4:")],
      expect.anything(),
      expect.anything()
    );
  });

  it("errors instead of falling back when LOGOS_MODE=desktop", async () => {
    vi.stubEnv("LOGOS_MODE", "desktop");
    platformMock.mockReturnValue("win32");
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
      callback(null, "INFO: No tasks are running which match the specified criteria.", "");
    });
    const logosApp = await import("../src/services/logos-app.js");

    const result = await logosApp.openFactbook("Moses");

    expect(result.success).toBe(false);
    expect(result.target).toBe("desktop");
    expect(result.error).toMatch(/does not appear to be running.*LOGOS_MODE=auto/s);
  });

  it("goes straight to the web app when LOGOS_MODE=web, without a process check", async () => {
    vi.stubEnv("LOGOS_MODE", "web");
    platformMock.mockReturnValue("darwin");
    const logosApp = await import("../src/services/logos-app.js");

    const result = await logosApp.searchAll("grace");

    expect(result).toMatchObject({
      success: true,
      target: "web",
      command: "https://app.logos.com/search?q=grace",
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith("open", ["https://app.logos.com/search?q=grace"], expect.any(Function));
  });

  it("uses ref.ly and xdg-open for passages on Linux", async () => {
    platformMock.mockReturnValue("linux");
    const logosApp = await import("../src/services/logos-app.js");

    const result = await logosApp.navigateToPassage("John 3:16");

    expect(result).toMatchObject({
      success: true,
      target: "web",
      command: "https://ref.ly/Jn3.16",
      launcher: "xdg-open",
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith("xdg-open", ["https://ref.ly/Jn3.16"], expect.any(Function));
  });

  it("falls back to the web app when the desktop protocol launch fails in auto mode", async () => {
    platformMock.mockReturnValue("darwin");
    execFileMock.mockImplementation((...args: unknown[]) => {
      const command = args[0] as string;
      const url = (args[1] as string[])[0] ?? "";
      const callback = args[args.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
      if (command === "osascript") {
        callback(null, "true\n", "");
      } else if (url.startsWith("logos4:")) {
        callback(new Error("no application to open URL"), "", "");
      } else {
        callback(null, "", "");
      }
    });
    const logosApp = await import("../src/services/logos-app.js");

    const result = await logosApp.navigateToPassage("John 3:16");

    expect(result).toMatchObject({ success: true, target: "web", command: "https://ref.ly/Jn3.16" });
  });

  it("builds ref.ly resource URLs without the LLS: prefix", async () => {
    vi.stubEnv("LOGOS_MODE", "web");
    platformMock.mockReturnValue("darwin");
    const logosApp = await import("../src/services/logos-app.js");

    const result = await logosApp.openResource("LLS:NICOT24GOLDINGAY", "bible.24.1.1");

    expect(result.command).toBe("https://ref.ly/logosres/nicot24goldingay;ref=bible.24.1.1");
  });

  it("still launches when the running check is inconclusive", async () => {
    platformMock.mockReturnValue("win32");
    execFileMock.mockImplementation((...args: unknown[]) => {
      const command = args[0] as string;
      const callback = args[args.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
      if (command === "tasklist") {
        callback(new Error("tasklist unavailable"), "", "");
      } else {
        callback(null, "", "");
      }
    });
    const logosApp = await import("../src/services/logos-app.js");

    await expect(logosApp.openFactbook("Moses")).resolves.toMatchObject({ success: true });
  });

  it("returns null from isLogosRunning on unsupported platforms", async () => {
    platformMock.mockReturnValue("linux");
    const logosApp = await import("../src/services/logos-app.js");

    await expect(logosApp.isLogosRunning()).resolves.toBeNull();
  });

  it("reports command failures as unsuccessful results after both targets fail", async () => {
    platformMock.mockReturnValue("win32");
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
      callback(new Error("start failed"), "", "");
    });
    const logosApp = await import("../src/services/logos-app.js");

    // Desktop attempt fails, then the web fallback fails too — the final
    // result reflects the last attempted target.
    await expect(logosApp.searchAll("grace")).resolves.toMatchObject({
      success: false,
      command: "https://app.logos.com/search?q=grace",
      target: "web",
      launcher: "rundll32.exe",
      error: "start failed",
    });
  });
});