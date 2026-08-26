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
            reject(Object.assign(error, { stdout, stderr }));
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
  return { ...actual, promisify: promisifyMock };
});

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return { ...actual, platform: platformMock };
});

function b64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

function respondWith(stdout: string) {
  execFileMock.mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
    callback(null, stdout, "");
  });
}

describe("mergePages", () => {
  it("drops the overlapping region between consecutive pages", async () => {
    const { mergePages } = await import("../src/services/ui-automation-reader.js");
    const shared = "This overlapping sentence is long enough to be detected as shared.";
    const result = mergePages([`First page body. ${shared}`, `${shared} Second page body.`]);

    expect(result.pageCount).toBe(2);
    expect(result.text).toBe(`First page body. ${shared} Second page body.`);
  });

  it("skips consecutive duplicate pages", async () => {
    const { mergePages } = await import("../src/services/ui-automation-reader.js");
    const page = "Same content captured twice because the document stopped scrolling.";
    const result = mergePages([page, page]);

    expect(result.pageCount).toBe(1);
    expect(result.text).toBe(page);
  });

  it("joins non-overlapping pages with a paragraph break", async () => {
    const { mergePages } = await import("../src/services/ui-automation-reader.js");
    const result = mergePages(["Completely distinct first page.", "Completely distinct second page."]);

    expect(result.text).toBe("Completely distinct first page.\n\nCompletely distinct second page.");
  });

  it("ignores overlaps shorter than the minimum threshold", async () => {
    const { mergePages } = await import("../src/services/ui-automation-reader.js");
    // "the Lord" appears at the seam but is far too short to be a real page overlap.
    const result = mergePages(["First page ends with the Lord", "the Lord begins the second page"]);

    expect(result.text).toContain("the Lord\n\nthe Lord");
  });

  it("handles empty input", async () => {
    const { mergePages } = await import("../src/services/ui-automation-reader.js");
    expect(mergePages([])).toEqual({ text: "", pageCount: 0 });
    expect(mergePages(["", "   "])).toEqual({ text: "", pageCount: 0 });
  });
});

describe("parseAutomationOutput", () => {
  it("finds the result JSON even with warning noise printed before it", async () => {
    const { parseAutomationOutput } = await import("../src/services/ui-automation-reader.js");
    const output = [
      "WARNING: some module noise",
      '{"not":"the result"} trailing garbage making this line invalid json[',
      '{"success":true,"tabName":"ESV","pages":["QQ=="]}',
      "",
    ].join("\n");

    expect(parseAutomationOutput(output)).toEqual({ success: true, tabName: "ESV", pages: ["QQ=="] });
  });

  it("normalizes a single collapsed page back into an array", async () => {
    const { parseAutomationOutput } = await import("../src/services/ui-automation-reader.js");
    const parsed = parseAutomationOutput('{"success":true,"tabName":"ESV","pages":"QQ=="}');

    expect(parsed.pages).toEqual(["QQ=="]);
  });

  it("normalizes a single collapsed availableTabs entry back into an array (L1)", async () => {
    // ConvertTo-Json collapses a one-element array to a scalar. `pages` was
    // normalized; `availableTabs` was not — so with exactly one open tab and a
    // non-matching tab_name, `.length > 0` was true (string length) and
    // `.join(", ")` threw a TypeError, replacing the helpful "Open tabs: ESV"
    // message with a crash.
    const { parseAutomationOutput } = await import("../src/services/ui-automation-reader.js");
    const parsed = parseAutomationOutput('{"success":false,"error":"No matching document","availableTabs":"ESV"}');

    expect(parsed.availableTabs).toEqual(["ESV"]);
  });

  it("throws with an excerpt when no JSON is present", async () => {
    const { parseAutomationOutput } = await import("../src/services/ui-automation-reader.js");
    expect(() => parseAutomationOutput("powershell exploded")).toThrow(/No JSON in PowerShell output/);
  });
});

