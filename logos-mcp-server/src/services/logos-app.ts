import { execFile } from "child_process";
import { platform } from "os";
import { promisify } from "util";
import { LOGOS_MODE } from "../config.js";
import { toLogosUrlRef } from "./reference-parser.js";
import type { LogosCommandResult } from "../types.js";

const execFileAsync = promisify(execFile);

const WEB_APP_BASE = "https://app.logos.com";

function launcherForCurrentPlatform(): string {
  switch (platform()) {
    case "win32": return "rundll32.exe";
    case "darwin": return "open";
    default: return "xdg-open";
  }
}

// The Logos desktop app only exists on Windows and macOS; elsewhere the web
// app is the only possible target.
function desktopIsPossible(): boolean {
  return platform() === "win32" || platform() === "darwin";
}

// On macOS, `open` exits non-zero for an unregistered URL scheme, so a zero
// exit genuinely confirms the launch. On Windows, rundll32's
// FileProtocolHandler is fire-and-forget: it exits 0 even when the logos4:
// protocol handler is broken or unregistered, so a "successful" desktop
// launch cannot be verified there (and a broken handler will not trip the
// auto-mode web fallback, which only engages on launcher failure).
function desktopLaunchIsVerifiable(): boolean {
  return platform() !== "win32";
}

const UNVERIFIED_DESKTOP_LAUNCH_NOTE =
  "Note: Windows reports protocol launches as successful even when the Logos protocol handler is broken, so this launch could not be verified. If nothing appeared in Logos, the logos4:/logosres: handler may be unregistered — reinstall/repair Logos or set LOGOS_MODE=web to use the Logos web app instead.";

function desktopResult(
  attempt: { success: boolean; error?: string },
  desktopUrl: string,
  launcher: string,
): LogosCommandResult {
  const verified = attempt.success ? desktopLaunchIsVerifiable() : undefined;
  return {
    success: attempt.success,
    command: desktopUrl,
    launcher,
    target: "desktop",
    verified,
    note: verified === false ? UNVERIFIED_DESKTOP_LAUNCH_NOTE : undefined,
    error: attempt.error,
  };
}

