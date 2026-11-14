package agent.noah.mobile;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.PluginCall;

/** Canal GitHub : l'app se met à jour depuis l'APK de sa Release (la version Play a son propre Canal, sans ce code). */
final class Canal {
    private Canal() {}

    /**
     * Nouvelle version de l'app : télécharge l'APK de la Release (sans les cookies du serveur), puis ouvre l'installateur
     * d'Android, qui demande un geste à la personne. Android refuse une APK signée par une autre clé : seule une vraie
     * version de Noah peut remplacer l'app. Première fois : Android demande d'autoriser Noah à installer des apps.
     */
    static void installUpdate(Context context, PluginCall call) {
        String url = call.getString("url", "");
        Uri parsed = Uri.parse(url);
        if (!"https".equals(parsed.getScheme()) || !"github.com".equals(parsed.getHost()) || !url.endsWith(".apk")) {
            call.reject("Adresse de mise à jour refusée");
            return;
        }
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
}
