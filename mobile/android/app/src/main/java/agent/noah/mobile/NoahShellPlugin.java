package agent.noah.mobile;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.CookieManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Pont entre les pages et l'app : l'écran de connexion y range le serveur et la session obtenus à l'appairage ;
 * l'interface de Noah, ouverte depuis le serveur, peut demander à oublier ce serveur.
 */
@CapacitorPlugin(name = "NoahShell", permissions = {
    @Permission(alias = "micro", strings = { Manifest.permission.RECORD_AUDIO }),
    @Permission(alias = "position", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }),
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
})
public class NoahShellPlugin extends Plugin {

    // --- Réglages > Téléphone : l'état réel de chaque droit. Rien n'est demandé ailleurs qu'à l'usage ou depuis cet écran. ---

    private SharedPreferences rightsPrefs() {
        return Pairing.options(getContext());
    }

    /** accorde, a_demander, refuse, ou bloque : Android ne montrera plus sa fenêtre, seul son écran de réglages peut changer ça. */
    private String stateOf(String alias, String permission) {
        if (getPermissionState(alias) == PermissionState.GRANTED) return "accorde";
        if (!rightsPrefs().getBoolean(alias, false)) return "a_demander";
        return getActivity() != null && getActivity().shouldShowRequestPermissionRationale(permission) ? "refuse" : "bloque";
    }

    @PluginMethod
    public void droits(PluginCall call) {
        Context context = getContext();
        JSObject out = new JSObject();
        String notifications = Build.VERSION.SDK_INT >= 33 ? stateOf("notifications", Manifest.permission.POST_NOTIFICATIONS) : "a_demander";
        if (NoahPush.visible(context)) notifications = "accorde";
        else if (Build.VERSION.SDK_INT < 33 || "accorde".equals(notifications)) notifications = "bloque"; // coupées dans les réglages d'Android
        out.put("notifications", notifications);
        out.put("micro", stateOf("micro", Manifest.permission.RECORD_AUDIO));
        out.put("photos", "sans_droit"); // le sélecteur d'Android : Noah reçoit ce que la personne choisit, sans accès à la galerie
        out.put("position", stateOf("position", Manifest.permission.ACCESS_FINE_LOCATION));
        out.put("superposition", Settings.canDrawOverlays(context) ? "accorde" : "a_demander");
        PowerManager power = context.getSystemService(PowerManager.class);
        out.put("batterie", power != null && power.isIgnoringBatteryOptimizations(context.getPackageName()) ? "accorde" : "a_demander");
        out.put("distributeurs", org.unifiedpush.android.connector.UnifiedPush.getDistributors(context).size());
        out.put("inscrit", org.unifiedpush.android.connector.UnifiedPush.getAckDistributor(context) != null && new Pairing(context).pushTag() != null);
        out.put("positionActive", rightsPrefs().getBoolean("positionActive", false) && getPermissionState("position") == PermissionState.GRANTED);
        JSObject bulle = new JSObject();
        bulle.put("active", NoahBubble.isRunning());
        bulle.put("agent", NoahBubble.chosenAgent(context));
        out.put("bulle", bulle);
        call.resolve(out);
    }

