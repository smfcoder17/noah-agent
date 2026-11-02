package agent.noah.mobile;

import android.os.Build;
import android.webkit.CookieManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Pont entre les pages et l'app : l'écran de connexion y range le serveur et la session obtenus à l'appairage ;
 * l'interface de Noah, ouverte depuis le serveur, peut demander à oublier ce serveur.
 */
@CapacitorPlugin(name = "NoahShell")
public class NoahShellPlugin extends Plugin {

    @PluginMethod
    public void info(PluginCall call) {
        JSObject out = new JSObject();
        out.put("server", new Pairing(getContext()).server());
        out.put("device", Build.MANUFACTURER + " " + Build.MODEL);
        out.put("version", BuildConfig.VERSION_NAME);
        call.resolve(out);
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String server = call.getString("server");
        String token = call.getString("token");
        boolean secure = server != null && (server.startsWith("https://") || BuildConfig.DEBUG);
        if (server == null || token == null || !secure) {
            call.reject("Adresse ou session manquante (le serveur doit être en HTTPS)");
            return;
        }
        try {
            new Pairing(getContext()).save(server, token);
        } catch (Exception e) {
            call.reject("Impossible de ranger la session : " + e.getMessage());
            return;
        }
        call.resolve();
        getActivity().runOnUiThread(() -> getActivity().recreate());
    }

    /** Session réellement utilisée par la fenêtre (cookie apollo_session), ou null. */
    private static String windowToken(String server) {
        String all = server == null ? null : CookieManager.getInstance().getCookie(server);
        if (all == null) return null;
        for (String part : all.split(";")) {
            String p = part.trim();
            if (p.startsWith("apollo_session=")) return p.substring("apollo_session=".length());
        }
        return null;
    }

    @PluginMethod
    public void forget(PluginCall call) {
        Pairing pairing = new Pairing(getContext());
        pairing.forget(windowToken(pairing.server()));
        new Thread(pairing::revokeForgotten).start();
        CookieManager.getInstance().removeAllCookies(null);
        CookieManager.getInstance().flush();
        call.resolve();
        getActivity().runOnUiThread(() -> getActivity().recreate());
    }
}
