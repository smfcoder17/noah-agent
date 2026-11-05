package android.content;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Le fichier des préférences : `disk` est ce qu'une copie des fichiers de l'app emporterait. */
public class MemoryPreferences implements SharedPreferences {
    public final Map<String, Object> disk = new ConcurrentHashMap<>();

    public String getString(String key, String fallback) {
        Object v = disk.get(key);
        return v == null ? fallback : (String) v;
    }

    public int getInt(String key, int fallback) {
        Object v = disk.get(key);
        return v == null ? fallback : (Integer) v;
    }

    public long getLong(String key, long fallback) {
        Object v = disk.get(key);
        return v == null ? fallback : (Long) v;
    }

    public Editor edit() {
        return new Editor() {
            private final List<Runnable> steps = new ArrayList<>();
            private boolean wipe;

            public Editor putString(String key, String value) {
                steps.add(() -> disk.put(key, value));
                return this;
            }

            public Editor putInt(String key, int value) {
                steps.add(() -> disk.put(key, value));
                return this;
            }

            public Editor putLong(String key, long value) {
                steps.add(() -> disk.put(key, value));
                return this;
            }

            public Editor remove(String key) {
                steps.add(() -> disk.remove(key));
                return this;
            }

            public Editor clear() {
                wipe = true;
                return this;
            }

            public boolean commit() {
                if (wipe) disk.clear(); // comme Android : clear() passe avant les put du même edit, quel que soit l'ordre
                steps.forEach(Runnable::run);
                return true;
            }
        };
    }
}
