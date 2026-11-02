package agent.noah.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import kotlin.Unit;
import org.json.JSONObject;
import org.unifiedpush.android.connector.ConstantsKt;
import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.UnifiedPush;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

/**
 * Notifications de Noah sur Android, sans Firebase ni compte à créer : UnifiedPush. Un distributeur installé sur le
 * téléphone (ntfy, Sunup…) tient la connexion ; le serveur Noah lui envoie le même Web Push chiffré (RFC 8291) qu'aux
 * navigateurs, et seule l'app peut le lire (la bibliothèque le déchiffre avec ses clés). Comme les apps Mastodon
 * (Tusky) ou Matrix (Element) qui reçoivent leurs notifications de la même façon.
 */
public class NoahPush extends PushService {

    private static final String CHANNEL = "noah";

    /**
     * À chaque ouverture de l'interface (comme le recommande UnifiedPush) : distributeur choisi, inscription pour la
     * session ouverte dans la fenêtre. Le contenu des messages ne s'affichera que pour elle.
     */
    static void start(Activity activity, String server, String token) {
        new Pairing(activity).startPush(token); // identité confirmée quand le serveur a accepté l'abonnement
        if (Build.VERSION.SDK_INT >= 33
            && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 7);
        }
        new Thread(() -> {
            String vapid;
            try {
                vapid = new JSONObject(call("GET", server + "/api/push/key", token, null)).getString("cle");
            } catch (Exception e) {
                return; // serveur injoignable : on réessaiera à la prochaine ouverture
            }
            activity.runOnUiThread(() -> UnifiedPush.tryUseCurrentOrDefaultDistributor(activity, ok -> {
                if (ok) UnifiedPush.register(activity, ConstantsKt.INSTANCE_DEFAULT, "Noah", vapid);
                return Unit.INSTANCE;
            }));
        }).start();
    }

    /** Serveur oublié : plus aucune notification (le serveur supprime aussi l'abonnement avec la session). */
    static void stop(Context context) {
        new Pairing(context).clearPush();
        UnifiedPush.unregister(context, ConstantsKt.INSTANCE_DEFAULT);
    }

    @Override
    public void onNewEndpoint(PushEndpoint endpoint, String instance) {
        Pairing pairing = new Pairing(this);
        String server = pairing.server(), token = pairing.pushToken();
        long gen = pairing.pushGeneration();
        if (server == null || token == null || endpoint.getPubKeySet() == null) return;
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject().put("endpoint", endpoint.getUrl())
                    .put("p256dh", endpoint.getPubKeySet().getPubKey()).put("auth", endpoint.getPubKeySet().getAuth());
                call("POST", server + "/api/push/subscription", token, body.toString());
                pairing.setPushEndpoint(endpoint.getUrl());
                pairing.confirmPush(gen, token); // sans effet si on s'est déconnecté entre-temps
            } catch (Exception ignored) {
                // l'inscription est refaite à chaque ouverture de l'app ; sans elle, l'interface ne dit pas « actives »
            }
        }).start();
    }

    @Override
    public void onMessage(PushMessage message, String instance) {
        if (!message.getDecrypted()) return; // illisible : pas pour cet appareil
        new Thread(() -> handle(message)).start(); // la vérification auprès du serveur passe par le réseau
    }

    private void handle(PushMessage message) {
        String title = "Noah", text = "Nouvelle notification.", url = "/";
        try {
            JSONObject data = new JSONObject(new String(message.getContent(), StandardCharsets.UTF_8));
            // Comme le service worker : le contenu ne s'affiche que s'il est destiné à la session de ce téléphone.
            // Identité de la session abonnée, effacée quand on se déconnecte dans l'interface : un message pour
            // l'ancien compte, arrivé après, ne montre rien.
            Pairing pairing = new Pairing(this);
            String mine = pairing.pushTag();
            if (mine != null && mine.equals(data.optString("pour")) && stillMine(pairing, mine)) {
                title = data.optString("titre", title);
                text = data.optString("texte", text);
                url = data.optString("url", url);
            } else {
                text = "Nouvelle notification. Ouvre Noah pour la voir.";
            }
        } catch (Exception ignored) {
            // message mal formé : la notification générique suffit
        }
        show(title, text, url);
    }

    @Override
    public void onRegistrationFailed(FailedReason reason, String instance) {}

    /** Le distributeur a désinscrit l'app (désinstallé, réglage) : abonnement supprimé ici et sur le serveur. */
    @Override
    public void onUnregistered(String instance) {
        Pairing pairing = new Pairing(this);
        String server = pairing.server(), token = pairing.pushToken(), endpoint = pairing.pushEndpoint();
        pairing.clearPush();
        if (server == null || token == null || endpoint == null) return;
        pairing.queueUnsubscribe(server, token, endpoint); // file chiffrée, rejouée jusqu'à ce que le serveur réponde
        new Thread(pairing::revokeForgotten).start();
    }

    /**
     * La session abonnée est-elle toujours valable sur le serveur ? Elle a pu être révoquée depuis un autre appareil
     * pendant que le message attendait chez le distributeur. Serveur injoignable : dans le doute, contenu caché.
     * (onMessage tourne hors du fil de l'interface : l'appel réseau y est permis.)
     */
    private static boolean stillMine(Pairing pairing, String mine) {
        String server = pairing.server(), token = pairing.pushToken();
        if (server == null || token == null) return false;
        try {
            return mine.equals(new JSONObject(call("GET", server + "/api/push/subscription", token, null)).optString("pour"));
        } catch (Exception e) {
            if (String.valueOf(e.getMessage()).equals("HTTP 401")) pairing.clearPush(); // révoquée : identité oubliée
            return false;
        }
    }

    /** Notifications visibles : permission donnée et canal « Noah » non coupé dans les réglages d'Android. */
    static boolean visible(Context context) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel channel = manager == null ? null : manager.getNotificationChannel(CHANNEL);
        return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    private void show(String title, String text, String url) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Noah", NotificationManager.IMPORTANCE_HIGH));
        Intent open = new Intent(this, MainActivity.class).putExtra("url", url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        int id = new Pairing(this).nextNotificationId();
        // Un code par notification : sinon toucher une ancienne ouvrirait la page de la dernière reçue.
        PendingIntent tap = PendingIntent.getActivity(this, id, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher).setContentTitle(title).setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text)).setContentIntent(tap).setAutoCancel(true);
        try {
            NotificationManagerCompat.from(this).notify(id, n.build());
        } catch (SecurityException ignored) {
            // permission de notifier refusée par l'utilisateur
        }
    }

    /** Même identité courte que le serveur (push.session_tag) : sha256("noah-push:" + sha256(jeton)), 16 caractères. */
    static String tag(String token) throws Exception {
        return hex(sha256("noah-push:" + hex(sha256(token)))).substring(0, 16);
    }

    private static byte[] sha256(String s) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
    }

    private static String hex(byte[] b) {
        StringBuilder out = new StringBuilder();
        for (byte x : b) out.append(String.format("%02x", x));
        return out.toString();
    }

    private static String call(String method, String url, String token, String json) throws Exception {
        HttpURLConnection http = (HttpURLConnection) new URL(url).openConnection();
        http.setRequestMethod(method);
        http.setRequestProperty("Authorization", "Bearer " + token);
        http.setConnectTimeout(15000);
        http.setReadTimeout(15000);
        if (json != null) {
            http.setDoOutput(true);
            http.setRequestProperty("Content-Type", "application/json");
            try (OutputStream out = http.getOutputStream()) {
                out.write(json.getBytes(StandardCharsets.UTF_8));
            }
        }
        int code = http.getResponseCode();
        if (code >= 300) throw new Exception("HTTP " + code);
        try (InputStream in = http.getInputStream()) {
            ByteArrayOutputStream all = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            for (int n; (n = in.read(buf)) > 0; ) all.write(buf, 0, n);
            return all.toString("UTF-8");
        } finally {
            http.disconnect();
        }
    }
}
