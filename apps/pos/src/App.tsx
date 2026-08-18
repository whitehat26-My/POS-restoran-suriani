import { useEffect, useState } from "react";

import { api, type Outlet } from "./api";
import { Till } from "./parts/Till";

/**
 * PIN login, then the till. The session lives in an HttpOnly cookie; if a
 * stored session is still valid the outlets call simply succeeds and login is
 * skipped.
 */
export function App() {
  const [outlets, setOutlets] = useState<Outlet[] | null>(null);
  const [checked, setChecked] = useState(false);
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .outlets()
      .then((r) => setOutlets(r.outlets))
      .catch(() => {})
      .finally(() => setChecked(true));
  }, []);

  const login = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.login(phone.trim(), pin.trim());
      const r = await api.outlets();
      setOutlets(r.outlets);
    } catch {
      setError("Nombor telefon atau PIN salah.");
    } finally {
      setBusy(false);
    }
  };

  if (!checked) return <div className="login" />;

  if (!outlets) {
    return (
      <div className="login">
        <form
          className="login-card"
          onSubmit={(e) => {
            e.preventDefault();
            void login();
          }}
        >
          <div className="login-brand">
            <div className="login-mark">SP</div>
            <div>
              <div className="login-title">Suriani POS</div>
              <div className="login-sub">Log masuk kaunter</div>
            </div>
          </div>
          <input
            className="field"
            placeholder="No. telefon"
            inputMode="tel"
            autoComplete="username"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <input
            className="field"
            placeholder="PIN"
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
          {error && <div className="login-err">{error}</div>}
          <button className="btn" disabled={busy || !phone || !pin}>
            {busy ? "Sekejap…" : "Masuk"}
          </button>
        </form>
      </div>
    );
  }

  return <Till outlets={outlets} />;
}
