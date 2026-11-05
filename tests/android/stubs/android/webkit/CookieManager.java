package android.webkit;

public final class CookieManager {
    private static final CookieManager ONE = new CookieManager();
    public static String cookies;

    public static CookieManager getInstance() {
        return ONE;
    }

    public String getCookie(String url) {
        return cookies;
    }
}
