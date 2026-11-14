package agent.noah.mobile;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Chaque forme et chaque détail se voient vraiment dans le dessin natif. Laisse les images dans le dossier de l'app (fichiers/visages) :
 * tests/android/visages_compare.mjs les compare au vrai composant de l'interface.
 *
 *   ./gradlew assembleGithubDebug assembleGithubDebugAndroidTest ; adb install -r -t les deux APK
 *   adb shell am instrument -w -e class agent.noah.mobile.NoahFaceTest agent.noah.mobile.test/androidx.test.runner.AndroidJUnitRunner
 */
@RunWith(AndroidJUnit4.class)
public class NoahFaceTest {

    private static final String[] SHAPES = { "gomme", "bulle", "cube", "goutte", "pastille" };
    private static final String[] DETAILS = { "", "lunettes", "antenne", "sourcils", "joues" };
    private static final int SIZE = 256;
    private static final int PURPLE = Color.parseColor("#8b6cf0");

    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

    @Test
    public void chaqueVisageEstDifferentEtEnregistre() throws Exception {
        File dir = new File(context.getExternalFilesDir(null), "visages");
        dir.mkdirs();
        Map<String, Bitmap> faces = new HashMap<>();
        for (String shape : SHAPES) {
            for (String detail : DETAILS) {
                Bitmap face = NoahFace.bitmap(context, PURPLE, shape, detail, SIZE);
                try (FileOutputStream out = new FileOutputStream(new File(dir, shape + "-" + (detail.isEmpty() ? "aucun" : detail) + ".png"))) {
                    face.compress(Bitmap.CompressFormat.PNG, 100, out);
                }
                for (Map.Entry<String, Bitmap> other : faces.entrySet()) {
                    assertFalse(shape + "/" + detail + " dessiné comme " + other.getKey(), face.sameAs(other.getValue()));
                }
                faces.put(shape + "/" + detail, face);
            }
        }
    }

    @Test
    public void uneValeurInconnueRetombeSurLeVisageDorigine() {
        Bitmap origin = NoahFace.bitmap(context, PURPLE, "gomme", "", SIZE);
        assertTrue(origin.sameAs(NoahFace.bitmap(context, PURPLE, "forme-future", "detail-futur", SIZE)));
        assertTrue(origin.sameAs(NoahFace.bitmap(context, PURPLE, null, null, SIZE)));
        assertTrue(origin.sameAs(NoahFace.bitmap(context, PURPLE, "", "", SIZE)));
    }
}
