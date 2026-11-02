package agent.noah.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Le serveur auquel l'app est reliée et sa session. Le jeton est chiffré (AES-GCM) avec une clé du Keystore Android,
 * qui ne sort jamais du téléphone : une copie des fichiers de l'app ne suffit pas à se connecter.
 */
final class Pairing {

    private static final String KEY_ALIAS = "noah-session";
    private static final String PREFS = "noah";
    private final SharedPreferences prefs;

    Pairing(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    String server() {
        return prefs.getString("server", null);
    }

    String token() {
        return open(prefs.getString("token", null));
    }

    private static String open(String sealed) {
        if (sealed == null) return null;
        try {
            byte[] all = Base64.decode(sealed, Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 0, 12));
            return new String(cipher.doFinal(all, 12, all.length - 12), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null; // clé effacée (sauvegarde restaurée sur un autre téléphone) : il faudra relier l'app de nouveau
        }
    }

    void save(String server, String token) throws Exception {
        prefs.edit().putString("server", server).putString("token", seal(token)).commit();
    }

    private static String seal(String token) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = cipher.getIV();
        byte[] body = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
        byte[] all = new byte[iv.length + body.length];
        System.arraycopy(iv, 0, all, 0, iv.length);
        System.arraycopy(body, 0, all, iv.length, body.length);
        return Base64.encodeToString(all, Base64.NO_WRAP);
    }

    /**
     * Oublie ce serveur. La session est mise de côté (toujours chiffrée) pour être révoquée là-bas : sans ça, elle
     * resterait valable sur le serveur alors que l'utilisateur croit avoir déconnecté le téléphone.
     */
    void forget(String windowToken) {
        synchronized (Pairing.class) {
            String server = server(), sealed = prefs.getString("token", null);
            JSONArray queue = pending();
            if (server != null && sealed != null) {
                try {
                    queue.put(new JSONObject().put("server", server).put("token", sealed));
                    // La fenêtre peut utiliser une autre session (déconnexion puis reconnexion dans l'interface) :
                    // elle est révoquée aussi.
                    if (windowToken != null && !windowToken.equals(open(sealed))) {
                        queue.put(new JSONObject().put("server", server).put("token", seal(windowToken)));
                    }
                } catch (Exception ignored) {
                    // JSON en mémoire, chiffrement par la clé du Keystore : rien à faire de plus si ça échoue
                }
            }
            int ids = prefs.getInt("notif_id", 0); // gardé : un nouvel appairage ne remplace pas d'anciennes notifications
            long gen = prefs.getLong("push_gen", 0) + 1; // avance, jamais remise à zéro : un affichage en cours tombe
            prefs.edit().clear().putString("a_revoquer", queue.toString()).putInt("notif_id", ids)
                .putLong("push_gen", gen).commit();
        }
    }

    /** Session réellement utilisée par la fenêtre (cookie apollo_session), ou null. */
    static String windowToken(String server) {
        String all = server == null ? null : android.webkit.CookieManager.getInstance().getCookie(server);
        if (all == null) return null;
        for (String part : all.split(";")) {
            String p = part.trim();
            if (p.startsWith("apollo_session=")) return p.substring("apollo_session=".length());
        }
        return null;
    }

    /** Session à révoquer plus tard (réseau absent) : rejoint la même file chiffrée que l'oubli du serveur. */
    void queueRevocation(String server, String token) {
        queue(server, token, "/api/devices/self");
    }

    /** Abonnement aux notifications à supprimer sur le serveur (désinscrit par le distributeur), même file. */
    void queueUnsubscribe(String server, String token, String endpoint) {
        try {
            queue(server, token, "/api/push/subscription?endpoint=" + java.net.URLEncoder.encode(endpoint, "UTF-8"));
        } catch (Exception ignored) {
            // UTF-8 toujours disponible
        }
    }

    void setPushEndpoint(String endpoint) {
        prefs.edit().putString("push_endpoint", endpoint).commit();
    }

    String pushEndpoint() {
        return prefs.getString("push_endpoint", null);
    }

    private void queue(String server, String token, String path) {
        synchronized (Pairing.class) {
            JSONArray queue = pending();
            try {
                queue.put(new JSONObject().put("server", server).put("token", seal(token)).put("chemin", path));
            } catch (Exception ignored) {
                return;
            }
            prefs.edit().putString("a_revoquer", queue.toString()).commit();
        }
    }

