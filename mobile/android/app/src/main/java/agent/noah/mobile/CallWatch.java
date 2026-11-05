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

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.util.HashMap;
import java.util.Map;

/**
 * Faire sonner le téléphone sans service tiers, comme Signal sans Google : tant qu'aucun distributeur UnifiedPush n'est
 * installé, Noah tient lui-même une attente longue vers ton serveur. Android exige une notification discrète permanente.
 */
public class CallWatch extends Service {

    private static final String CHANNEL = "noah-veille";
    private static final int NOTIFICATION = 7001;
    private static final int WAIT_SECONDS = 50;

    private volatile boolean running;
    private final Map<String, Integer> ringing = new HashMap<>(); // appel qui sonne -> sa notification

    static void start(Context context) {
        try {
            context.startForegroundService(new Intent(context, CallWatch.class));
        } catch (RuntimeException ignored) {
            // Android refuse parfois un démarrage en arrière-plan : la prochaine ouverture de l'app le relance
        }
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, CallWatch.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Noah prêt à t'appeler", NotificationManager.IMPORTANCE_MIN));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_stat_noah)
            .setContentTitle("Noah peut t'appeler").setContentIntent(open).setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN).build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION, n);
        }
        if (!running) {
            running = true;
            new Thread(this::watch, "noah-appels").start();
        }
        return START_STICKY;
    }

    private void watch() {
        long pause = 5000;
        while (running) {
            Pairing pairing = new Pairing(this);
            String server = pairing.server(), token = pairing.token();
            if (server == null || token == null) break;
            try {
                String known = URLEncoder.encode(String.join(",", ringing.keySet()), "UTF-8");
                String body = NoahPush.call("GET", server + "/api/calls/wait?secondes=" + WAIT_SECONDS + "&connus=" + known, token, null, (WAIT_SECONDS + 20) * 1000);
                update(new JSONObject(body).getJSONArray("appels"));
                pause = 5000;
            } catch (Exception e) {
                if (String.valueOf(e.getMessage()).contains("HTTP 401")) break; // session retirée depuis Réglages > Appareils
                try {
                    Thread.sleep(pause); // réseau coupé, serveur en mise à jour : on réessaie, de plus en plus calmement
                } catch (InterruptedException stop) {
                    break;
                }
                pause = Math.min(pause * 2, 300000);
            }
        }
        running = false;
        stopSelf();
    }

    private void update(JSONArray calls) throws Exception {
        Map<String, Integer> now = new HashMap<>();
        for (int i = 0; i < calls.length(); i++) {
            JSONObject call = calls.getJSONObject(i);
            String id = call.getString("id");
            Integer shown = ringing.get(id);
            if (shown == null) {
                shown = new Pairing(this).nextNotificationId();
                String url = NoahPush.CALL_URL + id;
                Intent open = new Intent(this, MainActivity.class).putExtra("url", url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                PendingIntent tap = PendingIntent.getActivity(this, shown, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                // Le compte rendu n'est pas sur l'écran verrouillé : seulement le nom de l'agent.
                NoahPush.ring(this, getSystemService(NotificationManager.class), shown, call.optString("agent", "Noah"), "t'appelle", url, NoahFace.colorOf(call.optString("couleur"), call.optString("agent_id")), call.optString("forme"), call.optString("detail"), tap);
            }
            now.put(id, shown);
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        for (Map.Entry<String, Integer> gone : ringing.entrySet()) {
            if (!now.containsKey(gone.getKey())) manager.cancel(gone.getValue()); // pris ailleurs, refusé ou fini
        }
        ringing.clear();
        ringing.putAll(now);
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
