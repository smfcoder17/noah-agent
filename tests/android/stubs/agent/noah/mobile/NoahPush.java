package agent.noah.mobile;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Le vrai NoahPush dépend d'Android et d'UnifiedPush : seule son identité courte sert à Pairing (même calcul). */
final class NoahPush {
    static String tag(String token) throws Exception {
        return hex(sha256("noah-push:" + hex(sha256(token)))).substring(0, 16);
    }

    private static byte[] sha256(String s) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
    }

    private static String hex(byte[] b) {
        StringBuilder out = new StringBuilder();
        for (byte x : b) out.append(String.format("%02x", x));
        return out.toString();
    }
}
