package agent.noah.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.graphics.drawable.IconCompat;
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
    private static final String CALLS = "noah-appels";
    static final String CALL_URL = "/#appel="; // même adresse que le web : le serveur la pose sur les rappels

    /**
     * À chaque ouverture de l'interface (comme le recommande UnifiedPush) : distributeur choisi, inscription pour la
     * session ouverte dans la fenêtre. Le contenu des messages ne s'affichera que pour elle.
     */
    static void start(Activity activity, String server, String token) {
        Pairing pairing = new Pairing(activity);
        long gen = pairing.startPush(token); // identité confirmée quand le serveur a accepté l'abonnement
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
                // Clé lue pour cette session-là : si on s'est déconnecté ou relié ailleurs entre-temps, une inscription
                // plus récente a pris la main ; celle-ci ne la remplace pas avec une ancienne clé.
                if (ok && gen == pairing.pushGeneration() && token.equals(pairing.pushToken())) {
                    UnifiedPush.register(activity, ConstantsKt.INSTANCE_DEFAULT, "Noah", vapid);
                }
                return Unit.INSTANCE;
            }));
        }).start();
    }

    /** Serveur oublié : plus aucune notification (le serveur supprime aussi l'abonnement avec la session). */
    static void stop(Context context) {
        CallWatch.stop(context);
        synchronized (Pairing.class) {
            new Pairing(context).clearPush();
            NotificationManagerCompat.from(context).cancelAll(); // l'appareil peut changer de main : rien ne reste lisible
        }
        UnifiedPush.unregister(context, ConstantsKt.INSTANCE_DEFAULT);
    }

    @Override
    public void onNewEndpoint(PushEndpoint endpoint, String instance) {
        Pairing pairing = new Pairing(this);
        String server = pairing.server(), token = pairing.pushToken();
        long gen = pairing.pushGeneration();
        if (server == null || token == null || endpoint.getPubKeySet() == null) return;
        latestEndpoint = endpoint.getUrl();
        // Noté tout de suite : si le processus meurt avant que le serveur l'ait reçu, la vérification périodique (et
        // la prochaine ouverture) voit que le serveur a encore l'ancien et réinscrit le téléphone.
        pairing.setPushEndpoint(endpoint.getUrl());
        // Une inscription à la fois, dans l'ordre, et seulement la plus récente : un ancien endpoint envoyé en retard ne
        // remplace jamais le nouveau sur le serveur.
        REGISTRATIONS.execute(() -> {
            if (!endpoint.getUrl().equals(latestEndpoint)) return; // remplacé avant son tour
            // Serveur en maintenance ou injoignable : quelques essais espacés tant que l'app tourne ; sinon la
            // prochaine ouverture de l'app réinscrit (UnifiedPush le recommande à chaque ouverture).
            for (int wait : new int[] { 0, 30_000, 120_000, 600_000 }) {
                // Attente par secondes : un endpoint plus récent n'attend pas la fin d'une ancienne relance.
                for (int t = 0; t < wait; t += 1000) {
                    if (!endpoint.getUrl().equals(latestEndpoint)) return;
                    try {
                        Thread.sleep(1000);
                    } catch (InterruptedException e) {
                        return;
                    }
                }
                if (!endpoint.getUrl().equals(latestEndpoint)) return;
                if (register(pairing, server, token, gen, endpoint)) return;
            }
        });
    }

    /** Envoie l'abonnement au serveur ; true s'il l'a accepté. */
    private static boolean register(Pairing pairing, String server, String token, long gen, PushEndpoint endpoint) {
        try {
            JSONObject body = new JSONObject().put("endpoint", endpoint.getUrl())
                .put("p256dh", endpoint.getPubKeySet().getPubKey()).put("auth", endpoint.getPubKeySet().getAuth());
            call("POST", server + "/api/push/subscription", token, body.toString());
            pairing.setPushEndpoint(endpoint.getUrl());
            pairing.confirmPush(gen, token); // sans effet si on s'est déconnecté entre-temps
            return true;
        } catch (Exception ignored) {
            return false; // sans inscription acceptée, l'interface ne dit pas « actives »
        }
    }

    private static final java.util.concurrent.ExecutorService REGISTRATIONS = java.util.concurrent.Executors.newSingleThreadExecutor();
    private static volatile String latestEndpoint;

    @Override
    public void onMessage(PushMessage message, String instance) {
        if (!message.getDecrypted()) return; // illisible : pas pour cet appareil
        // Tout de suite, sans réseau, pendant que le distributeur garde le service en vie : une notification générique.
        // Le contenu la remplace ensuite (même identifiant) si la session est confirmée. Si Android arrête le processus
        // avant, il reste la version générique : rien de perdu, rien d'exposé.
        int id = new Pairing(this).nextNotificationId();
        show(id, "Noah", "Nouvelle notification. Ouvre Noah pour la voir.", "/");
        new Thread(() -> handle(message, id)).start();
    }

    private void handle(PushMessage message, int id) {
        String title = "Noah", text = "Nouvelle notification.", url = "/";
        try {
            JSONObject data = new JSONObject(new String(message.getContent(), StandardCharsets.UTF_8));
            // Comme le service worker : le contenu ne s'affiche que s'il est destiné à la session de ce téléphone.
            // Identité de la session abonnée, effacée quand on se déconnecte dans l'interface : un message pour
            // l'ancien compte, arrivé après, ne montre rien.
            Pairing pairing = new Pairing(this);
            String mine = pairing.pushTag();
            long gen = pairing.pushGeneration();
            if (mine != null && mine.equals(data.optString("pour")) && stillMine(pairing, mine, gen)) {
                // Affiché sous le même verrou que la déconnexion (clearPush puis fermeture des notifications) : soit
                // la déconnexion est passée et on montre la version générique, soit elle passera après et fermera
                // celle-ci.
                synchronized (Pairing.class) {
                    if (gen == pairing.pushGeneration() && mine.equals(pairing.pushTag())) {
                        show(id, data.optString("titre", title), data.optString("texte", text), data.optString("url", url));
                    }
                }
            }
        } catch (Exception ignored) {
            // message mal formé : la notification générique déjà affichée suffit
        }
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
    private static boolean stillMine(Pairing pairing, String mine, long gen) {
        String server = pairing.server(), token = pairing.pushToken();
        if (server == null || token == null) return false;
        try {
            // 4 s au plus : le distributeur ne garde le service en vie que quelques secondes après le message.
            return mine.equals(new JSONObject(call("GET", server + "/api/push/subscription", token, null, 4000)).optString("pour"));
        } catch (Exception e) {
            // Révoquée : identité oubliée, mais seulement si c'est toujours celle vérifiée (une nouvelle connexion
            // faite entre-temps garde la sienne).
            if (String.valueOf(e.getMessage()).equals("HTTP 401")) pairing.clearPushIf(gen, mine);
            return false;
        }
    }

    /**
     * Le serveur a-t-il toujours l'abonnement de ce téléphone ? Il le supprime quand le service de push répond 404/410
     * (endpoint invalidé). Réseau : hors du fil de l'interface. null si le serveur ne répond pas.
     */
    static Boolean serverHasUs(Pairing pairing) {
        String server = pairing.server(), token = pairing.pushToken(), endpoint = pairing.pushEndpoint();
        if (server == null || token == null || endpoint == null) return false;
        try {
            JSONObject r = new JSONObject(call("GET", server + "/api/push/subscription", token, null, 8000));
            return r.optBoolean("abonne") && endpoint.equals(r.optString("endpoint"));
        } catch (Exception e) {
            return null;
        }
    }

    /** Notifications visibles : permission donnée et canal « Noah » non coupé dans les réglages d'Android. */
    static boolean visible(Context context) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel channel = manager == null ? null : manager.getNotificationChannel(CHANNEL);
        return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    private void show(int id, String title, String text, String url) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Noah", NotificationManager.IMPORTANCE_HIGH));
        Intent open = new Intent(this, MainActivity.class).putExtra("url", url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        // Un code par notification : sinon toucher une ancienne ouvrirait la page de la dernière reçue.
        PendingIntent tap = PendingIntent.getActivity(this, id, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        if (url != null && url.startsWith(CALL_URL)) {
            ring(this, manager, id, title, text, url, NoahFace.colorOf("#ff7a59", null), tap);
            return;
        }
        NotificationCompat.Builder n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_noah).setContentTitle(title).setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text)).setContentIntent(tap).setAutoCancel(true)
            .setOnlyAlertOnce(true); // le remplacement générique → contenu ne sonne pas deux fois
        try {
            NotificationManagerCompat.from(this).notify(id, n.build());
        } catch (SecurityException ignored) {
            // permission de notifier refusée par l'utilisateur
        }
    }

    /** Un rappel sonne comme un appel. Android 14 peut refuser le plein écran à une app qui n'est pas un téléphone : il reste la sonnerie. */
    static void ring(Context context, NotificationManager manager, int id, String title, String text, String url, int color, PendingIntent tap) {
        NotificationChannel channel = new NotificationChannel(CALLS, "Appels de tes agents", NotificationManager.IMPORTANCE_HIGH);
        channel.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
            new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build());
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[] { 0, 800, 400, 800, 400 });
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(channel);
        Intent screen = new Intent(context, CallActivity.class).putExtra(CallActivity.TITLE, title).putExtra(CallActivity.URL, url)
            .putExtra(CallActivity.NOTIFICATION, id).putExtra(CallActivity.COLOR, color).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent full = PendingIntent.getActivity(context, id, screen, flags);
        // Écran allumé, Android n'ouvre pas le plein écran : c'est ce bandeau qui répond ou refuse.
        PendingIntent answer = PendingIntent.getActivity(context, id + 1, new Intent(screen).setData(Uri.parse("noah-appel:" + id + "/" + CallActivity.ANSWERED)).putExtra(CallActivity.CHOICE, CallActivity.ANSWERED), flags);
        PendingIntent decline = PendingIntent.getActivity(context, id + 2, new Intent(screen).setData(Uri.parse("noah-appel:" + id + "/" + CallActivity.DECLINED)).putExtra(CallActivity.CHOICE, CallActivity.DECLINED), flags);
        Person who = new Person.Builder().setName(title).setIcon(IconCompat.createWithBitmap(NoahFace.bitmap(context, color, 192))).build();
        NotificationCompat.Builder n = new NotificationCompat.Builder(context, CALLS)
            .setSmallIcon(R.drawable.ic_stat_noah).setContentTitle(title).setContentText(text)
            .setCategory(NotificationCompat.CATEGORY_CALL).setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE) // le compte rendu ne s'affiche pas sur l'écran verrouillé
            .setContentIntent(tap).setFullScreenIntent(full, true).setAutoCancel(true).setTimeoutAfter(60000)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(who, decline, answer));
        try {
            NotificationManagerCompat.from(context).notify(id, n.build());
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

    static String call(String method, String url, String token, String json) throws Exception {
        return call(method, url, token, json, 15000);
    }

    static String call(String method, String url, String token, String json, int timeout) throws Exception {
        HttpURLConnection http = (HttpURLConnection) new URL(url).openConnection();
        http.setRequestMethod(method);
        http.setRequestProperty("Authorization", "Bearer " + token);
        http.setConnectTimeout(timeout);
        http.setReadTimeout(timeout);
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