    // Notifications : la session abonnée (chiffrée, pour réinscrire l'appareil en arrière-plan) et son identité courte,
    // la seule dont le téléphone affiche le contenu. Effacées à la déconnexion dans l'interface.
    // Chaque changement (nouvelle inscription, déconnexion) avance une génération : une confirmation commencée avant ne
    // rétablit jamais une identité effacée entre-temps.
    long startPush(String token) {
        synchronized (Pairing.class) {
            // Même session qu'avant (réouverture de l'app) : l'identité confirmée reste valable pendant la
            // réinscription ; un serveur en maintenance ne rend pas les notifications génériques.
            if (token.equals(pushToken())) return pushGeneration();
            long gen = prefs.getLong("push_gen", 0) + 1;
            try {
                prefs.edit().putString("push_token", seal(token)).remove("push_tag").putLong("push_gen", gen).commit();
            } catch (Exception ignored) {
                // Keystore indisponible : pas de notifications avec contenu
            }
            return gen;
        }
    }

    /** Le serveur a accepté l'abonnement : identité posée seulement si rien n'a changé depuis l'envoi. */
    void confirmPush(long gen, String token) throws Exception {
        synchronized (Pairing.class) {
            if (gen == prefs.getLong("push_gen", 0) && token.equals(pushToken())) {
                prefs.edit().putString("push_tag", NoahPush.tag(token)).commit();
            }
        }
    }

    long pushGeneration() {
        return prefs.getLong("push_gen", 0);
    }

    String pushToken() {
        return open(prefs.getString("push_token", null));
    }

    String pushTag() {
        return prefs.getString("push_tag", null);
    }

    /** Efface l'identité seulement si elle n'a pas changé depuis `gen` (sinon c'est celle d'une nouvelle connexion). */
    boolean clearPushIf(long gen, String tag) {
        synchronized (Pairing.class) {
            if (gen != pushGeneration() || !tag.equals(pushTag())) return false;
            clearPush();
            return true;
        }
    }

    void clearPush() {
        synchronized (Pairing.class) {
            prefs.edit().remove("push_token").remove("push_tag").putLong("push_gen", pushGeneration() + 1).commit();
        }
    }

    /** Identifiant unique de notification (compteur gardé : ni collision dans la même milliseconde, ni répétition). */
    int nextNotificationId() {
        synchronized (Pairing.class) {
            int id = (prefs.getInt("notif_id", 0) + 1) & 0x7fffffff;
            prefs.edit().putInt("notif_id", id).commit();
            return id;
        }
    }

    private JSONArray pending() {
        try {
            return new JSONArray(prefs.getString("a_revoquer", "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    /** Révoque les sessions oubliées. Réseau : à appeler hors du fil de l'interface. Rejoué à chaque ouverture. */
    /**
     * Une relance à la fois (bouton, ouverture de l'app, retour du réseau), mais le verrou commun n'est tenu que pour
     * lire et réécrire la file : un serveur injoignable ne bloque pas « Oublier » ni la fermeture des notifications.
     */
    private static final Object FLUSHING = new Object();

    void revokeForgotten() {
        synchronized (FLUSHING) {
            JSONArray queue;
            synchronized (Pairing.class) {
                queue = pending();
            }
            java.util.Set<String> done = revokeQueue(queue);
            synchronized (Pairing.class) { // relue : des éléments ont pu être ajoutés pendant les envois
                JSONArray now = pending(), left = new JSONArray();
                for (int i = 0; i < now.length(); i++) {
                    JSONObject item = now.optJSONObject(i);
                    if (item != null && !done.contains(item.optString("token") + item.optString("chemin"))) left.put(item);
                }
                prefs.edit().putString("a_revoquer", left.toString()).commit();
            }
        }
    }

    private java.util.Set<String> revokeQueue(JSONArray queue) {
        java.util.Set<String> done = new java.util.HashSet<>();
        for (int i = 0; i < queue.length(); i++) {
            JSONObject item = queue.optJSONObject(i);
            if (item == null) continue;
            String token = open(item.optString("token", null));
            if (token == null) { // clé du Keystore perdue : rien à envoyer, l'élément ne sert plus
                done.add(item.optString("token") + item.optString("chemin"));
                continue;
            }
            int code;
            try {
                HttpURLConnection http = (HttpURLConnection) new URL(item.optString("server") + item.optString("chemin", "/api/devices/self")).openConnection();
                http.setRequestMethod("DELETE");
                http.setRequestProperty("Authorization", "Bearer " + token);
                http.setConnectTimeout(10000);
                http.setReadTimeout(10000);
                code = http.getResponseCode();
                http.disconnect();
            } catch (Exception e) {
                code = -1;
            }
            if ((code >= 200 && code < 300) || code == 401) { // 401 : la session n'existe déjà plus
                done.add(item.optString("token") + item.optString("chemin"));
            }
        }
        return done;
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(
            new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return generator.generateKey();
    }
}
