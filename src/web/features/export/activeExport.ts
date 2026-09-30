// The view on screen registers its CSV export here so ⌘K "Export this view as CSV" can run
// it (R26). One at a time: the last mounted view wins; unmounting clears it.

type Exporter = () => void;
let current: Exporter | null = null;

export function setActiveExport(run: Exporter): () => void {
  current = run;
  return () => {
    if (current === run) current = null;
  };
}

export function runActiveExport(): boolean {
  if (!current) return false;
  current();
  return true;
}
