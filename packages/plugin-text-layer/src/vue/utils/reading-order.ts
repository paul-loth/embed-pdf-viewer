import type { PdfTextRun } from '@embedpdf/models';

/**
 * Sort text runs into natural reading order (top-to-bottom, left-to-right).
 * Runs whose vertical centres fall within half a line-height of each other
 * are treated as the same row and sorted left-to-right.
 */
export function sortByReadingOrder(runs: PdfTextRun[]): PdfTextRun[] {
  return [...runs].sort((a, b) => {
    const ay = a.rect.origin.y;
    const by = b.rect.origin.y;
    const rowTolerance = Math.min(a.fontSize, b.fontSize) * 0.5;

    if (Math.abs(ay - by) > rowTolerance) {
      return ay - by;
    }
    return a.rect.origin.x - b.rect.origin.x;
  });
}
