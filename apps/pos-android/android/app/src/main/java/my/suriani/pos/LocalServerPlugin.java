package my.suriani.pos;

import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.net.Inet4Address;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The bridge between a socket on the shop's WiFi and the router in JS.
 *
 * The awkward-looking part — a Java thread parking on a queue while
 * JavaScript answers — is what buys the property that matters: there is one
 * ordering implementation, backed by one store, shared with the till. The
 * alternative was a second SQLite database in Java with its own copy of the
 * menu, the prices and the option rules, and a second thing to keep in step
 * with the server. That is the drift this project has refused everywhere else.
 *
 * Every park has a deadline. A till that has been swiped away answers no
 * requests, and the customer gets a clear 503 instead of a spinner.
 */
@CapacitorPlugin(name = "SurianiLocalServer")
public class LocalServerPlugin extends Plugin {

    /** Android cannot bind below 1024 without root. */
    private static final int DEFAULT_PORT = 8080;
    /**
     * How long a socket thread waits for the WebView.
     *
     * Generous enough for a cold IndexedDB read on a cheap tablet, short
     * enough that a customer is told something is wrong rather than left
     * watching a spinner.
     */
    private static final long JS_TIMEOUT_MS = 5_000;

    private final Map<String, SynchronousQueue<LocalHttpServer.LocalResponse>> waiting =
        new ConcurrentHashMap<>();
    private final AtomicLong requestIds = new AtomicLong();

    private LocalHttpServer server;

    @PluginMethod
    public void start(PluginCall call) {
        int port = call.getInt("port", DEFAULT_PORT);
        String address = wifiAddress();
        if (address == null) {
            call.reject("not on wifi");
            return;
        }

        if (server != null && server.isRunning()) {
            call.resolve(state(address, port));
            return;
        }

        server = new LocalHttpServer(getContext(), this::dispatch);
        try {
            server.start(address, port);
        } catch (IOException e) {
            server = null;
            call.reject("could not listen: " + e.getMessage());
            return;
        }

        // The notification is not decoration. Android will not let a process
        // hold a listening socket for a ten-hour shift without one, and staff
        // seeing it is how they know the outage door is actually open.
        Intent intent = new Intent(getContext(), LocalServerService.class);
        intent.putExtra(LocalServerService.EXTRA_ADDRESS, "http://" + address + ":" + port);
        androidx.core.content.ContextCompat.startForegroundService(getContext(), intent);

        call.resolve(state(address, port));
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (server != null) server.stop();
        server = null;
        getContext().stopService(new Intent(getContext(), LocalServerService.class));
        call.resolve();
    }

    /** Where the printed outage QR should point. Shown on the Peranti screen. */
    @PluginMethod
    public void address(PluginCall call) {
        String address = wifiAddress();
        JSObject result = new JSObject();
        result.put("address", address);
        result.put("running", server != null && server.isRunning());
        result.put("served", server == null ? 0 : server.requestsServed());
        call.resolve(result);
    }

    /** The JS router's answer to one request, handed back by request id. */
    @PluginMethod
    public void respond(PluginCall call) {
        String requestId = call.getString("requestId");
        if (requestId == null) {
            call.reject("requestId is required");
            return;
        }
        SynchronousQueue<LocalHttpServer.LocalResponse> queue = waiting.get(requestId);
        if (queue == null) {
            // The socket thread already gave up and answered 503. Nothing to
            // deliver to, and nothing wrong either.
            call.resolve();
            return;
        }

        LocalHttpServer.LocalResponse response = new LocalHttpServer.LocalResponse();
        response.status = call.getInt("status", 200);
        response.json = call.getString("json");
        response.asset = call.getString("asset");
        // offer(), never put(): if the waiter has timed out and gone, this
        // must not block the WebView's thread forever.
        queue.offer(response);
        call.resolve();
    }

    /**
     * Called on a socket thread. Hands the request to JS and waits.
     */
    private LocalHttpServer.LocalResponse dispatch(
        String method, String path, String query, String body, String ip) {

        String requestId = "req_" + requestIds.incrementAndGet();
        SynchronousQueue<LocalHttpServer.LocalResponse> queue = new SynchronousQueue<>();
        waiting.put(requestId, queue);

        try {
            JSObject event = new JSObject();
            event.put("requestId", requestId);
            event.put("method", method);
            event.put("path", path);
            event.put("query", query == null ? "" : query);
            event.put("body", body);
            event.put("ip", ip);
            notifyListeners("request", event);

            return queue.poll(JS_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        } finally {
            waiting.remove(requestId);
        }
    }

    /**
     * This device's address on the shop's WiFi.
     *
     * Read from the active network rather than from WifiManager, which
     * returns an int that has been wrong on dual-stack networks since IPv6
     * existed. If the tablet is not on WiFi there is nothing to bind to and
     * the caller is told so.
     */
    private String wifiAddress() {
        ConnectivityManager manager =
            (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return null;

        Network[] networks = manager.getAllNetworks();
        for (Network network : networks) {
            NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
            if (capabilities == null) continue;
            if (!capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) continue;

            LinkProperties properties = manager.getLinkProperties(network);
            if (properties == null) continue;
            for (LinkAddress linkAddress : properties.getLinkAddresses()) {
                // IPv4 only: this address is read aloud, typed into a router's
                // DHCP reservation, and printed under a QR code on a table card.
                if (linkAddress.getAddress() instanceof Inet4Address
                    && !linkAddress.getAddress().isLoopbackAddress()) {
                    return linkAddress.getAddress().getHostAddress();
                }
            }
        }
        return null;
    }

    private JSObject state(String address, int port) {
        JSObject result = new JSObject();
        result.put("address", address);
        result.put("port", port);
        result.put("url", "http://" + address + ":" + port);
        result.put("running", true);
        return result;
    }

    @Override
    protected void handleOnDestroy() {
        if (server != null) server.stop();
        server = null;
        getContext().stopService(new Intent(getContext(), LocalServerService.class));
    }
}
