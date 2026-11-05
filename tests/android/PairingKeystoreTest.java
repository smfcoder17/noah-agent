package agent.noah.mobile;

import android.content.Context;
import android.content.MemoryPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.Security;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import javax.crypto.SecretKey;

/**
 * G4.5, simulé : exécute le vrai Pairing.java (compilé tel quel) au-dessus d'un faux fournisseur « AndroidKeyStore ».
 * Tout ce que l'app écrit dans ses préférences est inspecté : c'est ce qu'emporterait une copie de ses fichiers.
 */
public final class PairingKeystoreTest {
    private static final String TOKEN = "jeton-appareil-TEMOIN-abcdefghijklmnopqrstuvwxyz-0123";
    private static final String WINDOW = "jeton-fenetre-TEMOIN-ZYXWVUTSRQPONMLKJIHGFEDCBA-9876";
    private static int answerCode = 200;
    private static final String SERVER = "https://noah.example.org";

    public static void main(String[] args) throws Exception {
        Security.addProvider(new FauxKeystore());
        keySpec();
        nothingInClear();
        freshNonce();
        tampering();
        copiedFiles();
        revocationQueue();
        concurrentFirstKey();
        windowExchange();
        System.out.println("keystore : tout est vert");
    }

    private static void ok(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static MemoryPreferences disk(Context context) {
        return (MemoryPreferences) context.files.get("noah");
    }

    /** 1. La clé vient du Keystore, AES-256 GCM, une seule fois, et rien ne l'exporte. */
    private static void keySpec() throws Exception {
        FauxKeystore.KEYS.clear();
        FauxKeystore.GENERATED.set(0);
        Context context = new Context();
        Pairing pairing = new Pairing(context);
        pairing.save(SERVER, TOKEN);
        pairing.save(SERVER, TOKEN);
        ok(FauxKeystore.GENERATED.get() == 1, "clé générée " + FauxKeystore.GENERATED.get() + " fois au lieu d'une");
        KeyGenParameterSpec spec = FauxKeystore.lastSpec;
        ok(spec != null && FauxKeystore.KEYS.containsKey("noah-session"), "aucune clé créée dans le Keystore");
        ok(spec.keySize == 256, "clé de " + spec.keySize + " bits");
        ok(spec.purposes == (KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT), "usages de la clé : " + spec.purposes);
        ok(Arrays.equals(spec.blockModes, new String[] { KeyProperties.BLOCK_MODE_GCM }), "mode : " + Arrays.toString(spec.blockModes));
        ok(Arrays.equals(spec.paddings, new String[] { KeyProperties.ENCRYPTION_PADDING_NONE }), "bourrage : " + Arrays.toString(spec.paddings));
        ok(context.lastMode == Context.MODE_PRIVATE, "préférences lisibles par d'autres apps");
        ok(TOKEN.equals(pairing.token()), "le jeton ne se relit pas");
        System.out.println("1. clé du Keystore, AES-256 GCM, créée une fois ; le jeton se relit ; préférences privées");
    }

    /** 2. Après tous les chemins d'écriture, ni le jeton ni la clé n'existent dans le fichier, sous aucune forme. */
    private static void nothingInClear() throws Exception {
        Context context = new Context();
        Pairing pairing = new Pairing(context);
        pairing.save(SERVER, TOKEN);
        ok(leaks(disk(context)).isEmpty(), "après save : " + leaks(disk(context)));
        pairing.startPush(TOKEN);
        pairing.confirmPush(pairing.pushGeneration(), TOKEN);
        ok(TOKEN.equals(pairing.pushToken()), "le jeton d'abonnement ne se relit pas");
        ok(leaks(disk(context)).isEmpty(), "après startPush : " + leaks(disk(context)));
        pairing.queueRevocation(SERVER, TOKEN);
        pairing.queueUnsubscribe(SERVER, TOKEN, "https://ntfy.sh/upAbc");
        ok(leaks(disk(context)).isEmpty(), "après la file : " + leaks(disk(context)));
        pairing.forget();
        ok(leaks(disk(context)).isEmpty(), "après forget : " + leaks(disk(context)));
        String queue = disk(context).getString("a_revoquer", "");
        ok(queue.length() > 200, "la file devrait contenir les sessions à révoquer : " + queue);
        ok(disk(context).getString("token", null) == null, "le jeton reste rangé après forget");
        System.out.println("2. save, startPush, file de révocation, forget : aucun jeton ni clé lisible dans le fichier");
    }

    private static List<String> leaks(MemoryPreferences prefs) throws Exception {
        List<String> found = new ArrayList<>();
        String all = prefs.disk.toString();
        List<byte[]> secrets = new ArrayList<>(List.of(TOKEN.getBytes(StandardCharsets.UTF_8), WINDOW.getBytes(StandardCharsets.UTF_8)));
        for (SecretKey key : FauxKeystore.KEYS.values()) secrets.add(key.getEncoded());
        for (byte[] secret : secrets) {
            for (int shift = 0; shift < 3; shift++) {
                byte[] part = Arrays.copyOfRange(secret, shift, secret.length);
                String std = Base64.getEncoder().withoutPadding().encodeToString(part);
                String url = Base64.getUrlEncoder().withoutPadding().encodeToString(part);
                if (all.contains(std.substring(0, std.length() - 2)) || all.contains(url.substring(0, url.length() - 2))) found.add("base64 " + std);
            }
            StringBuilder hex = new StringBuilder();
            for (byte b : secret) hex.append(String.format("%02x", b));
            if (all.contains(hex)) found.add("hexa " + hex);
            if (all.contains(new String(secret, StandardCharsets.ISO_8859_1))) found.add("en clair");
        }
        return found;
    }

    /** 3. Nouveau nonce à chaque chiffrement : deux rangements du même jeton ne se ressemblent pas. */
    private static void freshNonce() throws Exception {
        Context context = new Context();
        Pairing pairing = new Pairing(context);
        pairing.save(SERVER, TOKEN);
        String first = disk(context).getString("token", null);
        pairing.save(SERVER, TOKEN);
        String second = disk(context).getString("token", null);
        ok(!first.equals(second), "même chiffré pour le même jeton");
        byte[] a = Base64.getDecoder().decode(first), b = Base64.getDecoder().decode(second);
        ok(a.length == 12 + TOKEN.length() + 16, "taille inattendue : " + a.length + " (nonce 12 + jeton + tag GCM 16)");
        ok(!Arrays.equals(Arrays.copyOf(a, 12), Arrays.copyOf(b, 12)), "nonce réutilisé");
        System.out.println("3. nonce nouveau à chaque rangement, chiffré = nonce + jeton + tag GCM");
    }

    /** 4. Chiffrement authentifié : un fichier modifié ne donne pas un autre jeton, il ne donne rien. */
    private static void tampering() throws Exception {
        Context context = new Context();
        Pairing pairing = new Pairing(context);
        pairing.save(SERVER, TOKEN);
        byte[] all = Base64.getDecoder().decode(disk(context).getString("token", null));
        all[20] ^= 1;
        disk(context).disk.put("token", Base64.getEncoder().encodeToString(all));
        ok(pairing.token() == null, "jeton modifié accepté");
        System.out.println("4. fichier modifié : aucun jeton rendu");
    }

    /** 5. Les fichiers de l'app copiés sur un autre téléphone (autre Keystore) ne donnent aucune session. */
    private static void copiedFiles() throws Exception {
        Context context = new Context();
        Pairing pairing = new Pairing(context);
        pairing.save(SERVER, TOKEN);
        pairing.startPush(TOKEN);
        ok(TOKEN.equals(pairing.token()), "le jeton devrait se relire sur ce téléphone");
        FauxKeystore.KEYS.clear(); // la clé ne sort pas du téléphone
        ok(pairing.token() == null, "jeton lu sans la clé du Keystore");
        ok(pairing.pushToken() == null, "jeton d'abonnement lu sans la clé du Keystore");
        ok(SERVER.equals(pairing.server()), "l'adresse du serveur reste connue : il faudra relier l'app");
        System.out.println("5. fichiers copiés sans la clé du Keystore : ni jeton, ni abonnement, ni session");
    }

    /** 6. La file de révocation se déchiffre pour de vrai : le jeton arrive au serveur ; clé perdue, rien ne part. */
    private static void revocationQueue() throws Exception {
        List<String> heard = new CopyOnWriteArrayList<>();
        HttpServer http = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        http.createContext("/", exchange -> {
            heard.add(exchange.getRequestMethod() + " " + exchange.getRequestURI().getPath() + " " + exchange.getRequestHeaders().getFirst("Authorization"));
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        http.start();
        String local = "http://127.0.0.1:" + http.getAddress().getPort();
        try {
            Context context = new Context();
            Pairing pairing = new Pairing(context);
            pairing.save(local, TOKEN);
            pairing.forget();
            pairing.revokeForgotten();
            ok(heard.equals(List.of("DELETE /api/devices/self Bearer " + TOKEN)), "révocations reçues : " + heard);
            ok(disk(context).getString("a_revoquer", "").equals("[]"), "file non vidée : " + disk(context).getString("a_revoquer", ""));

            heard.clear();
            pairing.queueRevocation(local, TOKEN);
            FauxKeystore.KEYS.clear();
            pairing.revokeForgotten();
            ok(heard.isEmpty(), "appel sans jeton lisible : " + heard);
            ok(disk(context).getString("a_revoquer", "").equals("[]"), "élément illisible gardé pour toujours");
        } finally {
            http.stop(0);
        }
        System.out.println("6. file de révocation : le bon jeton arrive au serveur ; clé perdue, rien ne part et la file se vide");
    }

    /**
     * 7. Première clé demandée par plusieurs fils en même temps (session rangée pendant qu'une session arrivée trop tard
     * part en révocation) : générer sur un alias existant remplace la clé, ce qui a été chiffré avant serait perdu.
     */
    private static void concurrentFirstKey() throws Exception {
        for (int round = 0; round < 5; round++) {
            FauxKeystore.KEYS.clear();
            int threads = 8;
            CountDownLatch go = new CountDownLatch(1);
            List<Context> contexts = new ArrayList<>();
            List<Thread> running = new ArrayList<>();
            List<Throwable> errors = new CopyOnWriteArrayList<>();
            for (int i = 0; i < threads; i++) {
                Context context = new Context();
                contexts.add(context);
                Thread t = new Thread(() -> {
                    try {
                        go.await();
                        new Pairing(context).save(SERVER, TOKEN);
                    } catch (Throwable e) {
                        errors.add(e);
                    }
                });
                running.add(t);
                t.start();
            }
            go.countDown();
            for (Thread t : running) t.join();
            ok(errors.isEmpty(), "erreurs : " + errors);
            for (Context context : contexts) {
                ok(TOKEN.equals(new Pairing(context).token()), "jeton perdu : la clé a été remplacée par un autre fil");
            }
        }
        System.out.println("7. première clé demandée par 8 fils à la fois : une seule clé, aucun jeton perdu");
    }

    /**
     * 8. L'échange : le jeton d'appareil part en en-tête et rien de ce qui revient n'est rangé. Seul un 401 dit que l'appareil
     * n'est plus relié : réseau coupé ou panne, la fenêtre attend sans redemander l'appairage.
     */
    private static void windowExchange() throws Exception {
        FauxKeystore.KEYS.clear();
        List<String> heard = new CopyOnWriteArrayList<>();
        HttpServer http = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        http.createContext("/", exchange -> {
            heard.add(exchange.getRequestMethod() + " " + exchange.getRequestURI().getPath() + " " + exchange.getRequestHeaders().getFirst("Authorization"));
            byte[] body = ("{\"jeton\":\"" + WINDOW + "\",\"duree\":7200.0}").getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(answerCode, answerCode == 200 ? body.length : -1);
            if (answerCode == 200) exchange.getResponseBody().write(body);
            exchange.close();
        });
        http.start();
        String local = "http://127.0.0.1:" + http.getAddress().getPort();
        try {
            Context context = new Context();
            Pairing pairing = new Pairing(context);
            pairing.save(local, TOKEN);
            Pairing.Window window = pairing.openWindow();
            ok(window.state.equals(Pairing.Window.OPEN) && WINDOW.equals(window.token), "échange : " + window.state + " " + window.token);
            ok(heard.equals(List.of("POST /api/devices/self/fenetre Bearer " + TOKEN)), "reçu : " + heard);
            ok(leaks(disk(context)).isEmpty(), "après l'échange : " + leaks(disk(context)));
            ok(TOKEN.equals(pairing.token()), "l'échange a remplacé le jeton d'appareil");
            for (int[] expected : new int[][] { { 401, 0 }, { 404, 1 }, { 403, 2 }, { 500, 2 }, { 502, 2 }, { 503, 2 } }) {
                answerCode = expected[0];
                String[] states = { Pairing.Window.REFUSED, Pairing.Window.SERVER_TOO_OLD, Pairing.Window.UNREACHABLE };
                window = pairing.openWindow();
                ok(window.state.equals(states[expected[1]]) && window.token == null, "HTTP " + answerCode + " : " + window.state);
                ok(TOKEN.equals(pairing.token()), "HTTP " + answerCode + " : jeton d'appareil perdu");
            }
            answerCode = 200;
            http.stop(0);
            window = pairing.openWindow();
            ok(window.state.equals(Pairing.Window.UNREACHABLE), "serveur coupé : " + window.state);
            pairing.forget();
            ok(pairing.openWindow().state.equals(Pairing.Window.REFUSED), "serveur oublié : l'échange n'a plus rien à dire");
        } finally {
            http.stop(0);
        }
        System.out.println("8. échange : jeton d'appareil en en-tête, rien de rangé ; 401 refuse, panne ou réseau coupé attendent");
    }
}
