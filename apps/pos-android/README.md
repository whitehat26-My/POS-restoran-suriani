# The cashier tablet

The till, wrapped in Capacitor so it can do the two things a browser cannot:
open a raw socket to a printer on the shop LAN, and speak Bluetooth when the
router dies.

Everything else — the floor map, the offline outbox, the daily record — is the
same web app served at `/pos/`, unchanged. That is deliberate: the offline
behaviour is exercised on every dev run and in the browser drill rather than
only inside an APK nobody can test in CI.

## Building it

**You do not need to build this yourself.** The `Android APK` workflow builds a
debug APK and attaches it to the run.

> Actions → **Android APK** → the newest run → Artifacts → `suriani-pos-debug-apk`

Download it, unzip, copy `app-debug.apk` to the tablet, and open it. It is a
*debug* build: unsigned for release and fine for your own two tablets, which
is exactly the case direct APK distribution is right for.

To build locally you need Android Studio (or just the SDK) once:

```bash
pnpm build:web                       # from the repo root
pnpm --filter @suriani/pos-android apk
# → android/app/build/outputs/apk/debug/app-debug.apk
```

`cap sync` copies the built till into `www/` and refreshes the native project.

## Installing on a tablet

1. Settings → Security → allow install from unknown sources, for the file manager.
2. Copy the APK across and tap it.
3. Open the app, sign in with a phone number and PIN.
4. **Register the tablet as a print agent** from the till (owner or manager),
   then paste the token into the printer setup screen. The token is shown once.
5. Pair each printer over Bluetooth **now**, in the calm, not during service.
6. Give each printer a **DHCP reservation** on the router. A printer that moves
   IP stops printing silently, which is the worst way for it to fail.

## What the native side does

`android/app/src/main/java/my/suriani/pos/PrinterPlugin.java` — about two
hundred lines, and deliberately dumb. It moves bytes and reports what happened;
all docket layout lives on the server, so fixing a slip is a deploy rather than
a visit to a restaurant with a laptop.

| Method | |
|---|---|
| `printTcp` | Raw socket to `host:9100`, 1.5s connect deadline |
| `printBluetooth` | Serial Port Profile to a paired device |
| `listPaired` | So setup offers a list, not a MAC address box |
| `requestBluetoothPermission` | Android 12+ needs `BLUETOOTH_CONNECT` at runtime |

The choice between them is in `packages/printer`, under test: LAN first, and
Bluetooth if the LAN does not answer **within 1.5 seconds**. The deadline is
the mechanism, not a nicety — a printer that has quietly gone away does not
refuse the connection, it accepts nothing, and the socket sits there until the
OS gives up a minute later. Waiting that long means the kitchen stands idle
through exactly the emergency the fallback exists for.

`BLUETOOTH_SCAN` is declared `neverForLocation`: this app pairs with a printer
on the counter and has no interest in where anyone is. Without that flag
Android would demand the location permission too, which is a thing a
restaurant owner would rightly refuse to grant.

## Still to do

The three outage drills in `docs/PLAN.md` §11 need real hardware and are the
gate before any branch goes live:

- **Internet drill** — unplug the fibre mid-service. Already proven in the
  browser for the till; needs doing once on the tablet.
- **Router drill** — kill the router with the internet up. The kitchen must
  keep printing, over Bluetooth, with nobody touching a setting.
- **Power drill** — pull the plug. On restore everything comes back with no
  lost orders.
