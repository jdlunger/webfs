/**
 * The QR code and link that hand a GitHub drive to another device.
 *
 * All of the reasoning about *what* the link is lives in `shareLink.ts`; this
 * is the part that puts it on screen. Two presentation decisions worth
 * knowing:
 *
 * - **The QR is drawn as SVG elements, not injected markup.** The library will
 *   hand over an `<svg>` string, but building it from `isDark()` keeps it out
 *   of `dangerouslySetInnerHTML` and lets the quiet zone and colours be ours.
 * - **It is black on white in both themes.** Scanners expect dark-on-light and
 *   a real quiet zone; a QR code that politely inverted itself in dark mode
 *   would be a QR code that sometimes doesn't scan.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import { SHARE_WARNING, shareLink } from "./shareLink";
import { BASE_PATH } from "./basePath";
import { describeDrive, type GitHubDrive } from "./drives";

/** Modules of quiet zone. Four is what the spec asks for; scanners want it. */
const QUIET = 4;

function QrCode({ text }: { text: string }) {
  const grid = useMemo(() => {
    // 0 picks the smallest type that fits. "M" is the usual balance of
    // capacity against how much damage or glare a scan survives.
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const dark: Array<[number, number]> = [];
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) if (qr.isDark(row, col)) dark.push([row, col]);
    }
    return { count, dark };
  }, [text]);

  const size = grid.count + QUIET * 2;
  return (
    <svg className="share-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code for this drive's link">
      <rect width={size} height={size} fill="#fff" />
      {grid.dark.map(([row, col]) => (
        <rect key={`${row}:${col}`} x={col + QUIET} y={row + QUIET} width={1} height={1} fill="#000" />
      ))}
    </svg>
  );
}

export function ShareDialog({ drive, onClose }: { drive: GitHubDrive; onClose: () => void }) {
  const link = useMemo(() => shareLink(drive, window.location.origin, BASE_PATH), [drive]);
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // No clipboard permission, or an insecure origin. Selecting the text is
      // the fallback every browser has: the user copies it themselves.
      field.current?.select();
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal share-modal" onClick={event => event.stopPropagation()}>
        <h2>Open {describeDrive(drive)} on another device</h2>

        {/* Before the code, not after it: the whole point is that it is read
            before the thing it warns about is photographed. */}
        <p className="share-warning">
          <strong>This link is your access token.</strong> {SHARE_WARNING}
        </p>

        <div className="share-qr-frame">
          <QrCode text={link} />
        </div>

        <p className="modal-hint">
          Scan it, or copy the link. The other device adds{" "}
          <strong>
            {describeDrive(drive)} ({drive.branch})
          </strong>{" "}
          once you confirm there.
        </p>

        <div className="share-link-row">
          <input ref={field} className="share-link" readOnly value={link} onFocus={event => event.target.select()} />
          <button className="modal-primary" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        <div className="modal-actions">
          <span className="modal-spacer" />
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
