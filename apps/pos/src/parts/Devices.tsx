import { useEffect, useState } from "react";

import { api, type Station } from "../api";
import { apiBase, setApiBase } from "../base";
import {
  askBluetoothPermission,
  forgetAgent,
  isTablet,
  listPairedPrinters,
  loadAgent,
  loadPrinters,
  saveAgent,
  savePrinters,
  testPrint,
  type PrinterMap,
} from "../print";

/**
 * Install day, on one screen.
 *
 * Everything here is per-tablet rather than per-restaurant: the server it
 * talks to, its own print credential, and where each printer sits on the shop
 * network. None of it can live in the build, because the same APK runs at
 * Jalan Imbi, at Hotel Leo and at every restaurant onboarded after them.
 *
 * The order of the sections is the order of the install runbook, and each one
 * ends in something the installer can see happen — a token appearing, paper
 * coming out — rather than a saved setting they have to trust.
 */
export function Devices({
  outletId,
  outletName,
  onSay,
}: {
  outletId: string;
  outletName: string;
  onSay: (msg: string) => void;
}) {
  const [stations, setStations] = useState<Station[]>([]);
  const [printers, setPrinters] = useState<PrinterMap>(() => loadPrinters());
  const [agent, setAgent] = useState(() => loadAgent());
  const [paired, setPaired] = useState<{ name: string; address: string }[]>([]);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, string>>({});

  useEffect(() => {
    api
      .stations(outletId)
      .then((r) => setStations(r.stations.filter((s) => s.enabled === 1)))
      .catch(() => onSay("Tidak dapat membaca senarai stesen"));
  }, [outletId, onSay]);

  // Printers are addressed by target, not by station: two stations pointed at
  // the same kind of paper share one printer, which is how a small shop with
  // a single machine in the kitchen is actually wired.
  const targets = [...new Set(stations.map((s) => s.target))];

  const update = (target: string, patch: Partial<PrinterMap[string]>) => {
    const next = {
      ...printers,
      [target]: { ...printers[target], ...patch },
    };
    setPrinters(next);
    savePrinters(next);
  };

  const register = async () => {
    setBusy("agent");
    try {
      const { token } = await api.registerAgent(
        outletId,
        `Tablet ${outletName.replace("Suriani ", "")}`,
      );
      const credential = { token, outletId, outletName };
      saveAgent(credential);
      setAgent(credential);
      // Shown once, and only because there is nowhere to read it back from.
      // It is stored either way; this is for a second tablet or a laptop
      // agent that needs the same restaurant's queue.
      setFreshToken(token);
      onSay("Ejen cetak didaftarkan");
    } catch {
      onSay("Gagal mendaftar ejen — hanya pemilik boleh");
    } finally {
      setBusy(null);
    }
  };

  const findPaired = async () => {
    setBusy("bluetooth");
    try {
      const permission = await askBluetoothPermission();
      if (!permission.granted) {
        onSay("Kebenaran Bluetooth ditolak");
        return;
      }
      setPaired((await listPairedPrinters()).devices);
    } catch {
      onSay("Bluetooth tidak tersedia pada peranti ini");
    } finally {
      setBusy(null);
    }
  };

  const test = async (station: Station) => {
    setBusy(station.id);
    setResult((prev) => ({ ...prev, [station.target]: "" }));
    try {
      const { transport } = await testPrint(
        station.target,
        station.name,
        outletName,
        printers,
      );
      setResult((prev) => ({
        ...prev,
        [station.target]: `✅ Keluar melalui ${transport === "lan" ? "LAN" : "Bluetooth"}`,
      }));
    } catch (err) {
      setResult((prev) => ({
        ...prev,
        [station.target]: `❌ ${err instanceof Error ? err.message : String(err)}`,
      }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="setup" data-testid="devices">
      <section className="setup-card">
        <h2>Pelayan</h2>
        <p className="setup-help">
          {isTablet()
            ? "Alamat restoran ini. Peranti ini menyimpannya sekali sahaja."
            : "Dalam pelayar, till dilayan oleh pelayan yang sama — tiada alamat untuk ditetapkan."}
        </p>
        {isTablet() && (
          <div className="setup-row">
            <code className="setup-mono">{apiBase() || "(belum ditetapkan)"}</code>
            <button
              className="mini"
              onClick={() => {
                // Clearing the base is what sends the app back to the setup
                // screen on its next start; a reload makes that immediate.
                setApiBase("");
                location.reload();
              }}
            >
              Tukar
            </button>
          </div>
        )}
      </section>

      <section className="setup-card">
        <h2>Ejen cetak</h2>
        <p className="setup-help">
          Kelayakan peranti ini untuk mengambil kerja cetakan. Terhad kepada satu
          cawangan sahaja — ia tidak boleh membaca jualan atau membuka bil.
        </p>
        {agent ? (
          <>
            <div className="setup-row">
              <span className="grow">
                Didaftarkan untuk <strong>{agent.outletName}</strong>
              </span>
              <button
                className="mini"
                onClick={() => {
                  forgetAgent();
                  setAgent(null);
                  setFreshToken(null);
                  onSay("Ejen dilupakan pada peranti ini");
                }}
              >
                Lupakan
              </button>
            </div>
            {agent.outletId !== outletId && (
              <p className="setup-warn">
                Ejen ini milik {agent.outletName}. Cetakan akan keluar di sana,
                bukan di {outletName}.
              </p>
            )}
          </>
        ) : (
          <button className="btn" disabled={busy === "agent"} onClick={() => void register()}>
            {busy === "agent" ? "Sekejap…" : "Daftar peranti ini"}
          </button>
        )}
        {freshToken && (
          <>
            <p className="setup-help">
              Token ini ditunjukkan sekali sahaja. Salin jika peranti lain perlu
              baris cetakan yang sama.
            </p>
            <code className="setup-mono setup-token">{freshToken}</code>
          </>
        )}
      </section>

      <section className="setup-card">
        <h2>Pencetak</h2>
        <p className="setup-help">
          LAN dahulu, Bluetooth apabila router mati. Isi kedua-duanya — itulah
          sebabnya dapur terus mencetak semasa gangguan.
        </p>
        {!isTablet() && (
          <p className="setup-warn">
            Pelayar tidak boleh membuka soket ke pencetak. Buka skrin ini pada
            tablet untuk menetapkan dan menguji.
          </p>
        )}
        <div className="setup-row">
          <button className="mini" disabled={busy === "bluetooth"} onClick={() => void findPaired()}>
            {busy === "bluetooth" ? "Mencari…" : "Cari peranti Bluetooth"}
          </button>
        </div>

        {stations.length === 0 && <p className="empty">Tiada stesen cetak.</p>}
        {stations.map((station) => (
          <div className="setup-station" key={station.id}>
            <div className="setup-station-head">
              {station.name}
              <small>{station.target}</small>
            </div>
            <label className="setup-field">
              <span>Alamat LAN</span>
              <input
                className="field"
                placeholder="192.168.1.50:9100"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                value={printers[station.target]?.lan ?? ""}
                onChange={(e) => update(station.target, { lan: e.target.value.trim() })}
              />
            </label>
            <label className="setup-field">
              <span>Bluetooth</span>
              <select
                className="field"
                value={printers[station.target]?.bluetooth ?? ""}
                onChange={(e) => update(station.target, { bluetooth: e.target.value })}
              >
                <option value="">Tiada</option>
                {/* A previously chosen device stays selectable even when the
                    paired list has not been fetched this session. */}
                {printers[station.target]?.bluetooth &&
                  !paired.some((d) => d.address === printers[station.target]?.bluetooth) && (
                    <option value={printers[station.target]!.bluetooth}>
                      {printers[station.target]!.bluetooth}
                    </option>
                  )}
                {paired.map((d) => (
                  <option key={d.address} value={d.address}>
                    {d.name} · {d.address}
                  </option>
                ))}
              </select>
            </label>
            <div className="setup-row">
              <button
                className="mini mini-go"
                disabled={busy === station.id}
                onClick={() => void test(station)}
              >
                {busy === station.id ? "Mencetak…" : "Uji cetak"}
              </button>
              {result[station.target] && (
                <span className="setup-result grow">{result[station.target]}</span>
              )}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
