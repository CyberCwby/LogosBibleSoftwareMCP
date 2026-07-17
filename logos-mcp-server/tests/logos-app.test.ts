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

  it("refuses to launch URLs when Logos is not running", async () => {
    platformMock.mockReturnValue("win32");
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
      callback(null, "INFO: No tasks are running which match the specified criteria.", "");
    });
    const logosApp = await import("../src/services/logos-app.js");

    const result = await logosApp.openFactbook("Moses");

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not appear to be running/);
    expect(execFileMock).not.toHaveBeenCalledWith(
      "rundll32.exe",
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
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

  it("reports command failures as unsuccessful results", async () => {
    platformMock.mockReturnValue("win32");
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
      callback(new Error("start failed"), "", "");
    });
    const logosApp = await import("../src/services/logos-app.js");

    await expect(logosApp.searchAll("grace")).resolves.toEqual({
      success: false,
      command: "logos4:///Search?kind=AllSearch&syntax=v2&q=grace",
      launcher: "rundll32.exe",
      error: "start failed",
    });
  });
});