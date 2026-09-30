// /dev/script-extract: runs the browser script extractor (features/script/extract) on a
// picked file and prints the ScriptText as JSON. For e2e/script-extract.spec.ts, which
// checks the pdf.js path in a real browser, and for trying extraction on a real script.
import { useState } from "react";
import { extractScript, ScriptExtractError } from "../../features/script/extract";

export function ScriptExtractDevPage() {
  const [out, setOut] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setOut("");
    setError("");
    try {
      setOut(JSON.stringify(await extractScript(file), null, 2));
    } catch (e) {
      setError(e instanceof ScriptExtractError ? `${e.code}: ${e.message}` : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main style={{ padding: "var(--space-4)" }}>
      <h1>Script extraction</h1>
      <label>
        Script file <input type="file" onChange={(e) => void onFile(e.currentTarget.files?.[0])} />
      </label>
      {busy && <p>Extracting…</p>}
      {error && (
        <p role="alert" data-testid="extract-error">
          {error}
        </p>
      )}
      {out && <pre data-testid="extract-result">{out}</pre>}
    </main>
  );
}
