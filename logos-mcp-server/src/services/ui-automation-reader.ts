import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { writeFile, unlink } from "fs/promises";
import { platform, tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface ResourceTextResult {
  tabName: string;
  text: string;
  charCount: number;
  pageCount: number;
}

// The script takes its inputs as PowerShell parameters (passed safely through
// the execFile argument array) rather than string interpolation, so tab names
// containing quotes or wildcard characters cannot break it.
const AUTOMATION_SCRIPT = `param(
    [string]$TabName = "",
    [int]$MaxPages = 1
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Write-Json($obj) { $obj | ConvertTo-Json -Depth 3 -Compress }

function Get-DocumentText($doc) {
    foreach ($pat in $doc.GetSupportedPatterns()) {
        if ($pat.ProgrammaticName -eq "ValuePatternIdentifiers.Pattern") {
            return $doc.GetCurrentPattern($pat).Current.Value
        }
        if ($pat.ProgrammaticName -eq "TextPatternIdentifiers.Pattern") {
            return $doc.GetCurrentPattern($pat).DocumentRange.GetText(-1)
        }
    }
    return ""
}

try {
    $proc = Get-Process -Name "Logos" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $proc) {
        Write-Json @{ success = $false; error = "Logos is not running" }
        exit
    }

    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $pidCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
        $proc.Id
    )
    $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $pidCond)
    if (-not $window) {
        Write-Json @{ success = $false; error = "Logos window not found" }
        exit
    }

    # --- Locate Document elements (CEF: Edit+Document class, WPF: ControlType.Document) ---
    $editCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Edit
    )
    $classCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty,
        "Document"
    )
    $cefCond = New-Object System.Windows.Automation.AndCondition($editCond, $classCond)
    $docTypeCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Document
    )

    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $wantTab = $TabName.ToLowerInvariant()
    $targetDoc = $null
    $targetTab = ""

    # Panels render asynchronously after open_resource, so poll briefly before
    # concluding there is nothing to read.
    for ($attempt = 0; $attempt -lt 6 -and -not $targetDoc; $attempt++) {
        if ($attempt -gt 0) { Start-Sleep -Milliseconds 500 }

        $candidates = @()
        $cefDocs = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cefCond)
        foreach ($d in $cefDocs) { $candidates += $d }
        $wpfDocs = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $docTypeCond)
        foreach ($d in $wpfDocs) { $candidates += $d }

        foreach ($doc in $candidates) {
            $el = $doc
            for ($i = 0; $i -lt 15; $i++) {
                $el = $walker.GetParent($el)
                if (-not $el) { break }
                if ($el.Current.ControlType.ProgrammaticName -eq "ControlType.TabItem") {
                    $tn = $el.Current.Name
                    if ($wantTab -eq "" -or $tn.ToLowerInvariant().Contains($wantTab)) {
                        $hasTextOrValue = $false
                        foreach ($p in $doc.GetSupportedPatterns()) {
                            if ($p.ProgrammaticName -match "Value|Text") { $hasTextOrValue = $true; break }
                        }
                        if ($hasTextOrValue) {
                            $targetDoc = $doc
                            $targetTab = $tn
                        }
                    }
                    break
                }
            }
            if ($targetDoc) { break }
        }
    }

    if (-not $targetDoc) {
        $tabNames = @()
        $tabCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::TabItem
        )
        $tabs = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)
        foreach ($t in $tabs) {
            if ($t.Current.Name.Length -gt 0) { $tabNames += $t.Current.Name }
        }
        if ($TabName -ne "") {
            Write-Json @{ success = $false; error = "No matching document found for tab filter"; availableTabs = $tabNames }
        } else {
            Write-Json @{ success = $false; error = "No document content found in Logos. Make sure a resource is open."; availableTabs = $tabNames }
        }
        exit
    }

    $text = Get-DocumentText $targetDoc
    if ($text.Length -eq 0) {
        Write-Json @{ success = $false; error = "Document found but no text content available" }
        exit
    }

    $pages = @([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text)))

    if ($MaxPages -gt 1) {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32 {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
"@
        $hwnd = $proc.MainWindowHandle
        [void][W32]::ShowWindow($hwnd, 9)
        Start-Sleep -Milliseconds 300
        [void][W32]::SetForegroundWindow($hwnd)
        # Focus the document panel itself so PGDN scrolls it, not whichever
        # control happened to hold keyboard focus.
        try { $targetDoc.SetFocus() } catch {}
        Start-Sleep -Milliseconds 300

        $prev = $text
        for ($pg = 1; $pg -lt $MaxPages; $pg++) {
            [System.Windows.Forms.SendKeys]::SendWait("{PGDN}")
            Start-Sleep -Milliseconds 400

            $newText = Get-DocumentText $targetDoc
            if ($newText.TrimStart().Length -eq 0) { break }
            if ($newText -eq $prev) { break }
            $pages += [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($newText))
            $prev = $newText
        }
    }

    Write-Json @{
        success = $true
        tabName = $targetTab
        pages = $pages
    }
} catch {
    Write-Json @{ success = $false; error = $_.Exception.Message }
}
`;

/**
 * Merge successive page captures into one text. Consecutive pages usually
 * overlap (PGDN scrolls slightly less than a viewport, and CEF panels
 * re-render shared content), so the shared region is detected and dropped
 * instead of duplicated.
 */
export function mergePages(pages: string[]): { text: string; pageCount: number } {
  const cleaned: string[] = [];
  for (const raw of pages) {
    const page = raw.trim();
    if (!page) continue;
    if (cleaned.length > 0 && cleaned[cleaned.length - 1] === page) continue;
    cleaned.push(page);
  }

  if (cleaned.length === 0) return { text: "", pageCount: 0 };

  let text = cleaned[0];
  for (let i = 1; i < cleaned.length; i += 1) {
    const next = cleaned[i];
    const overlap = findOverlap(text, next);
    text += overlap > 0 ? next.slice(overlap) : `\n\n${next}`;
  }
  return { text, pageCount: cleaned.length };
}

// Length of the longest suffix of `prev` that is also a prefix of `next`.
// Overlaps below the minimum are ignored to avoid false matches on short
// repeated phrases.
const MIN_OVERLAP_CHARS = 40;

function findOverlap(prev: string, next: string): number {
  const max = Math.min(prev.length, next.length);
  for (let length = max; length >= MIN_OVERLAP_CHARS; length -= 1) {
    if (prev.endsWith(next.slice(0, length))) return length;
  }
  return 0;
}

interface AutomationOutput {
  success: boolean;
  tabName?: string;
  pages?: string[];
  error?: string;
  availableTabs?: string[];
}

/**
 * Extract the result JSON from raw PowerShell stdout, tolerating warnings or
 * other noise printed before it (the result is always the last JSON line).
 */
export function parseAutomationOutput(rawOutput: string): AutomationOutput {
  const lines = rawOutput.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as AutomationOutput;
      // ConvertTo-Json collapses a single-element array property in some
      // PowerShell versions; normalize pages back to an array.
      if (parsed.pages !== undefined && !Array.isArray(parsed.pages)) {
        parsed.pages = [parsed.pages as unknown as string];
      }
      return parsed;
    } catch {
      // Not the result line — keep scanning.
    }
  }
  throw new Error(`No JSON in PowerShell output. Raw: ${rawOutput.substring(0, 500)}`);
}

