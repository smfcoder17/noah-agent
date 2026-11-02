package agent.noah.mobile;

import android.net.Uri;
import android.os.Bundle;
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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(NoahShellPlugin.class);
        Pairing pairing = new Pairing(this);
        new Thread(pairing::revokeForgotten).start(); // sessions oubliées hors ligne : révoquées dès que possible
        server = pairing.server();
        token = server == null ? null : pairing.token();
        if (server != null && token != null) {
            config = new CapConfig.Builder(this)
                .setServerUrl(server)
                .setAllowNavigation(new String[] { Uri.parse(server).getHost() })
                .setAppendedUserAgentString("NoahApp/" + BuildConfig.VERSION_NAME + " Android")
                .create();
        }
        super.onCreate(savedInstanceState);
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
        bridge.getWebView().stopLoading();
        bridge.getWebView().loadUrl(server);
    }
}