describe("readResourceText", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    platformMock.mockReset();
  });

  it("requires Windows", async () => {
    platformMock.mockReturnValue("darwin");
    const { readResourceText } = await import("../src/services/ui-automation-reader.js");

    await expect(readResourceText()).rejects.toThrow(/requires Windows/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("invokes PowerShell with safe parameter passing and merges pages", async () => {
    platformMock.mockReturnValue("win32");
    const shared = "shared boundary text that is long enough to count as page overlap";
    respondWith(JSON.stringify({
      success: true,
      tabName: "Guide for the Perplexed",
      pages: [b64(`Opening text. ${shared}`), b64(`${shared} Closing text.`)],
    }));
    const { readResourceText } = await import("../src/services/ui-automation-reader.js");

    const result = await readResourceText('Guide "quoted" *name*', 3);

    expect(result.tabName).toBe("Guide for the Perplexed");
    expect(result.pageCount).toBe(2);
    expect(result.text).toBe(`Opening text. ${shared} Closing text.`);
    expect(result.charCount).toBe(result.text.length);

    const [command, args, options] = execFileMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(command).toBe("powershell");
    expect(args).toContain("-File");
    expect(args).toContain('-TabName:Guide "quoted" *name*');
    const pagesIndex = args.indexOf("-MaxPages");
    expect(args[pagesIndex + 1]).toBe("3");
    expect(options.windowsHide).toBe(true);
  });

  it("binds a leading-dash tab name as a value, not a parameter name (regression)", async () => {
    platformMock.mockReturnValue("win32");
    respondWith(JSON.stringify({ success: true, tabName: "-MaxPages Study", pages: [b64("text")] }));
    const { readResourceText } = await import("../src/services/ui-automation-reader.js");

    await readResourceText("-MaxPages", 2);

    const args = execFileMock.mock.calls[0][1] as string[];
    // The value rides inside a single `-TabName:<value>` token…
    expect(args).toContain("-TabName:-MaxPages");
    // …so no bare "-TabName" token exists for the binder to leave dangling.
    expect(args).not.toContain("-TabName");
    expect(args.filter((a) => a === "-MaxPages")).toHaveLength(1);
  });

  it("omits -TabName entirely when no tab filter is given", async () => {
    platformMock.mockReturnValue("win32");
    respondWith(JSON.stringify({ success: true, tabName: "ESV", pages: [b64("text")] }));
    const { readResourceText } = await import("../src/services/ui-automation-reader.js");

    await readResourceText();

    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args.some((a) => a.startsWith("-TabName"))).toBe(false);
  });

  it("uses a distinct temp script path per invocation (regression: pid-only path races)", async () => {
    platformMock.mockReturnValue("win32");
    respondWith(JSON.stringify({ success: true, tabName: "ESV", pages: [b64("text")] }));
    const { readResourceText } = await import("../src/services/ui-automation-reader.js");

    await readResourceText();
    await readResourceText();

    const scriptPaths = execFileMock.mock.calls.map((call) => {
      const args = call[1] as string[];
      return args[args.indexOf("-File") + 1];
    });
    expect(scriptPaths).toHaveLength(2);
    // Both paths carry the pid plus a per-call unique suffix…
    for (const path of scriptPaths) {
      expect(path).toMatch(new RegExp(`logos-uia-${process.pid}-[0-9a-f-]+\\.ps1$`));
    }
    // …and never collide across invocations.
    expect(scriptPaths[0]).not.toBe(scriptPaths[1]);
  });

  it("scales the timeout with the requested page count", async () => {
    platformMock.mockReturnValue("win32");
    respondWith(JSON.stringify({ success: true, tabName: "ESV", pages: [b64("text")] }));
    const { readResourceText } = await import("../src/services/ui-automation-reader.js");

    await readResourceText(undefined, 50);

    const options = execFileMock.mock.calls[0][2] as { timeout: number };
    expect(options.timeout).toBe(30_000 + 50 * 2_500);
  });

  it("surfaces available tabs when the filter matches nothing", async () => {
    platformMock.mockReturnValue("win32");
    respondWith(JSON.stringify({
      success: false,
      error: "No matching document found for tab filter",
      availableTabs: ["ESV", "NICOT Genesis"],
    }));
    const { readResourceText } = await import("../src/services/ui-automation-reader.js");

    await expect(readResourceText("Calvin")).rejects.toThrow(/Open tabs: ESV, NICOT Genesis/);
  });

  it("recovers stdout when PowerShell exits non-zero but printed a result", async () => {
    platformMock.mockReturnValue("win32");
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
      callback(new Error("exit 1"), JSON.stringify({ success: true, tabName: "ESV", pages: [b64("recovered text")] }), "");
    });
    const { readResourceText } = await import("../src/services/ui-automation-reader.js");

    await expect(readResourceText()).resolves.toMatchObject({ text: "recovered text" });
  });

  it("includes stderr in the error when PowerShell produces no output", async () => {
    platformMock.mockReturnValue("win32");
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
      callback(new Error("spawn failed"), "", "Add-Type : assembly not found");
    });
    const { readResourceText } = await import("../src/services/ui-automation-reader.js");

    await expect(readResourceText()).rejects.toThrow(/PowerShell execution failed.*assembly not found/s);
  });

  it("gives a single open tab as an array in the helpful error (L1)", async () => {
    platformMock.mockReturnValue("win32");
    respondWith(JSON.stringify({
      success: false,
      error: "No matching document found for tab filter",
      availableTabs: "ESV",   // ConvertTo-Json collapsed the one-element array
    }));
    const { readResourceText } = await import("../src/services/ui-automation-reader.js");

    await expect(readResourceText("Calvin")).rejects.toThrow(/Open tabs: ESV/);
  });

  it("serializes overlapping reads against the single foreground window (M4)", async () => {
    // Two concurrent calls each ran SetForegroundWindow + SendKeys "{PGDN}"
    // against the SAME window, so each captured pages the other had scrolled
    // past and mergePages produced garbled text for both — with success: true.
    platformMock.mockReturnValue("win32");
    let inFlight = 0;
    let maxInFlight = 0;
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        callback(null, JSON.stringify({ success: true, tabName: "ESV", pages: [b64("page text")] }), "");
      }, 20);
    });
    const { readResourceText } = await import("../src/services/ui-automation-reader.js");

    await Promise.all([readResourceText("A"), readResourceText("B"), readResourceText("C")]);
    expect(maxInFlight).toBe(1);
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("a failed read does not poison the queue for the next caller (M4)", async () => {
    platformMock.mockReturnValue("win32");
    let call = 0;
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (error: Error | null, stdout: string, stderr: string) => void;
      call += 1;
      if (call === 1) {
        callback(new Error("spawn failed"), "", "boom");
        return;
      }
      callback(null, JSON.stringify({ success: true, tabName: "ESV", pages: [b64("second call")] }), "");
    });
    const { readResourceText } = await import("../src/services/ui-automation-reader.js");

    const [first, second] = await Promise.allSettled([readResourceText("A"), readResourceText("B")]);
    expect(first.status).toBe("rejected");
    expect(second.status).toBe("fulfilled");
  });
});