    /** Demande le droit, ou ouvre le bon écran d'Android quand la fenêtre de demande n'existe pas (ou plus). */
    @PluginMethod
    public void demanderDroit(PluginCall call) {
        String right = call.getString("droit", "");
        Context context = getContext();
        Uri app = Uri.parse("package:" + context.getPackageName());
        switch (right) {
            case "superposition":
                openScreen(call, new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, app));
                return;
            case "batterie":
                openScreen(call, new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, app));
                return;
            case "micro":
            case "position":
            case "notifications":
                break;
            default:
                call.reject("Droit inconnu");
                return;
        }
        String permission = "micro".equals(right) ? Manifest.permission.RECORD_AUDIO : "position".equals(right) ? Manifest.permission.ACCESS_FINE_LOCATION : Manifest.permission.POST_NOTIFICATIONS;
        boolean runtime = !"notifications".equals(right) || Build.VERSION.SDK_INT >= 33;
        if (!runtime || "bloque".equals(stateOf(right, permission))) {
            Intent screen = "notifications".equals(right)
                ? new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName())
                : new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, app);
            openScreen(call, screen);
            return;
        }
        rightsPrefs().edit().putBoolean(right, true).apply();
        requestPermissionForAlias(right, call, "afterRight");
    }

    @PermissionCallback
    private void afterRight(PluginCall call) {
        call.resolve();
    }

    private void openScreen(PluginCall call, Intent screen) {
        try {
            getActivity().startActivity(screen);
            call.resolve();
        } catch (Exception e) {
            call.reject("Cet écran n'existe pas sur ce téléphone.");
        }
    }

    /** « Joindre ma position » : activé ici. Retiré, le droit reste à Android ; plus rien ne le lit. */
    @PluginMethod
    public void positionOption(PluginCall call) {
        rightsPrefs().edit().putBoolean("positionActive", Boolean.TRUE.equals(call.getBoolean("actif"))).apply();
        call.resolve();
    }

    /** Une lecture, au toucher de la personne. Jamais de suivi : ni abonnement qui dure, ni arrière-plan. */
    @PluginMethod
    public void position(PluginCall call) {
        if (!rightsPrefs().getBoolean("positionActive", false) || getPermissionState("position") != PermissionState.GRANTED) {
            call.reject("La position n'est pas activée dans Réglages > Téléphone.");
            return;
        }
        LocationManager locations = getContext().getSystemService(LocationManager.class);
        String provider = bestProvider(locations);
        if (provider == null) {
            call.reject("La localisation est coupée sur ce téléphone.");
            return;
        }
        if (Build.VERSION.SDK_INT >= 30) {
            CancellationSignal cancel = new CancellationSignal();
            Handler main = new Handler(Looper.getMainLooper());
            boolean[] done = { false };
            Runnable giveUp = () -> {
                if (done[0]) return;
                done[0] = true;
                cancel.cancel();
                answerPosition(call, lastKnown(locations));
            };
            main.postDelayed(giveUp, 12_000);
            locations.getCurrentLocation(provider, cancel, getContext().getMainExecutor(), found -> {
                if (done[0]) return;
                done[0] = true;
                main.removeCallbacks(giveUp);
                answerPosition(call, found != null ? found : lastKnown(locations));
            });
        } else {
            answerPosition(call, lastKnown(locations));
        }
    }

    private static String bestProvider(LocationManager locations) {
        if (Build.VERSION.SDK_INT >= 31 && locations.isProviderEnabled(LocationManager.FUSED_PROVIDER)) return LocationManager.FUSED_PROVIDER;
        if (locations.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) return LocationManager.NETWORK_PROVIDER;
        return locations.isProviderEnabled(LocationManager.GPS_PROVIDER) ? LocationManager.GPS_PROVIDER : null;
    }

    private static Location lastKnown(LocationManager locations) {
        Location best = null;
        for (String provider : locations.getProviders(true)) {
            Location one;
            try {
                one = locations.getLastKnownLocation(provider);
            } catch (SecurityException e) {
                one = null;
            }
            if (one != null && (best == null || one.getTime() > best.getTime())) best = one;
        }
        return best;
    }

    private static void answerPosition(PluginCall call, Location found) {
        if (found == null) {
            call.reject("Le téléphone ne trouve pas sa position pour l'instant.");
            return;
        }
        JSObject out = new JSObject();
        out.put("latitude", found.getLatitude());
        out.put("longitude", found.getLongitude());
        out.put("precision", found.hasAccuracy() ? found.getAccuracy() : 0);
        call.resolve(out);
    }

    /** APK de débogage seulement : voir NoahBubble.testThreshold. */
    @PluginMethod
    public void bulleEssai(PluginCall call) {
        NoahBubble.testThreshold(call.getInt("seuil", 300));
        call.resolve();
    }

    /** Mode flottant : lancé depuis l'app ouverte, par un geste de la personne (voir NoahBubble). */
    @PluginMethod
    public void bulle(PluginCall call) {
        Context context = getContext();
        if (!Boolean.TRUE.equals(call.getBoolean("actif"))) {
            NoahBubble.stop(context);
            call.resolve();
            return;
        }
        String agent = call.getString("agent");
        if (agent == null) {
            call.reject("Choisis un agent.");
            return;
        }
        if (!Settings.canDrawOverlays(context)) {
            call.reject("Autorise d'abord la superposition.");
            return;
        }
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            call.reject("Autorise d'abord le micro.");
            return;
        }
        NoahBubble.start(context, agent, call.getString("nom", ""), call.getString("couleur", ""), call.getString("forme", ""), call.getString("detail", ""));
        call.resolve();
    }

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

    /**
     * Nouvelle version de l'app : télécharge l'APK de la Release (sans les cookies du serveur), puis ouvre l'installateur
     * d'Android, qui demande un geste à la personne. Android refuse une APK signée par une autre clé : seule une vraie
     * version de Noah peut remplacer l'app. Première fois : Android demande d'autoriser Noah à installer des apps.
     */
    @PluginMethod
    public void installUpdate(PluginCall call) {
        String url = call.getString("url", "");
        Uri parsed = Uri.parse(url);
        if (!"https".equals(parsed.getScheme()) || !"github.com".equals(parsed.getHost()) || !url.endsWith(".apk")) {
            call.reject("Adresse de mise à jour refusée");
            return;
        }
        Context context = getContext();
        if (Build.VERSION.SDK_INT >= 26 && !context.getPackageManager().canRequestPackageInstalls()) {
            Intent allow = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName()));
            allow.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(allow);
            call.reject("Autorise Noah à installer des apps, puis appuie à nouveau sur Installer.", "permission");
            return;
        }
        // Dans le dossier de l'app (rien à autoriser) ; un nom déjà pris reçoit un suffixe, jamais l'ancien fichier.
        android.app.DownloadManager manager = (android.app.DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        android.app.DownloadManager.Request request = new android.app.DownloadManager.Request(parsed)
            .setTitle("Mise à jour de Noah")
            .setMimeType("application/vnd.android.package-archive")
            .setDestinationInExternalFilesDir(context, "mises-a-jour", "noah-agent.apk")
            .setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE);
        long id = manager.enqueue(request);
        android.content.BroadcastReceiver done = new android.content.BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent intent) {
                if (intent.getLongExtra(android.app.DownloadManager.EXTRA_DOWNLOAD_ID, -1) != id) return;
                c.unregisterReceiver(this);
                android.database.Cursor row = manager.query(new android.app.DownloadManager.Query().setFilterById(id));
                boolean ok = row != null && row.moveToFirst()
                    && row.getInt(row.getColumnIndexOrThrow(android.app.DownloadManager.COLUMN_STATUS)) == android.app.DownloadManager.STATUS_SUCCESSFUL;
                if (row != null) row.close();
                if (!ok) {
                    android.widget.Toast.makeText(c, "La mise à jour n'a pas pu être téléchargée.", android.widget.Toast.LENGTH_LONG).show();
                    return;
                }
                Uri file = manager.getUriForDownloadedFile(id); // content:// du gestionnaire, lisible par l'installateur
                Intent install = new Intent(Intent.ACTION_VIEW).setDataAndType(file, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                c.startActivity(install);
            }
        };
        android.content.IntentFilter filter = new android.content.IntentFilter(android.app.DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(done, filter, Context.RECEIVER_EXPORTED);
        else context.registerReceiver(done, filter);
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
        // Jamais à l'ouverture de l'app : seulement quand la personne touche « Activer ».
        if (Boolean.TRUE.equals(call.getBoolean("demander")) && Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED
            && !"bloque".equals(stateOf("notifications", Manifest.permission.POST_NOTIFICATIONS))) {
            rightsPrefs().edit().putBoolean("notifications", true).apply();
            requestPermissionForAlias("notifications", call, "afterRight");
            return;
        }
        call.resolve();
    }

    /** Déconnexion dans l'interface (ou session refusée) : plus aucun contenu de notification affiché ici. */
    @PluginMethod
    public void pushForget(PluginCall call) {
        NoahPush.stop(getContext());
        NoahBubble.stop(getContext()); // déconnecté : la bulle ne dicte plus avec le jeton de cet appareil
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
        NoahBubble.stop(getContext());
        new Thread(pairing::revokeForgotten).start();
        CookieManager.getInstance().removeAllCookies(null);
        CookieManager.getInstance().flush();
        call.resolve();
        getActivity().runOnUiThread(() -> getActivity().recreate());
    }
}
