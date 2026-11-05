package android.content;

import java.util.HashMap;
import java.util.Map;

/** Simulation : assez d'Android pour compiler et exécuter le vrai Pairing.java avec le JDK. */
public class Context {
    public static final int MODE_PRIVATE = 0;
    public final Map<String, SharedPreferences> files = new HashMap<>();
    public int lastMode = -1;

    public SharedPreferences getSharedPreferences(String name, int mode) {
        lastMode = mode;
        return files.computeIfAbsent(name, n -> new MemoryPreferences());
    }
}
