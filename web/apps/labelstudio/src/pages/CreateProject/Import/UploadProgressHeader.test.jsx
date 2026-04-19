/**
 * Render tests for UploadProgressHeader — skip-count presentation.
 *
 * Covers TESTING-STATE-MATRIX.md IR-SK-1 through IR-SK-6.
 *
 * IR-SK-6 in the matrix is framed as "setLastDropSkipped(0) reset at start
 * of consumeItems" — that reset lives in the ImportPage parent, not this
 * component. We exercise the observable consequence of the reset here:
 * when the parent re-renders with a fresh skippedCount after a drop, the
 * header reflects the CURRENT prop value rather than anything carried
 * forward internally. Since UploadProgressHeader is pure with no local
 * state, a rerender from 3 → 0 makes the skip copy disappear entirely,
 * which is the only way "prior drop's skip count does not carry forward"
 * can manifest at the UI layer.
 */

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

// Mock @humansignal/ui at the module boundary — its barrel pulls in
// json-viewer → react-markdown, which ships untranspiled ESM and blows up
// jest's CJS transform pipeline (see libs/ui/jest.config.ts for the
// equivalent workaround used inside the ui lib itself).
//
// These stubs preserve the observable behavior the component relies on:
// Typography renders its children; Button renders as a button with its
// children and forwards onClick/aria-label.
jest.mock("@humansignal/ui", () => ({
  __esModule: true,
  Typography: ({ children, className }) => <span className={className}>{children}</span>,
  Button: ({ children, onClick, "aria-label": ariaLabel }) => (
    <button type="button" onClick={onClick} aria-label={ariaLabel}>
      {children}
    </button>
  ),
}));

// formatFileSize is pure — use the real impl. But @humansignal/core also
// ships mixed ESM; stub it too to keep the test boundary tight.
jest.mock("@humansignal/core", () => ({
  __esModule: true,
  formatFileSize: (bytes) => `${bytes}B`,
}));

import { UploadProgressHeader } from "./UploadProgressHeader";

// Stats factory — mirrors initialStats() in Import.reducer.js. Only the
// fields the header reads are populated.
const statsWithTotals = (overrides = {}) => ({
  totalFiles: 10,
  doneFiles: 3,
  totalBytes: 1000,
  doneBytes: 300,
  startedAt: null, // null skips the ETA branch — keeps the assertion surface small
  ...overrides,
});

const emptyStats = () => ({
  totalFiles: 0,
  doneFiles: 0,
  totalBytes: 0,
  doneBytes: 0,
  startedAt: null,
});

describe("UploadProgressHeader skip-count rendering", () => {
  test("IR-SK-1: skippedCount=0 with no other content → renders nothing", () => {
    const { container } = render(
      <UploadProgressHeader
        stats={emptyStats()}
        failedCount={0}
        onRetryAll={() => {}}
        skippedCount={0}
      />,
    );
    // Component short-circuits to `null` when nothing to show.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("tus-aggregate-header")).toBeNull();
  });

  test("IR-SK-2: skippedCount=1 with no other uploads → singular 'file skipped'", () => {
    render(
      <UploadProgressHeader
        stats={emptyStats()}
        failedCount={0}
        onRetryAll={() => {}}
        skippedCount={1}
      />,
    );
    const header = screen.getByTestId("tus-aggregate-header");
    expect(header).toHaveTextContent("1 file skipped as already uploaded");
    // Singular: not "1 files skipped"
    expect(header).not.toHaveTextContent("1 files skipped");
  });

  test("IR-SK-3: skippedCount=3 with no other uploads → plural 'files skipped'", () => {
    render(
      <UploadProgressHeader
        stats={emptyStats()}
        failedCount={0}
        onRetryAll={() => {}}
        skippedCount={3}
      />,
    );
    expect(screen.getByTestId("tus-aggregate-header")).toHaveTextContent(
      "3 files skipped as already uploaded",
    );
  });

  test("IR-SK-4: skippedCount>0 with active uploads → both totals line AND '| N skipped' suffix", () => {
    render(
      <UploadProgressHeader
        stats={statsWithTotals({ doneFiles: 3, totalFiles: 10 })}
        failedCount={0}
        onRetryAll={() => {}}
        skippedCount={2}
      />,
    );
    const header = screen.getByTestId("tus-aggregate-header");
    // Totals line present:
    expect(header).toHaveTextContent("3 of 10 files");
    // Suffix appended, not a standalone "N files skipped as already uploaded":
    expect(header).toHaveTextContent("| 2 skipped as already uploaded");
    expect(header).not.toHaveTextContent(/2 files skipped as already uploaded/);
  });

  test("IR-SK-5: skippedCount>0 with no other uploads → only skip message, not suffix form", () => {
    render(
      <UploadProgressHeader
        stats={emptyStats()}
        failedCount={0}
        onRetryAll={() => {}}
        skippedCount={5}
      />,
    );
    const header = screen.getByTestId("tus-aggregate-header");
    // Standalone span phrasing ("5 files skipped as already uploaded"), not
    // the "| N skipped" suffix that only appears when totals are present.
    expect(header).toHaveTextContent("5 files skipped as already uploaded");
    expect(header.textContent).not.toMatch(/\|\s*5 skipped/);
    // No "X of Y files" totals copy either:
    expect(header.textContent).not.toMatch(/\d+ of \d+ files/);
  });

  test("IR-SK-6: parent reset from skippedCount=3 → 0 clears skip copy", () => {
    // Simulates consumeItems calling setLastDropSkipped(0) at the start of
    // a new drop — the component must reflect the new prop value with no
    // residual state from the prior render.
    const { rerender, container } = render(
      <UploadProgressHeader
        stats={emptyStats()}
        failedCount={0}
        onRetryAll={() => {}}
        skippedCount={3}
      />,
    );
    expect(screen.getByTestId("tus-aggregate-header")).toHaveTextContent(
      "3 files skipped as already uploaded",
    );

    rerender(
      <UploadProgressHeader
        stats={emptyStats()}
        failedCount={0}
        onRetryAll={() => {}}
        skippedCount={0}
      />,
    );
    // Short-circuits to null — no header element at all.
    expect(container).toBeEmptyDOMElement();
  });
});
