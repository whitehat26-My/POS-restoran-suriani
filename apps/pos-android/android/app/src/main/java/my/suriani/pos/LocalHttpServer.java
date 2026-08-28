package my.suriani.pos;

import android.content.Context;
import android.content.res.AssetManager;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The tablet's own web server.
 *
 * Deliberately small, for the same reason the printer plugin is: everything
 * that *decides* anything — which routes exist, whether a token is valid,
 * what an order costs — lives in `@suriani/localserver`, in TypeScript, under
 * test. This class moves bytes between a socket and that router and does no
 * thinking of its own.
 *
 * Written by hand rather than pulling in an HTTP library because the surface
 * it has to support is four routes with no uploads, no keep-alive and no
 * chunked encoding, and because this listens on a network that customers
 * share: a hundred and fifty lines somebody can read in one sitting is worth
 * more here than a general-purpose server whose unused half is still exposed.
 *
 * Every limit below is a refusal to allocate memory on a stranger's say-so.
 */
public class LocalHttpServer {

    /** Longer than any URL the customer app produces, and far short of a DoS. */
    private static final int MAX_REQUEST_LINE = 2048;
    private static final int MAX_HEADER_BYTES = 8192;
    /** A cart of forty lines with notes is well under this. */
    private static final int MAX_BODY_BYTES = 64 * 1024;
    /** A phone that opens a socket and says nothing does not get to keep it. */
    private static final int SOCKET_TIMEOUT_MS = 10_000;
    /** Enough for a full restaurant ordering at once, capped so it cannot grow. */
    private static final int WORKERS = 8;

    /** Where the customer app's files live inside the APK. */
    private static final String ASSET_ROOT = "menu";

    public interface Responder {
        /**
         * Hand a request to the JS router and wait for its answer.
         *
         * @return null when the WebView did not answer in time, which becomes
         *         a 503 rather than a socket left hanging open.
         */
        LocalResponse handle(String method, String path, String query, String body, String ip);
    }

    /** What the router decided. Exactly one of json / asset is set. */
    public static class LocalResponse {
        public int status = 500;
        public String json;
        public String asset;
    }

    private final Context context;
    private final Responder responder;
    private final AtomicLong served = new AtomicLong();

    private ServerSocket socket;
    private ExecutorService workers;
    private volatile boolean running;

    public LocalHttpServer(Context context, Responder responder) {
        this.context = context.getApplicationContext();
        this.responder = responder;
    }

    /**
     * Bind to one address, not to everything.
     *
     * `0.0.0.0` would also answer on a USB tether or a mobile-data interface.
     * The only network this is meant to be reachable from is the shop's own
     * WiFi, so it binds to that interface's address and nothing else.
     */
    public synchronized void start(String bindAddress, int port) throws IOException {
        if (running) return;
        socket = new ServerSocket();
        socket.setReuseAddress(true);
        socket.bind(new InetSocketAddress(InetAddress.getByName(bindAddress), port), 64);
        workers = Executors.newFixedThreadPool(WORKERS);
        running = true;

        Thread accept = new Thread(this::acceptLoop, "suriani-local-http");
        accept.setDaemon(true);
        accept.start();
    }

    public synchronized void stop() {
        running = false;
        try {
            if (socket != null) socket.close();
        } catch (IOException ignored) {
            // Closing a socket that is already gone is not news.
        }
        if (workers != null) workers.shutdownNow();
        socket = null;
        workers = null;
    }

    public boolean isRunning() {
        return running;
    }

    public long requestsServed() {
        return served.get();
    }

    private void acceptLoop() {
        while (running) {
            try {
                Socket client = socket.accept();
                client.setSoTimeout(SOCKET_TIMEOUT_MS);
                workers.execute(() -> serve(client));
            } catch (IOException e) {
                // stop() closes the socket from under us; that is not an error.
                if (running) sleepQuietly();
            } catch (RuntimeException e) {
                // Pool saturated. Dropping the connection is the right answer:
                // the alternative is queueing work the restaurant will not wait
                // for anyway.
                if (running) sleepQuietly();
            }
        }
    }

