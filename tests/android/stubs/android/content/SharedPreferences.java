package android.content;

public interface SharedPreferences {
    String getString(String key, String fallback);
    int getInt(String key, int fallback);
    long getLong(String key, long fallback);
    Editor edit();

    interface Editor {
        Editor putString(String key, String value);
        Editor putInt(String key, int value);
        Editor putLong(String key, long value);
        Editor remove(String key);
        Editor clear();
        boolean commit();
    }
}
