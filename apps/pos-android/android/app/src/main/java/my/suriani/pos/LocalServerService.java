package my.suriani.pos;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * What keeps the outage door open for a whole shift.
 *
 * Android will not let an ordinary app hold a listening socket in the
 * background; without this the server would be killed some time after the
 * cashier switched to another app, which is precisely the moment nobody would
 * notice until a customer complained.
 *
 * The service type is `specialUse` rather than `dataSync`, and that is not a
 * coin toss: Android 15 caps `dataSync` foreground services at six hours in
 * any twenty-four, and a restaurant's service is longer than that. A cap
 * would end the shift by shutting off ordering at the busiest hour with no
 * error anywhere.
 */
public class LocalServerService extends android.app.Service {

    public static final String EXTRA_ADDRESS = "address";
    private static final String CHANNEL_ID = "suriani_local_server";
    private static final int NOTIFICATION_ID = 4181;

    private WifiManager.WifiLock wifiLock;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String address = intent == null ? null : intent.getStringExtra(EXTRA_ADDRESS);
        startInForeground(NOTIFICATION_ID, buildNotification(address));
        holdWifi();
        // Restarted with the last intent if Android reclaims the process, so
        // the door reopens by itself after a low-memory kill.
        return START_REDELIVER_INTENT;
    }

    @Override
    public void onDestroy() {
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        wifiLock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /**
     * Stop the WiFi radio dozing between orders.
     *
     * A tablet on mains power that lets its radio sleep answers the first
     * request of a quiet hour seconds late, or not at all. The lock costs
     * battery that a tablet on a charger does not have to care about.
     */
    private void holdWifi() {
        WifiManager wifi = (WifiManager) getApplicationContext()
            .getSystemService(Context.WIFI_SERVICE);
        if (wifi == null) return;
        wifiLock = wifi.createWifiLock(
            WifiManager.WIFI_MODE_FULL_HIGH_PERF, "suriani:local-server");
        wifiLock.setReferenceCounted(false);
        wifiLock.acquire();
    }

    private Notification buildNotification(String address) {
        NotificationManager manager =
            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Pesanan tempatan",
                // Low: it must be visible, but it must never make a sound in
                // a dining room.
                NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Pelanggan boleh pesan walaupun internet tiada.");
            manager.createNotificationChannel(channel);
        }

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(
            this, 0, open, PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Pesanan tempatan aktif")
            // The address is on the notification on purpose: it is the first
            // thing anyone needs when a QR card stops working, and reading it
            // off the screen beats hunting through a router's admin page.
            .setContentText(address == null ? "Menunggu WiFi" : address)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(tap)
            .build();
    }

    /**
     * Android 14 requires a service type at startForeground time as well as in
     * the manifest, and rejects the call outright without one.
     *
     * Not named `startForeground`: Service declares that method final, so a
     * same-signature helper is an illegal override rather than a shadow, and
     * the build fails on it.
     */
    private void startInForeground(int id, Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(id, notification);
        }
    }
}
