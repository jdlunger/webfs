/**
 * What the device on the receiving end of a share link sees.
 *
 * The link could have added the drive on its own — everything needed is in
 * it. It asks instead, for one reason: opening a link is not the same act as
 * granting a browser write access to a repository, and only the person
 * holding the phone can tell whether those are the same thing this time. A
 * link arrives from a QR code on someone's screen, a chat message, a photo;
 * the confirmation is where "I meant to do this" gets said out loud.
 *
 * So this names the repository and the branch, says plainly what is about to
 * be stored, and does nothing until it's told to. The token is never shown:
 * whoever is looking at this screen isn't necessarily whoever sent it.
 */
import { describeDrive, driveId, findDrive, validateDrive, type Drive, type GitHubDrive } from "./drives";

export function AcceptDriveDialog({
  drive,
  drives,
  onAccept,
  onClose,
}: {
  drive: GitHubDrive;
  drives: readonly Drive[];
  onAccept: (drive: GitHubDrive) => void;
  onClose: () => void;
}) {
  const already = findDrive(drives, driveId(drive)) !== null;
  // Everything except "you already have this one", which is the ordinary case
  // for a second visit to the same link rather than a problem.
  const refusal = already ? null : validateDrive(drive, drives);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal accept-modal" onClick={event => event.stopPropagation()}>
        <h2>{already ? "Open this drive?" : "Add this drive?"}</h2>

        <p className="accept-drive">
          <strong>{describeDrive(drive)}</strong>
          <span className="accept-branch">{drive.branch}</span>
        </p>

        {refusal ? (
          <p className="modal-error">{refusal}</p>
        ) : already ? (
          <p className="modal-hint">
            You already have this drive on this device. Nothing will be stored or replaced — this just opens it.
          </p>
        ) : (
          <p className="share-warning">
            <strong>This link carries an access token.</strong> Adding the drive stores that token in this browser and
            lets this device read and write <strong>{describeDrive(drive)}</strong> as whoever issued it. Only add it if
            you trust where the link came from — and if this isn't your device, don't.
          </p>
        )}

        <div className="modal-actions">
          <span className="modal-spacer" />
          <button onClick={onClose}>Not now</button>
          <button className="modal-primary" disabled={refusal !== null} onClick={() => onAccept(drive)}>
            {already ? "Open" : "Add drive"}
          </button>
        </div>
      </div>
    </div>
  );
}
