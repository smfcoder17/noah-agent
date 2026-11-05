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

    /** Un appel commence ou finit dans la page : micro hors de l'application, fenêtre flottante en la quittant. */
    @PluginMethod
    public void callState(PluginCall call) {
        boolean active = Boolean.TRUE.equals(call.getBoolean("active"));
        if (active) CallSession.start(getContext(), call.getString("agent"), call.getString("color"), call.getString("shape"), call.getString("detail"));
        else CallSession.stop(getContext());
        if (getActivity() instanceof MainActivity) ((MainActivity) getActivity()).setInCall(active);
        call.resolve();
    }

    /** Télécharge un fichier du serveur : le cadre caché de la page ne déclenche pas le téléchargement dans la WebView. */
    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !(getActivity() instanceof MainActivity)) {
            call.reject("Téléchargement impossible");
            return;
        }
        String mime = call.getString("mime", "");
        getActivity().runOnUiThread(() -> { // la WebView ne se lit que depuis ce fil
            String agent = bridge.getWebView().getSettings().getUserAgentString();
            if (((MainActivity) getActivity()).downloadFromPage(url, agent, mime)) call.resolve();
            else call.reject("Téléchargement impossible");
        });
    }

    /** Un fichier fabriqué dans la page (export CSV) : un lien blob: ne peut pas passer par le gestionnaire de téléchargements. */
    @PluginMethod
    public void saveFile(PluginCall call) {
        String name = call.getString("name", "fichier").replaceAll("[/\\\\]", "_");
        byte[] data = call.getString("text", "").getBytes(java.nio.charset.StandardCharsets.UTF_8);
        android.content.Context context = getContext();
        try {
            // Avant Android 10, le dossier public demande une permission : l'export n'y est pas proposé (le message d'échec le dit).
            if (Build.VERSION.SDK_INT < 29) throw new java.io.IOException("Android trop ancien");
            android.content.ContentValues values = new android.content.ContentValues();
            values.put(android.provider.MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(android.provider.MediaStore.Downloads.MIME_TYPE, call.getString("mime", "application/octet-stream"));
            android.net.Uri file = context.getContentResolver().insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (file == null) throw new java.io.IOException("insert");
            try (java.io.OutputStream out = context.getContentResolver().openOutputStream(file)) {
                out.write(data);
            }
            android.widget.Toast.makeText(context, name + " est dans Téléchargements", android.widget.Toast.LENGTH_SHORT).show();
            call.resolve();
        } catch (Exception e) {
            android.widget.Toast.makeText(context, "Ce fichier n'a pas pu être enregistré.", android.widget.Toast.LENGTH_LONG).show();
            call.reject("Enregistrement impossible");
        }
    }

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
        if (org.unifiedpush.android.connector.UnifiedPush.getDistributors(getContext()).isEmpty()) CallWatch.start(getContext());
        call.resolve();
        getActivity().runOnUiThread(() -> getActivity().recreate());
    }


    /**
     * La session de la fenêtre a été refusée : l'interface demande à l'app d'en rouvrir une avant de conclure quoi que ce
     * soit. Rend seulement l'état (ok, refuse, injoignable, ancien) : la session va directement dans le cookie HttpOnly.
     */
    @PluginMethod
    public void renewSession(PluginCall call) {
        if (!(getActivity() instanceof MainActivity)) {
            call.reject("Fenêtre fermée");
            return;
        }
        ((MainActivity) getActivity()).renewWindow(state -> {
            JSObject out = new JSObject();
            out.put("etat", state);
            call.resolve(out);
        });
    }

    /** Notifications : un distributeur UnifiedPush est-il installé, et l'app est-elle inscrite chez lui ? */
    @PluginMethod
    public void pushStatus(PluginCall call) {
        JSObject out = new JSObject();
        out.put("distributeurs", org.unifiedpush.android.connector.UnifiedPush.getDistributors(getContext()).size());
        // « Inscrit » : distributeur d'accord ET abonnement accepté par le serveur pour la session ouverte.
        Pairing pairing = new Pairing(getContext());
        boolean local = org.unifiedpush.android.connector.UnifiedPush.getAckDistributor(getContext()) != null
            && pairing.pushTag() != null;
        // Confirmé par le serveur (il a pu supprimer l'abonnement après un 404/410) ; injoignable : on garde l'état local.
        Boolean server = local ? NoahPush.serverHasUs(pairing) : Boolean.FALSE;
        out.put("inscrit", local && !Boolean.FALSE.equals(server));
        out.put("permission", NoahPush.visible(getContext()));
        call.resolve(out);
    }

    /** Relance l'inscription (après l'installation d'un distributeur comme ntfy). */
    @PluginMethod
    public void pushSetup(PluginCall call) {
        Pairing pairing = new Pairing(getContext());
        String server = pairing.server(), token = pairing.token();
        if (server != null && token != null) NoahPush.start(getActivity(), server, token);
        call.resolve();
    }

    /** Déconnexion dans l'interface (ou session refusée) : plus aucun contenu de notification affiché ici. */
    @PluginMethod
    public void pushForget(PluginCall call) {
        NoahPush.stop(getContext());
        call.resolve();
    }

    /** Session reçue trop tard (demande remplacée) : révoquée, et gardée en file si le serveur ne répond pas. */
    @PluginMethod
    public void revokeLater(PluginCall call) {
        String server = call.getString("server"), token = call.getString("token");
        if (server != null && token != null) {
            Pairing pairing = new Pairing(getContext());
            pairing.queueRevocation(server, token);
            new Thread(pairing::revokeForgotten).start();
        }
        call.resolve();
    }

    @PluginMethod
    public void forget(PluginCall call) {
        Pairing pairing = new Pairing(getContext());
        pairing.forget();
        NoahPush.stop(getContext());
        new Thread(pairing::revokeForgotten).start();
        CookieManager.getInstance().removeAllCookies(null);
        CookieManager.getInstance().flush();
        call.resolve();
        getActivity().runOnUiThread(() -> getActivity().recreate());
    }
}
