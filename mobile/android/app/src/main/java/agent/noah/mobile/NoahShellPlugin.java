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
        if (active) CallSession.start(getContext(), call.getString("agent"));
        else CallSession.stop(getContext());
        if (getActivity() instanceof MainActivity) ((MainActivity) getActivity()).setInCall(active);
        call.resolve();
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
        String server = pairing.server(), token = Pairing.windowToken(server);
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
        pairing.forget(Pairing.windowToken(pairing.server()));
        NoahPush.stop(getContext());
        new Thread(pairing::revokeForgotten).start();
        CookieManager.getInstance().removeAllCookies(null);
        CookieManager.getInstance().flush();
        call.resolve();
        getActivity().runOnUiThread(() -> getActivity().recreate());
    }
}