    private static void sleepQuietly() {
        try {
            Thread.sleep(50);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private void serve(Socket client) {
        try (Socket open = client;
             BufferedInputStream in = new BufferedInputStream(open.getInputStream());
             OutputStream out = open.getOutputStream()) {

            String requestLine = readLine(in, MAX_REQUEST_LINE);
            if (requestLine == null) return;

            String[] parts = requestLine.split(" ");
            if (parts.length < 2) {
                write(out, 400, "application/json", "{\"error\":\"bad request\"}".getBytes(StandardCharsets.UTF_8));
                return;
            }
            String method = parts[0].toUpperCase(Locale.ROOT);
            String target = parts[1];

            String path = target;
            String query = "";
            int q = target.indexOf('?');
            if (q >= 0) {
                path = target.substring(0, q);
                query = target.substring(q + 1);
            }

            Map<String, String> headers = readHeaders(in);
            String body = readBody(in, headers);

            String ip = open.getInetAddress() == null
                ? "unknown"
                : open.getInetAddress().getHostAddress();

            LocalResponse response = responder.handle(method, path, query, body, ip);
            served.incrementAndGet();

            if (response == null) {
                // The WebView did not answer. Almost always means the till app
                // was swiped away; say so rather than leaving a phone spinning.
                write(out, 503, "application/json",
                    "{\"error\":\"till not running\"}".getBytes(StandardCharsets.UTF_8));
                return;
            }

            if (response.asset != null) {
                writeAsset(out, response.asset);
            } else {
                write(out, response.status, "application/json",
                    (response.json == null ? "{}" : response.json).getBytes(StandardCharsets.UTF_8));
            }
        } catch (IOException ignored) {
            // A phone that walked out of range mid-request. Nothing to do.
        }
    }

    /**
     * Serve one of the customer app's own files.
     *
     * The name has already been checked by the router — anchored, single
     * segment, alphanumerics and dots only — so it cannot climb out of the
     * assets directory. The check is repeated here anyway, because the two
     * halves of a traversal defence should not both live on the far side of a
     * bridge.
     */
    private void writeAsset(OutputStream out, String name) throws IOException {
        if (name.contains("..") || name.startsWith("/") || name.contains("\\")) {
            write(out, 404, "application/json",
                "{\"error\":\"not found\"}".getBytes(StandardCharsets.UTF_8));
            return;
        }

        AssetManager assets = context.getAssets();
        try (InputStream stream = assets.open(ASSET_ROOT + "/" + name)) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int read;
            while ((read = stream.read(chunk)) != -1) buffer.write(chunk, 0, read);
            write(out, 200, contentTypeOf(name), buffer.toByteArray());
        } catch (IOException notThere) {
            write(out, 404, "application/json",
                "{\"error\":\"not found\"}".getBytes(StandardCharsets.UTF_8));
        }
    }

    private static String contentTypeOf(String name) {
        if (name.endsWith(".html")) return "text/html; charset=utf-8";
        if (name.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (name.endsWith(".css")) return "text/css; charset=utf-8";
        if (name.endsWith(".svg")) return "image/svg+xml";
        if (name.endsWith(".json")) return "application/json";
        if (name.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    private static void write(OutputStream out, int status, String contentType, byte[] body)
        throws IOException {
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n");
        head.append("Content-Type: ").append(contentType).append("\r\n");
        head.append("Content-Length: ").append(body.length).append("\r\n");
        // No caching of the app itself: a tablet that updates must not leave
        // phones on last month's menu, and the pages are already local.
        head.append("Cache-Control: no-store\r\n");
        // Nothing here is meant to be framed or sniffed.
        head.append("X-Content-Type-Options: nosniff\r\n");
        head.append("X-Frame-Options: DENY\r\n");
        // One request per connection. Keep-alive would need a state machine
        // this server has no reason to own.
        head.append("Connection: close\r\n\r\n");

        out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
        out.write(body);
        out.flush();
    }

    private static String reason(int status) {
        switch (status) {
            case 200: return "OK";
            case 201: return "Created";
            case 400: return "Bad Request";
            case 404: return "Not Found";
            case 429: return "Too Many Requests";
            case 503: return "Service Unavailable";
            default: return "Error";
        }
    }

    private static String readLine(InputStream in, int limit) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int previous = -1;
        int read;
        while ((read = in.read()) != -1) {
            if (previous == '\r' && read == '\n') {
                byte[] bytes = buffer.toByteArray();
                // Drop the trailing CR.
                return new String(bytes, 0, Math.max(0, bytes.length - 1), StandardCharsets.UTF_8);
            }
            buffer.write(read);
            previous = read;
            if (buffer.size() > limit) throw new IOException("line too long");
        }
        return null;
    }

    private static Map<String, String> readHeaders(InputStream in) throws IOException {
        Map<String, String> headers = new HashMap<>();
        int total = 0;
        String line;
        while ((line = readLine(in, MAX_REQUEST_LINE)) != null && !line.isEmpty()) {
            total += line.length();
            if (total > MAX_HEADER_BYTES) throw new IOException("headers too large");
            int colon = line.indexOf(':');
            if (colon > 0) {
                headers.put(
                    line.substring(0, colon).trim().toLowerCase(Locale.ROOT),
                    line.substring(colon + 1).trim());
            }
        }
        return headers;
    }

    private static String readBody(InputStream in, Map<String, String> headers) throws IOException {
        String header = headers.get("content-length");
        if (header == null) return null;

        int length;
        try {
            length = Integer.parseInt(header.trim());
        } catch (NumberFormatException e) {
            throw new IOException("bad content-length");
        }
        if (length <= 0) return null;
        // Refuse before allocating, not after.
        if (length > MAX_BODY_BYTES) throw new IOException("body too large");

        byte[] body = new byte[length];
        int filled = 0;
        while (filled < length) {
            int read = in.read(body, filled, length - filled);
            if (read == -1) throw new IOException("truncated body");
            filled += read;
        }
        return new String(body, StandardCharsets.UTF_8);
    }
}