/**
 * Read text from an open resource panel in Logos Bible Software
 * using Windows UI Automation.
 *
 * @param tabName  - Optional partial tab name to match (e.g., "Guide for the Perplexed")
 * @param maxPages - Number of pages to read (1 = visible only, >1 = scroll)
 */
export async function readResourceText(
  tabName?: string,
  maxPages?: number,
): Promise<ResourceTextResult> {
  if (platform() !== "win32") {
    throw new Error("Resource text extraction requires Windows");
  }

  const pages = Math.max(1, Math.min(maxPages ?? 1, 50));

  // Unique per invocation (not just per process): concurrent tool calls must
  // not share a script path, or one call's cleanup unlinks the file while the
  // other call's PowerShell may not have read it yet.
  const scriptPath = join(tmpdir(), `logos-uia-${process.pid}-${randomUUID()}.ps1`);
  // The BOM makes Windows PowerShell 5.1 read the file as UTF-8; without it,
  // non-ASCII characters in the script are interpreted as ANSI.
  await writeFile(scriptPath, "\ufeff" + AUTOMATION_SCRIPT, "utf-8");

  const psArgs = [
    "-NoProfile", "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-MaxPages", String(pages),
  ];
  // Attach the tab name with the `-Name:value` form (one argv token) so a
  // value beginning with "-" (e.g. "-MaxPages") cannot be misread as a
  // parameter name by PowerShell's binder. When no tab name is given the
  // parameter is omitted and the script's default ("") applies.
  if (tabName !== undefined && tabName !== "") {
    psArgs.push(`-TabName:${tabName}`);
  }

  let rawOutput = "";
  try {
    try {
      const { stdout } = await execFileAsync(
        "powershell",
        psArgs,
        {
          // Base + per-page budget: each page costs foreground/scroll delays.
          timeout: 30_000 + pages * 2_500,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        },
      );
      rawOutput = stdout;
    } catch (e: unknown) {
      if (e && typeof e === "object" && "stdout" in e) {
        rawOutput = (e as { stdout?: string }).stdout ?? "";
      }
      if (!rawOutput) {
        const stderr = e && typeof e === "object" && "stderr" in e ? (e as { stderr?: string }).stderr : "";
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`PowerShell execution failed: ${msg}${stderr ? `\n${String(stderr).substring(0, 300)}` : ""}`);
      }
    }

    const result = parseAutomationOutput(rawOutput);

    if (!result.success) {
      const errMsg = result.error ?? "Unknown error reading resource text";
      if (result.availableTabs && result.availableTabs.length > 0) {
        throw new Error(`${errMsg}\nOpen tabs: ${result.availableTabs.join(", ")}`);
      }
      throw new Error(errMsg);
    }

    const decoded = (result.pages ?? []).map((b64) => Buffer.from(b64, "base64").toString("utf-8"));
    const merged = mergePages(decoded);
    if (merged.text.length === 0) {
      throw new Error("Document found but no text content available");
    }

    return {
      tabName: result.tabName ?? "",
      text: merged.text,
      charCount: merged.text.length,
      pageCount: merged.pageCount,
    };
  } finally {
    await unlink(scriptPath).catch(() => {});
  }
}
