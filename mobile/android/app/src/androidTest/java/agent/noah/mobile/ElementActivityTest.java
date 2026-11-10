package agent.noah.mobile;

import android.content.Intent;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.assertTrue;

@RunWith(AndroidJUnit4.class)
public class ElementActivityTest {
    @Test public void sansFichierFermeSansPlanter() {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Intent intent = new Intent(instrumentation.getTargetContext(), ElementActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ElementActivity activity = (ElementActivity) instrumentation.startActivitySync(intent);
        instrumentation.waitForIdleSync();
        assertTrue(activity.isFinishing() || activity.isDestroyed());
    }
}
