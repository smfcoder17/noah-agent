package agent.noah.mobile;

import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.drawable.Icon;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Rational;
import android.webkit.CookieManager;
import androidx.core.content.ContextCompat;
import java.util.Collections;
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
    private final java.util.List<java.util.function.Consumer<String>> renewing = new java.util.ArrayList<>(); // fil de l'interface
    private String retryPage = "/";
    private ConnectivityManager.NetworkCallback onNetwork;
    private final Handler later = new Handler(Looper.getMainLooper());
    private Runnable retry;
    private boolean inCall;
    private final BroadcastReceiver hangUp = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (bridge != null) bridge.eval("window.dispatchEvent(new Event('noah:raccrocher'))", value -> { });
        }
    };

    /** L'appel se poursuit hors de l'application, dans une petite fenêtre au-dessus des autres. */
    void setInCall(boolean on) {
        inCall = on;
        runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= 31) setPictureInPictureParams(floating(on));
            // Raccroché depuis la fenêtre flottante : elle n'a plus de raison d'être.
            if (!on && Build.VERSION.SDK_INT >= 26 && isInPictureInPictureMode()) moveTaskToBack(true);
        });
    }

    private PictureInPictureParams floating(boolean on) {
        PictureInPictureParams.Builder params = new PictureInPictureParams.Builder().setAspectRatio(new Rational(3, 4));
        PendingIntent hang = CallSession.hangUp(this);
        params.setActions(Collections.singletonList(new RemoteAction(Icon.createWithResource("android", android.R.drawable.ic_menu_close_clear_cancel), "Raccrocher", "Raccrocher", hang)));
        if (Build.VERSION.SDK_INT >= 31) params.setAutoEnterEnabled(on);
        return params.build();
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (inCall && Build.VERSION.SDK_INT >= 26 && Build.VERSION.SDK_INT < 31) enterPictureInPictureMode(floating(true));
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(NoahShellPlugin.class);
        ContextCompat.registerReceiver(this, hangUp, new IntentFilter(CallSession.HANG_UP), ContextCompat.RECEIVER_NOT_EXPORTED);
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
        startCallWatch(pairing);
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
        // Retour : ferme d'abord ce qui est ouvert dans l'interface (fenêtre, panneau, menu, fil), comme une app native. Rien
        // d'ouvert : l'app passe derrière sans s'arrêter, un appel en cours continue.
        getOnBackPressedDispatcher().addCallback(this, new androidx.activity.OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (bridge == null) {
                    moveTaskToBack(true);
                    return;
                }
                bridge.getWebView().evaluateJavascript("window.noahRetour ? window.noahRetour() : false", handled -> {
                    if (!"true".equals(handled)) moveTaskToBack(true);
                });
            }
        });
    }

    /** Sans distributeur UnifiedPush, c'est Noah lui-même qui attend les appels : rien à installer en plus. */
    void startCallWatch(Pairing pairing) {
        if (pairing.server() != null && org.unifiedpush.android.connector.UnifiedPush.getDistributors(this).isEmpty()) CallWatch.start(this);
    }

    /** Notifications pas encore actives (première ouverture hors ligne, serveur injoignable) : inscription reprise. */
    private void resumePush(Pairing pairing) {
        String s = pairing.server(), t = pairing.token();
        startCallWatch(pairing);
        // Seulement si tout est prêt sauf le serveur : pas de demande de permission ni de choix de distributeur
        // répétés toutes les 5 minutes.
        if (org.unifiedpush.android.connector.UnifiedPush.getDistributors(this).isEmpty() || !NoahPush.visible(this)) return;
        if (s == null || t == null) return;
        if (pairing.pushTag() == null) {
            NoahPush.start(this, s, t);
            return;
        }
        // Inscrit d'après le téléphone : vérifié auprès du serveur, qui a pu supprimer l'abonnement (404/410).
        long gen = pairing.pushGeneration();
        String tag = pairing.pushTag();
        new Thread(() -> {
            if (Boolean.FALSE.equals(NoahPush.serverHasUs(pairing)) && pairing.clearPushIf(gen, tag)) {
                runOnUiThread(() -> {
                    // Toujours le même serveur et le même jeton d'appareil : sinon un nouvel appairage s'inscrit de
                    // lui-même, cette ancienne relance n'a plus rien à faire.
                    if (isDestroyed() || !s.equals(pairing.server()) || !t.equals(pairing.token())) return;
                    NoahPush.start(this, s, t);
                });
            }
        }).start();
    }

    @Override
    public void onDestroy() {
        unregisterReceiver(hangUp);
        CallSession.stop(this);
        ConnectivityManager network = getSystemService(ConnectivityManager.class);
        if (network != null && onNetwork != null) network.unregisterNetworkCallback(onNetwork); // recréée : pas de doublon
        later.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @Override
    protected void load() {
        super.load();
        if (server == null || token == null) return;
        // Le jeton d'appareil ne va jamais dans la WebView : elle écrit ses cookies en clair sur le disque (Cookies), même
        // sans durée de vie. Rien d'une version précédente n'y reste non plus : la fenêtre n'a pas d'autre cookie.
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.removeAllCookies(null);
        cookies.flush();
        // Liens vers une autre origine (même hôte sur un autre port compris) : ouverts dans le navigateur, jamais dans
        // cette fenêtre. Le cookie de session ne distingue pas les ports (RFC 6265 §8.5) : il ne doit partir que vers
        // l'adresse exacte du serveur.
        String home = origin(server);
        bridge.setWebViewClient(new com.getcapacitor.BridgeWebViewClient(bridge) {
            @Override
            public void onReceivedError(android.webkit.WebView view, android.webkit.WebResourceRequest request,
                                        android.webkit.WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (!request.isForMainFrame()) return;
                // Serveur coupé ou réseau perdu : page d'attente, puis nouvel essai toutes les 5 s (G3.6), sans
                // redemander l'appairage (le nouvel essai rouvre la session de la fenêtre).
                view.loadDataWithBaseURL(null, OFFLINE, "text/html", "utf-8", null);
                later.removeCallbacks(reload);
                later.postDelayed(reload, 5000);
            }

            @Override
            public void onReceivedHttpError(android.webkit.WebView view, android.webkit.WebResourceRequest request,
                                            android.webkit.WebResourceResponse response) {
                super.onReceivedHttpError(view, request, response);
                // Caddy en place mais Noah arrêté (502), ou en plein redémarrage (503) : même attente qu'une coupure.
                if (!request.isForMainFrame() || response.getStatusCode() < 500) return;
                view.loadDataWithBaseURL(null, OFFLINE, "text/html", "utf-8", null);
                later.removeCallbacks(reload);
                later.postDelayed(reload, 5000);
            }

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
                // Capacitor lit lui-même toute navigation et la ressert comme une page, sans les en-têtes du serveur : un
                // téléchargement (Content-Disposition) ne se déclenchait jamais, et un aperçu perdait son bac à sable. Seule la
                // page de l'interface a besoin de son pont ; le cadre caché, les aperçus et les fichiers vont droit au serveur.
                String path = u.getPath();
                if (home.equals(origin(u.toString())) && (!request.isForMainFrame() || (path != null && path.startsWith("/api/")))) return null;
                return super.shouldInterceptRequest(view, request);
            }
        });
        // Une WebView ne télécharge rien d'elle-même : sans ça, un lien de téléchargement ne fait rien sur le téléphone.
        bridge.getWebView().setDownloadListener((url, agent, disposition, mime, length) -> download(url, agent, disposition, mime, home));
        bridge.getWebView().stopLoading();
        openPage(page(getIntent()));
    }

    /** Confie le fichier au gestionnaire de téléchargements d'Android, dans Téléchargements, avec la session de la fenêtre. */
    private void download(String url, String agent, String disposition, String mime, String home) {
        if (!home.equals(origin(url))) { // la session ne part que vers le serveur
            android.widget.Toast.makeText(this, "Ce fichier n'a pas pu être téléchargé.", android.widget.Toast.LENGTH_LONG).show();
            return;
        }
        try {
            String name = fileName(url, disposition, mime);
            android.app.DownloadManager.Request request = new android.app.DownloadManager.Request(android.net.Uri.parse(url))
                .setMimeType(mime)
                .setTitle(name)
                .addRequestHeader("User-Agent", agent)
                .setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            // Avant Android 10, le dossier public demande une permission : le dossier de l'app n'en demande aucune.
            if (android.os.Build.VERSION.SDK_INT >= 29) request.setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, name);
            else request.setDestinationInExternalFilesDir(this, android.os.Environment.DIRECTORY_DOWNLOADS, name);
            if (windowSession != null) request.addRequestHeader("Cookie", "noah_session=" + windowSession);
            getSystemService(android.app.DownloadManager.class).enqueue(request);
            android.widget.Toast.makeText(this, "Téléchargement de " + name, android.widget.Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            android.widget.Toast.makeText(this, "Ce fichier n'a pas pu être téléchargé.", android.widget.Toast.LENGTH_LONG).show();
        }
    }

    /** Demandé par l'interface (NoahShell.download) : le nom vient de l'adresse, le serveur ne s'exprime qu'au gestionnaire. */
    boolean downloadFromPage(String url, String agent, String mime) {
        if (server == null) return false;
        String last = android.net.Uri.parse(url).getLastPathSegment();
        String disposition = last == null ? null : "attachment; filename*=UTF-8''" + android.net.Uri.encode(last);
        download(url, agent, disposition, mime.split(";")[0].trim(), origin(server));
        return true;
    }

    /** Le vrai nom : filename* (accents compris, qu'Android lit mal selon la version), sinon le chemin demandé, sinon sa devinette. */
    private static String fileName(String url, String disposition, String mime) {
        java.util.regex.Matcher utf8 = java.util.regex.Pattern.compile("filename\\*=UTF-8''([^;]+)", java.util.regex.Pattern.CASE_INSENSITIVE)
            .matcher(disposition == null ? "" : disposition);
        String asked = android.net.Uri.parse(url).getQueryParameter("path");
        String name = utf8.find() ? android.net.Uri.decode(utf8.group(1)) : asked != null ? android.net.Uri.parse(asked).getLastPathSegment() : null;
        if (name == null || name.isEmpty()) name = android.webkit.URLUtil.guessFileName(url, disposition, mime);
        return name.replaceAll("[/\\\\]", "_"); // jamais un autre dossier que Téléchargements
    }

    /**
     * Rouvre la session de la fenêtre avec le jeton d'appareil et la met en cookie, sans bruit. `done` reçoit l'état
     * (Pairing.Window) sur le fil de l'interface. Un échange à la fois : ouverture, retour au premier plan et interface
     * qui demande en même temps partagent le même. Réseau coupé : le cookie en place ne bouge pas.
     */
    void renewWindow(java.util.function.Consumer<String> done) {
        runOnUiThread(() -> {
            renewing.add(done);
            if (renewing.size() > 1) return;
            Pairing pairing = new Pairing(this);
            new Thread(() -> {
                Pairing.Window window = pairing.openWindow();
                runOnUiThread(() -> {
                    if (!isDestroyed() && server != null && server.equals(pairing.server())) putInCookie(window);
                    java.util.List<java.util.function.Consumer<String>> waiting = new java.util.ArrayList<>(renewing);
                    renewing.clear();
                    for (java.util.function.Consumer<String> each : waiting) each.accept(window.state);
                });
            }).start();
        });
    }

    private volatile String windowSession; // en mémoire seulement, pour les téléchargements

    private void putInCookie(Pairing.Window window) {
        CookieManager cookies = CookieManager.getInstance();
        if (Pairing.Window.OPEN.equals(window.state)) {
            String secure = server.startsWith("https://") ? "; Secure" : ""; // http : version de débogage seulement
            cookies.setCookie(server, "noah_session=" + window.token + "; Path=/" + secure + "; HttpOnly; SameSite=Lax");
            windowSession = window.token;
        } else if (Pairing.Window.REFUSED.equals(window.state)) {
            cookies.removeAllCookies(null); // l'appareil n'est plus relié : l'interface le dira
        }
        cookies.flush();
    }

    /** La page ne s'ouvre qu'une fois la session prête. Injoignable : page d'attente, jamais de demande d'appairage. */
    private void openPage(String path) {
        later.removeCallbacks(reload);
        renewWindow(state -> {
            if (isDestroyed() || bridge == null) return;
            if (Pairing.Window.OPEN.equals(state) || Pairing.Window.REFUSED.equals(state)) {
                retryPage = "/";
                bridge.getWebView().loadUrl(server + path);
                return;
            }
            retryPage = path;
            String page = Pairing.Window.SERVER_TOO_OLD.equals(state) ? TOO_OLD : OFFLINE;
            bridge.getWebView().loadDataWithBaseURL(null, page, "text/html", "utf-8", null);
            later.postDelayed(reload, 5000);
        });
    }

    @Override
    public void onResume() {
        super.onResume();
        // Retour au premier plan : la session a pu expirer pendant l'absence (au lancement, l'échange est déjà parti).
        if (server != null && token != null && bridge != null) renewWindow(state -> { });
    }

    private static final String OFFLINE = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
        + "<body style='margin:0;height:100vh;display:grid;place-items:center;font:16px sans-serif;background:#EEF1F4;color:#333'>"
        + "<div style='text-align:center;padding:24px'><h2>Noah Agent</h2><p>Ton serveur ne répond pas.<br>"
        + "Reconnexion automatique…</p></div>";
    private static final String TOO_OLD = OFFLINE.replace("Ton serveur ne répond pas.", "Ton serveur doit être mis à jour pour cette version de l'app.");
    private final Runnable reload = () -> {
        if (bridge != null && server != null) openPage(retryPage);
    };

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
            if (inCall) { // la page qui tenait l'appel va être remplacée : personne ne pourrait plus raccrocher
                CallSession.stop(this);
                setInCall(false);
            }
            openPage(page(intent));
        }
    }
}
