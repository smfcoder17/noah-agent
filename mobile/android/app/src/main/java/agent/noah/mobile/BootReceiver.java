package agent.noah.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import org.unifiedpush.android.connector.UnifiedPush;

/** Téléphone redémarré : Noah peut de nouveau appeler, sans attendre qu'on rouvre l'app. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        if (new Pairing(context).server() != null && UnifiedPush.getDistributors(context).isEmpty()) CallWatch.start(context);
    }
}
