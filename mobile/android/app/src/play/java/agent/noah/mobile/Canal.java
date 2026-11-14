package agent.noah.mobile;

import android.content.Context;
import com.getcapacitor.PluginCall;

/**
 * Canal Play : le Play Store seul met l'app à jour (règles de Google). Ni téléchargement, ni installation d'APK ici ;
 * l'interface lit info().canal et renvoie vers la fiche du Play Store.
 */
final class Canal {
    private Canal() {}

    static void installUpdate(Context context, PluginCall call) {
        call.reject("Les mises à jour de cette version arrivent par le Play Store.", "play");
    }
}
