package agent.noah.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.graphics.drawable.IconCompat;
import androidx.core.content.ContextCompat;

/**
 * Un appel en cours : Android garde le micro et le processus vivants pendant que la personne fait autre chose, écran éteint
 * compris. La notification dit qu'on écoute, et permet de raccrocher.
 */
public class CallSession extends Service {

    static final String HANG_UP = "agent.noah.mobile.RACCROCHER";
    private static final String CHANNEL = "appel-en-cours";
    private static final int NOTIFICATION = 7302;
    private static final long LONGEST_MILLIS = 12 * 60 * 60 * 1000L; // filet : un verrou oublié viderait la batterie

    private PowerManager.WakeLock awake;
    private static volatile boolean active;

    /** Un appel tient le micro : la bulle ne dicte pas par-dessus. */
    static boolean isActive() {
        return active;
    }

    static void start(Context context, String agent, String color, String shape, String detail) {
        ContextCompat.startForegroundService(context, new Intent(context, CallSession.class).putExtra("agent", agent).putExtra("couleur", color)
            .putExtra("forme", shape).putExtra("detail", detail));
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, CallSession.class));
    }

    static PendingIntent hangUp(Context context) {
        return PendingIntent.getBroadcast(context, NOTIFICATION, new Intent(HANG_UP).setPackage(context.getPackageName()),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String agent = intent == null ? null : intent.getStringExtra("agent");
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(CHANNEL, getString(R.string.call_ongoing_channel), NotificationManager.IMPORTANCE_DEFAULT);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
        PendingIntent back = PendingIntent.getActivity(this, NOTIFICATION,
            new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE);
        // Présentée comme un appel : en tête du volet, sans son, Raccrocher visible sans rien déplier.
        String name = agent == null ? getString(R.string.call_your_agent) : agent;
        int color = NoahFace.colorOf(intent == null ? null : intent.getStringExtra("couleur"), agent);
        String shape = intent == null ? null : intent.getStringExtra("forme"), detail = intent == null ? null : intent.getStringExtra("detail");
        Person who = new Person.Builder().setName(name).setIcon(IconCompat.createWithBitmap(NoahFace.bitmap(this, color, shape, detail, 192))).build();
        Notification note = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_noah).setContentTitle(getString(R.string.call_with, name))
            .setContentText(getString(R.string.call_mic_open)).setOngoing(true).setCategory(NotificationCompat.CATEGORY_CALL)
            .setGroup("appel-en-cours").setContentIntent(back)
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(who, hangUp(this))).build();
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            else startForeground(NOTIFICATION, note);
        } catch (RuntimeException refused) { // micro pas encore autorisé : l'appel reste possible, application ouverte
            stopSelf();
            return START_NOT_STICKY;
        }
        active = true;
        if (awake == null) {
            awake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "noah:appel");
            awake.acquire(LONGEST_MILLIS);
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        active = false;
        if (awake != null && awake.isHeld()) awake.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
