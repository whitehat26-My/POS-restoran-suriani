import { useState } from "react";

import { setApiBase } from "../base";

/**
 * The first thing a tablet asks: where is this restaurant's server?
 *
 * Not baked into the build on purpose. The same APK runs at Jalan Imbi, at
 * Hotel Leo, and at every restaurant onboarded later — an APK per customer is
 * a release process nobody would keep up with.
 */
export function ServerSetup({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState("https://");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const clean = url.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/.+/.test(clean)) {
      setError("Alamat mesti bermula dengan https://");
      return;
    }

    setChecking(true);
    setError(null);
    try {
      // Prove the address before storing it. A typo saved now becomes a
      // tablet that fails to log in for a reason nobody can see.
      const res = await fetch(`${clean}/health`);
      if (!res.ok) throw new Error(String(res.status));
      setApiBase(clean);
      onDone();
    } catch {
      setError("Tidak dapat menghubungi pelayan. Semak alamat dan WiFi.");
      setChecking(false);
    }
  };

  return (
    <div className="login">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="login-brand">
          <div className="login-mark">SP</div>
          <div>
            <div className="login-title">Suriani POS</div>
            <div className="login-sub">Sediakan peranti</div>
          </div>
        </div>

        <p className="setup-help">
          Masukkan alamat pelayan restoran. Tanya sekali sahaja — peranti ini
          akan ingat.
        </p>
        <input
          className="field"
          placeholder="https://order.suriani.my"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        {error && <div className="login-err">{error}</div>}
        <button className="btn" disabled={checking || url.trim().length < 9}>
          {checking ? "Menyemak…" : "Simpan & sambung"}
        </button>
      </form>
    </div>
  );
}
