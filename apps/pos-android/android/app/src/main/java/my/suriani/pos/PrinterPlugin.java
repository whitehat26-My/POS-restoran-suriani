package my.suriani.pos;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Base64;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Set;
import java.util.UUID;

/**
 * The two things a browser can never do.
 *
 * A WebView cannot open a raw socket to a printer on the shop LAN, and it
 * cannot speak Bluetooth Serial Port Profile. Everything else about this
 * product is web; this file exists only because those two capabilities are the
 * difference between a POS that keeps working when the router dies and one
 * that does not.
 *
 * Written in Java rather than Kotlin on purpose: the Capacitor template is
 * Java, and adding the Kotlin Gradle plugin would mean matching its version to
 * AGP for no benefit in two hundred lines of socket handling.
 *
 * Deliberately thin. It moves bytes and reports what happened. All docket
 * layout lives on the server, so fixing a slip is a deploy rather than a visit
 * to a restaurant with a laptop.
 */
@CapacitorPlugin(
    name = "SurianiPrinter",
    permissions = {
        @Permission(
            alias = "bluetooth",
            strings = {
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.BLUETOOTH_SCAN
            }
        )
    }
)
public class PrinterPlugin extends Plugin {

    /** The well-known Serial Port Profile UUID every ESC/POS printer uses. */
    private static final UUID SPP_UUID =
        UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    /**
     * How long to wait for a LAN printer before giving up on it.
     *
     * Short on purpose. A printer that has quietly gone away does not refuse
     * the connection — the socket sits there until the OS gives up, which can
     * be a minute, and the kitchen stands idle through exactly the emergency
     * the Bluetooth fallback exists for. The JS side races the two transports
     * with its own deadline as well; this is the belt to that pair of braces.
     */
    private static final int TCP_CONNECT_TIMEOUT_MS = 1500;
    private static final int TCP_WRITE_TIMEOUT_MS = 8000;

    /**
     * Write ESC/POS bytes to a printer on the shop network.
     *
     * Plain TCP on purpose, and no cleartext exemption is needed for it:
     * Android's network security config governs the HTTP stacks and the
     * WebView, not raw sockets. The till's own traffic to the server stays
     * HTTPS and is still held to that policy.
     */
    @PluginMethod
    public void printTcp(PluginCall call) {
        String host = call.getString("host");
        Integer port = call.getInt("port", 9100);
        String payload = call.getString("data");

        if (host == null || host.trim().isEmpty() || payload == null) {
            call.reject("host and data are required");
            return;
        }

        final byte[] bytes;
        try {
            bytes = Base64.decode(payload, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("bad base64 payload: " + e.getMessage());
            return;
        }

        final int targetPort = port == null ? 9100 : port;
        // Off the main thread: a blocked UI thread on Android is a frozen till.
        new Thread(() -> {
            Socket socket = null;
            try {
                socket = new Socket();
                socket.connect(new InetSocketAddress(host, targetPort), TCP_CONNECT_TIMEOUT_MS);
                socket.setSoTimeout(TCP_WRITE_TIMEOUT_MS);
                OutputStream out = socket.getOutputStream();
                out.write(bytes);
                out.flush();
                JSObject result = new JSObject();
                result.put("transport", "lan");
                call.resolve(result);
            } catch (IOException e) {
                call.reject("lan: " + describe(e));
            } finally {
                closeQuietly(socket);
            }
        }).start();
    }

    /**
     * The same bytes over Bluetooth SPP.
     *
     * This is what keeps the kitchen printing when the router dies: tablet
     * straight to printer, no network in between. The printer must already be
     * paired — pairing during service, in a panic, is not a plan, which is why
     * it is a step in the install runbook.
     */
    @PluginMethod
    public void printBluetooth(PluginCall call) {
        String address = call.getString("address");
        String payload = call.getString("data");

        if (address == null || address.trim().isEmpty() || payload == null) {
            call.reject("address and data are required");
            return;
        }
        if (!hasBluetoothPermission()) {
            call.reject("bluetooth permission not granted");
            return;
        }

        BluetoothAdapter adapter = bluetoothAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("bluetooth is off");
            return;
        }

        final byte[] bytes;
        try {
            bytes = Base64.decode(payload, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("bad base64 payload: " + e.getMessage());
            return;
        }

        new Thread(() -> {
            BluetoothSocket socket = null;
            try {
                BluetoothDevice device = adapter.getRemoteDevice(address);
                // Discovery and a connection attempt fight each other; connects
                // fail intermittently while a scan is running.
                adapter.cancelDiscovery();
                socket = device.createRfcommSocketToServiceRecord(SPP_UUID);
                socket.connect();
                OutputStream out = socket.getOutputStream();
                out.write(bytes);
                out.flush();
                JSObject result = new JSObject();
                result.put("transport", "bluetooth");
                call.resolve(result);
            } catch (IOException e) {
                call.reject("bluetooth: " + describe(e));
            } catch (SecurityException e) {
                call.reject("bluetooth: permission revoked");
            } catch (IllegalArgumentException e) {
                call.reject("bluetooth: not a device address");
            } finally {
                closeQuietly(socket);
            }
        }).start();
    }

    /** Paired devices, so setup offers a list rather than a MAC address box. */
    @PluginMethod
    public void listPaired(PluginCall call) {
        if (!hasBluetoothPermission()) {
            call.reject("bluetooth permission not granted");
            return;
        }
        BluetoothAdapter adapter = bluetoothAdapter();
        if (adapter == null) {
            call.reject("no bluetooth on this device");
            return;
        }

        JSArray devices = new JSArray();
        try {
            Set<BluetoothDevice> bonded = adapter.getBondedDevices();
            if (bonded != null) {
                for (BluetoothDevice device : bonded) {
                    JSObject entry = new JSObject();
                    String name = device.getName();
                    entry.put("name", name == null ? device.getAddress() : name);
                    entry.put("address", device.getAddress());
                    devices.put(entry);
                }
            }
        } catch (SecurityException e) {
            call.reject("bluetooth: permission revoked");
            return;
        }

        JSObject result = new JSObject();
        result.put("devices", devices);
        call.resolve(result);
    }

    /** Ask for BLUETOOTH_CONNECT, which Android 12+ requires at runtime. */
    @PluginMethod
    public void requestBluetoothPermission(PluginCall call) {
        if (hasBluetoothPermission()) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        requestPermissionForAlias("bluetooth", call, "bluetoothPermissionResult");
    }

    @PermissionCallback
    private void bluetoothPermissionResult(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", hasBluetoothPermission());
        call.resolve(result);
    }

    private BluetoothAdapter bluetoothAdapter() {
        BluetoothManager manager =
            ContextCompat.getSystemService(getContext(), BluetoothManager.class);
        return manager == null ? null : manager.getAdapter();
    }

    /**
     * Android 12 moved Bluetooth behind a runtime permission; before that it
     * was granted at install time. Both are still in the field on the cheap
     * tablets this runs on, so both paths have to work.
     */
    private boolean hasBluetoothPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        return ContextCompat.checkSelfPermission(
            getContext(),
            Manifest.permission.BLUETOOTH_CONNECT
        ) == PackageManager.PERMISSION_GRANTED;
    }

    /** A printer error the cashier might act on, not a Java class name. */
    private static String describe(Exception e) {
        String message = e.getMessage();
        return message == null || message.isEmpty()
            ? e.getClass().getSimpleName()
            : message;
    }

    private static void closeQuietly(java.io.Closeable closeable) {
        if (closeable == null) return;
        try {
            closeable.close();
        } catch (IOException ignored) {
            // Closing something already gone is not news.
        }
    }
}
