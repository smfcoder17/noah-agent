package agent.noah.mobile;

import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;

/**
 * Noah sur le téléphone, comme l'app compagnon de Home Assistant : tant que l'app n'est reliée à aucun serveur, elle
 * affiche son écran de connexion (www/, embarqué). Une fois reliée, la fenêtre ouvre l'interface du serveur Noah
 * lui-même : toujours la même version que le serveur, sans rien recopier dans l'app. Capacitor y garde son pont natif
 * (notifications, micro, fichiers), seules les pages HTML passent par lui ; le chat en flux va directement au serveur.
 */
public class MainActivity extends BridgeActivity {

    private String server;
    private String token;
    private ConnectivityManager.NetworkCallback onNetwork;
    private final Handler later = new Handler(Looper.getMainLooper());
    private Runnable retry;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(NoahShellPlugin.class);
        Pairing pairing = new Pairing(this);
        new Thread(pairing::revokeForgotten).start(); // sessions oubliées hors ligne : révoquées dès que possible
        // … et de nouveau à chaque retour du réseau, sans attendre une réouverture de l'app.
        ConnectivityManager network = getSystemService(ConnectivityManager.class);
        if (network != null) {
            onNetwork = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network n) {
                    new Thread(pairing::revokeForgotten).start();
                    runOnUiThread(() -> resumePush(pairing)); // au retour du réseau, sans attendre une réouverture
                }
            };
            network.registerDefaultNetworkCallback(onNetwork);
        }
        // … et toutes les 5 minutes (le VPS peut revenir sans que le réseau du téléphone change). Rien à faire si la
        // file est vide : la boucle ne coûte presque rien.
        retry = () -> {
            new Thread(pairing::revokeForgotten).start();
            resumePush(pairing); // le VPS peut revenir sans que le réseau du téléphone change
            later.postDelayed(retry, 5 * 60 * 1000);
        };
        later.postDelayed(retry, 5 * 60 * 1000);
        server = pairing.server();
        token = server == null ? null : pairing.token();
        if (server != null && token != null) {
            config = new CapConfig.Builder(this)
                // Seule l'adresse complète du serveur (port compris) accède au pont natif. Pas d'allowNavigation : il
                // ne compare que l'hôte, et ouvrirait le pont à un autre service du même hôte sur un autre port.
                .setServerUrl(server)
                .setAppendedUserAgentString("NoahApp/" + BuildConfig.VERSION_NAME + " Android")
                .create();
        }
        super.onCreate(savedInstanceState);
    }

    /** Notifications pas encore actives (première ouverture hors ligne, serveur injoignable) : inscription reprise. */
    private void resumePush(Pairing pairing) {
        String s = pairing.server(), t = Pairing.windowToken(s);
        // Seulement si tout est prêt sauf le serveur : pas de demande de permission ni de choix de distributeur
        // répétés toutes les 5 minutes.
        if (org.unifiedpush.android.connector.UnifiedPush.getDistributors(this).isEmpty() || !NoahPush.visible(this)) return;
        if (s != null && t != null && pairing.pushTag() == null) NoahPush.start(this, s, t);
    }

    @Override
    public void onDestroy() {
        ConnectivityManager network = getSystemService(ConnectivityManager.class);
        if (network != null && onNetwork != null) network.unregisterNetworkCallback(onNetwork); // recréée : pas de doublon
        later.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @Override
    protected void load() {
        super.load();
        if (server == null || token == null) return;
        // Cookie de session, posé après la création du pont : Capacitor efface les cookies de session à ce moment-là.
        // Non persistant, il disparaît avec l'app ; le jeton ne vit sur le disque que chiffré (Pairing).
        String secure = server.startsWith("https://") ? "; Secure" : ""; // http : version de débogage seulement
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setCookie(server, "apollo_session=" + token + "; Path=/" + secure + "; HttpOnly; SameSite=Lax");
        cookies.flush();
        // Liens vers une autre origine (même hôte sur un autre port compris) : ouverts dans le navigateur, jamais dans
        // cette fenêtre. Le cookie de session ne distingue pas les ports (RFC 6265 §8.5) : il ne doit partir que vers
        // l'adresse exacte du serveur.
        String home = origin(server);
        bridge.setWebViewClient(new com.getcapacitor.BridgeWebViewClient(bridge) {
            @Override
            public boolean shouldOverrideUrlLoading(android.webkit.WebView view, android.webkit.WebResourceRequest request) {
                if (!home.equals(origin(request.getUrl().toString()))) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                    } catch (Exception ignored) {
                        // aucune app pour ouvrir ce lien
                    }
                    return true;
                }
                return super.shouldOverrideUrlLoading(view, request);
            }

            @Override
            public android.webkit.WebResourceResponse shouldInterceptRequest(android.webkit.WebView view,
                                                                            android.webkit.WebResourceRequest request) {
                // Image, script, iframe… vers le même hôte sur un autre port : le cookie de session partirait avec
                // (les cookies ne distinguent pas les ports). Bloqué ; les autres sites ne reçoivent pas ce cookie.
                android.net.Uri u = request.getUrl();
                if (u.getHost() != null && u.getHost().equalsIgnoreCase(android.net.Uri.parse(server).getHost())
                    && !home.equals(origin(u.toString()))) {
                    return new android.webkit.WebResourceResponse("text/plain", "utf-8", 403, "Forbidden",
                        new java.util.HashMap<>(), new java.io.ByteArrayInputStream(new byte[0]));
                }
                return super.shouldInterceptRequest(view, request);
            }
        });
        bridge.getWebView().stopLoading();
        bridge.getWebView().loadUrl(server + page(getIntent()));
    }

    /** schéma://hôte:port, port explicite (443/80 par défaut) : deux ports du même hôte sont deux origines. */
    private static String origin(String url) {
        android.net.Uri u = android.net.Uri.parse(url);
        int port = u.getPort() != -1 ? u.getPort() : "https".equals(u.getScheme()) ? 443 : 80;
        return u.getScheme() + "://" + u.getHost() + ":" + port;
    }

    /** Ouverte depuis une notification : la page qu'elle désigne, sur ce serveur seulement (chemin relatif). */
    private static String page(Intent intent) {
        String url = intent == null ? null : intent.getStringExtra("url");
        return url != null && url.startsWith("/") && !url.startsWith("//") ? url : "/";
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (server != null && token != null && bridge != null && intent.hasExtra("url")) {
            bridge.getWebView().loadUrl(server + page(intent));
        }
    }
}
