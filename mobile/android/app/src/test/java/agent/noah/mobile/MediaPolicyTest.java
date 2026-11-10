package agent.noah.mobile;
import org.junit.Test;
import static org.junit.Assert.*;
public class MediaPolicyTest {
    @Test public void sameOriginOnly() throws Exception {
        assertEquals("noah.exemple.com", NoahMedia.checked("https://noah.exemple.com", "/api/agents/a/files/raw/image.png").getHost());
        for (String address : new String[] { "https://autre.fr/api/fichier", "https://noah.exemple.com:444/api/fichier", "https://moi:secret@noah.exemple.com/api/fichier", "file:///etc/passwd", "//autre.fr/api/image", "/hors-api" }) {
            try { NoahMedia.checked("https://noah.exemple.com", address); fail(address); } catch (Exception expected) { }
        }
    }
}
