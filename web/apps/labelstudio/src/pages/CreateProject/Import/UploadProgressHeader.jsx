import { formatFileSize } from "@humansignal/core";
import { Button, Typography } from "@humansignal/ui";

// Aggregate byte-transfer summary shown above the per-file list. See
// UPLOAD_FIX_DESIGN.md §A5.
//
// Extracted from Import.jsx for testability (see TESTING-STATE-MATRIX.md
// IR-SK-*). Pure presentational component — receives all state via props so
// it can be exercised without mounting the full Import page shell (useAPI,
// sampleDatasetAtom, feature flags, etc.).
export const UploadProgressHeader = ({ stats, failedCount, onRetryAll, skippedCount = 0 }) => {
  const hasTotals = stats && stats.totalFiles > 0;
  if (!hasTotals && !failedCount && !skippedCount) return null;
  const remaining = Math.max(0, stats.totalBytes - stats.doneBytes);
  let etaLabel = null;
  if (hasTotals && stats.doneBytes > 0 && stats.startedAt) {
    const elapsed = (Date.now() - stats.startedAt) / 1000;
    if (elapsed > 5) {
      const bytesPerSec = stats.doneBytes / elapsed;
      if (bytesPerSec > 0) {
        const etaSec = remaining / bytesPerSec;
        const h = Math.floor(etaSec / 3600);
        const m = Math.floor((etaSec % 3600) / 60);
        etaLabel = `ETA ${h > 0 ? `${h}h ` : ""}${m}m`;
      }
    }
  }
  const doneFmt = formatFileSize(stats.doneBytes || 0);
  const totalFmt = formatFileSize(stats.totalBytes || 0);
  return (
    <div
      className="flex items-center gap-4 p-2 mb-2 border border-neutral-border-subtle rounded"
      data-testid="tus-aggregate-header"
    >
      <Typography variant="body" size="small" className="flex-1">
        {hasTotals ? (
          <>
            {stats.doneFiles} of {stats.totalFiles} files{" "}
            <span className="text-neutral-content-subtle">
              | {doneFmt} / {totalFmt}
              {etaLabel ? ` | ${etaLabel}` : ""}
              {skippedCount > 0
                ? ` | ${skippedCount} skipped as already uploaded`
                : ""}
            </span>
          </>
        ) : (
          skippedCount > 0 && (
            <span className="text-neutral-content-subtle">
              {skippedCount} file{skippedCount === 1 ? "" : "s"} skipped as already uploaded
            </span>
          )
        )}
      </Typography>
      {failedCount > 0 && (
        <>
          <Typography variant="body" size="small" className="text-negative-content">
            {failedCount} failed
          </Typography>
          <Button size="smaller" look="outlined" onClick={onRetryAll} aria-label="Retry all failed uploads">
            Retry all failed
          </Button>
        </>
      )}
    </div>
  );
};

export default UploadProgressHeader;
