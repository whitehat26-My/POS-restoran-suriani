import { useEffect, useState } from "react";

import { api, type Outlet, type Role } from "./api";
import { needsSetup } from "./base";
import { ServerSetup } from "./parts/ServerSetup";
import { Till } from "./parts/Till";

/**
 * Setup if the device has never been pointed at a restaurant, then PIN login,
 * then the till. In a browser the first step never appears: the till is served
 * by the same Worker as the API, so every path is already relative.
 *
 * The session lives in an HttpOnly cookie in a browser and in a bearer token
 * on the tablet; either way, if a stored session is still valid the outlets
 * call simply succeeds and login is skipped.
 */
export function App() {
  const [outlets, setOutlets] = useState<Outlet[] | null>(null);
  const [role, setRole] = useState<Role>("cashier");
  const [checked, setChecked] = useState(false);
  // Asking every start would be a nuisance; asking once is the whole point.
  const [setup, setSetup] = useState(() => needsSetup());
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Pointless before the tablet knows where to look, and it would burn a
    // failed request on every start.
    if (setup) {
      setChecked(true);
      return;
    }
    api
      .outlets()
      .then((r) => {
        setOutlets(r.outlets);
        setRole(r.role);
      })
      .catch(() => {})
      .finally(() => setChecked(true));
  }, [setup]);

  const login = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.login(phone.trim(), pin.trim());
      const r = await api.outlets();
      setOutlets(r.outlets);
      setRole(r.role);
    } catch {
      setError("Nombor telefon atau PIN salah.");
    } finally {
      setBusy(false);
    }
  };

  if (setup) return <ServerSetup onDone={() => setSetup(false)} />;

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

  return <Till outlets={outlets} role={role} />;
}
