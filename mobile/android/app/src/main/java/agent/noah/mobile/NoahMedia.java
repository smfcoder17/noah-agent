package agent.noah.mobile;

import android.content.Context;
import android.net.Uri;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.Arrays;
import java.util.Comparator;

/** Fichiers de Noah uniquement : pas de redirection, pas de jeton envoyé à un autre hôte. */
final class NoahMedia {
    static final long MAX = 64L * 1024 * 1024;
    static final class Local {
        final File file;
        final Uri uri;
        final String mime;
        Local(Context context, File file, String mime) {
            this.file = file; this.mime = mime;
            this.uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
        }
    }
    static URI checked(String server, String address) throws Exception {
        URI base = new URI(server), url = base.resolve(address).normalize();
        if (!("https".equals(url.getScheme()) || (BuildConfig.DEBUG && "http".equals(url.getScheme())))
            || !url.getScheme().equals(base.getScheme()) || !java.util.Objects.equals(url.getHost(), base.getHost())
            || effectivePort(url) != effectivePort(base) || url.getUserInfo() != null || url.getFragment() != null
            || !url.getPath().startsWith("/api/") || url.getPath().contains("..")) throw new Exception("Adresse refusée");
        return url;
    }
    private static int effectivePort(URI uri) { return uri.getPort() == -1 ? ("https".equals(uri.getScheme()) ? 443 : 80) : uri.getPort(); }
    static Local fetch(Context context, String address, String name) throws Exception {
        Pairing pairing = new Pairing(context);
        if (pairing.server() == null || pairing.token() == null) throw new Exception("Appareil déconnecté");
        URI url = checked(pairing.server(), address);
        File folder = new File(context.getCacheDir(), "elements");
        if (!folder.isDirectory() && !folder.mkdirs()) throw new Exception("Espace indisponible");
        File[] old = folder.listFiles();
        if (old != null) {
            Arrays.sort(old, Comparator.comparingLong(File::lastModified));
            for (int i = 0; i < old.length; i++) if (i < old.length - 7 || old[i].lastModified() < System.currentTimeMillis() - 86400000L) old[i].delete();
        }
        String safeName = (name == null ? "fichier" : name).replaceAll("[^\\p{L}\\p{N}._ -]", "_");
        if (safeName.length() > 100) safeName = safeName.substring(safeName.length() - 100);
        File file = new File(folder, java.util.UUID.randomUUID() + "-" + safeName);
        HttpURLConnection http = (HttpURLConnection) new URL(url.toString()).openConnection();
        http.setInstanceFollowRedirects(false);
        http.setConnectTimeout(8000); http.setReadTimeout(15000);
        http.setRequestProperty("Authorization", "Bearer " + pairing.token());
        try {
            if (http.getResponseCode() != 200) throw new Exception("Fichier introuvable ou accès refusé");
            if (http.getContentLengthLong() > MAX) throw new Exception("Fichier trop volumineux");
            long total = 0, deadline = System.currentTimeMillis() + 60000;
            try (InputStream in = http.getInputStream(); FileOutputStream out = new FileOutputStream(file)) {
                byte[] buffer = new byte[16384];
                for (int n; (n = in.read(buffer)) != -1;) {
                    total += n;
                    if (total > MAX || System.currentTimeMillis() > deadline) throw new Exception("Fichier trop volumineux ou lecture trop longue");
                    out.write(buffer, 0, n);
                }
            }
            String mime = http.getContentType();
            if (mime == null || mime.startsWith("application/octet-stream")) mime = java.net.URLConnection.guessContentTypeFromName(safeName);
            return new Local(context, file, mime == null ? "application/octet-stream" : mime.split(";")[0]);
        } catch (Exception e) { file.delete(); throw e; }
        finally { http.disconnect(); }
    }
}