async function launchUrl(url: string): Promise<{ success: boolean; error?: string }> {
  try {
    if (platform() === "win32") {
      // Use the registered protocol handler directly so URLs with '&' are not parsed by cmd.exe.
      await execFileAsync("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
        windowsHide: true,
      });
    } else if (platform() === "darwin") {
      await execFileAsync("open", [url]);
    } else {
      await execFileAsync("xdg-open", [url]);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface LaunchTarget {
  desktopUrl: string;
  webUrl: string;
  /** Caveat surfaced to the caller when the web app cannot deep-link precisely. */
  webNote?: string;
}

/**
 * Open a Logos target according to LOGOS_MODE:
 *  - "desktop": require the installed app (error when it is not running)
 *  - "web":     always open the Logos web app in the default browser
 *  - "auto":    desktop when Logos is running; otherwise fall back to the web app
 */
async function openInLogos(target: LaunchTarget): Promise<LogosCommandResult> {
  const launcher = launcherForCurrentPlatform();

  if (LOGOS_MODE !== "web") {
    const running = desktopIsPossible() ? await isLogosRunning() : false;

    if (LOGOS_MODE === "desktop") {
      if (running === false) {
        return {
          success: false,
          command: target.desktopUrl,
          launcher,
          target: "desktop",
          error: "Logos does not appear to be running. Start Logos Bible Software and try again, or set LOGOS_MODE=auto to fall back to the Logos web app.",
        };
      }
      const attempt = await launchUrl(target.desktopUrl);
      return desktopResult(attempt, target.desktopUrl, launcher);
    }

    // auto: try the desktop app unless we know it is not running
    if (running !== false) {
      const attempt = await launchUrl(target.desktopUrl);
      if (attempt.success) {
        return desktopResult(attempt, target.desktopUrl, launcher);
      }
      // Protocol launch failed (e.g., logos4: not registered) — fall back to the web app.
    }
  }

  const webAttempt = await launchUrl(target.webUrl);
  return {
    success: webAttempt.success,
    command: target.webUrl,
    launcher,
    target: "web",
    note: webAttempt.success ? target.webNote : undefined,
    error: webAttempt.error,
  };
}

/**
 * Navigates to a Bible passage in Logos (desktop) or via ref.ly (web).
 */
export async function navigateToPassage(reference: string): Promise<LogosCommandResult> {
  try {
    const logosRef = toLogosUrlRef(reference);
    return openInLogos({
      desktopUrl: `logos4:///Bible/${logosRef}`,
      webUrl: `https://ref.ly/${logosRef}`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, command: `logos4:///Bible/...`, launcher: launcherForCurrentPlatform(), error: msg };
  }
}

export async function openWordStudy(word: string): Promise<LogosCommandResult> {
  const encoded = encodeURIComponent(word);
  return openInLogos({
    desktopUrl: `logos4:///WordStudy?word=${encoded}`,
    webUrl: `${WEB_APP_BASE}/guides?t=${encodeURIComponent("Bible Word Study")}&word=${encoded}`,
    webNote: `If the web app did not open the word study directly, choose "Bible Word Study" in Guides and enter "${word}".`,
  });
}

export async function openFactbook(topic: string): Promise<LogosCommandResult> {
  const encoded = encodeURIComponent(topic);
  return openInLogos({
    desktopUrl: `logos4:///Factbook?ref=${encoded}`,
    webUrl: `${WEB_APP_BASE}/factbook?q=${encoded}`,
    webNote: `If the web app did not open the entry directly, search Factbook for "${topic}".`,
  });
}

/**
 * Opens a resource in Logos with an optional reference.
 * The reference should be in Logos milestone format (e.g., 'bible.24.1.1', 'page.271').
 * Use getResourceReferenceInfo() to discover valid reference types for a given resource.
 */
export async function openResource(
  resourceId: string,
  reference?: string
): Promise<LogosCommandResult> {
  try {
    const encodedId = encodeURIComponent(resourceId);
    const refSuffix = reference ? `;ref=${encodeURIComponent(reference)}` : "";
    // ref.ly resource links use the id without the "LLS:" prefix, lowercased.
    const webId = encodeURIComponent(resourceId.replace(/^LLS:/i, "").toLowerCase());
    return openInLogos({
      desktopUrl: `logosres:${encodedId}${refSuffix}`,
      webUrl: `https://ref.ly/logosres/${webId}${refSuffix}`,
      webNote: "Web access to a resource requires it to be in your Logos library and readable in the web app.",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, command: `logosres:${resourceId}`, launcher: launcherForCurrentPlatform(), error: msg };
  }
}

export async function openGuide(
  guideType: string,
  reference: string
): Promise<LogosCommandResult> {
  try {
    const logosRef = toLogosUrlRef(reference);
    const template = encodeURIComponent(guideType);
    return openInLogos({
      desktopUrl: `logos4:///Guide?t=${template}&ref=bible.${logosRef}`,
      webUrl: `${WEB_APP_BASE}/guides?t=${template}&ref=bible.${logosRef}`,
      webNote: `If the web app did not open the guide directly, choose "${guideType}" in Guides and enter ${reference}.`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, command: "", launcher: launcherForCurrentPlatform(), error: msg };
  }
}

export async function searchAll(query: string): Promise<LogosCommandResult> {
  const encoded = encodeURIComponent(query);
  return openInLogos({
    desktopUrl: `logos4:///Search?kind=AllSearch&syntax=v2&q=${encoded}`,
    webUrl: `${WEB_APP_BASE}/search?q=${encoded}`,
  });
}

/**
 * Detect whether the Logos desktop app is running. Returns null when the
 * check itself is unavailable (unsupported platform or process-listing
 * failure) so callers don't refuse to launch on an inconclusive answer.
 */
export async function isLogosRunning(): Promise<boolean | null> {
  try {
    if (platform() === "win32") {
      const { stdout } = await execFileAsync("tasklist", [
        "/FI", "IMAGENAME eq Logos.exe", "/NH",
      ]);
      return stdout.toLowerCase().includes("logos.exe");
    } else if (platform() === "darwin") {
      const { stdout } = await execFileAsync("osascript", [
        "-e",
        'tell application "System Events" to (name of processes) contains "Logos"',
      ]);
      return stdout.trim() === "true";
    }
    return null;
  } catch {
    return null;
  }
}
