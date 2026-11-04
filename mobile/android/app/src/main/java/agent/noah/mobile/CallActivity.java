package agent.noah.mobile;

import android.animation.AnimatorSet;
import android.animation.ObjectAnimator;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.app.KeyguardManager;
import android.app.NotificationManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * Un agent rappelle : écran d'appel, même téléphone verrouillé. Il ne montre que le nom de l'agent : aucun compte rendu
 * sur l'écran verrouillé, et la fenêtre de Noah ne s'ouvre qu'une fois le téléphone déverrouillé.
 */
public class CallActivity extends Activity {

    static final String TITLE = "titre";
    static final String URL = "url";
    static final String NOTIFICATION = "notification";
    private static final long RING_MILLIS = 60000; // la durée de sonnerie du serveur
    private static final int ACCENT = Color.parseColor("#F0653A"); // la couleur de Noah
    private static final int ANSWER = Color.parseColor("#22A565");
    private static final int DECLINE = Color.parseColor("#D93A3A");

    private final Handler later = new Handler(Looper.getMainLooper());
    private final List<ValueAnimator> waves = new ArrayList<>();

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        int pad = dp(32);
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setGravity(Gravity.CENTER_HORIZONTAL);
        page.setPadding(pad, dp(72), pad, dp(56));
        page.setBackgroundColor(Color.parseColor("#14161A"));

        String title = getIntent().getStringExtra(TITLE);
        title = title == null ? "Noah" : title;

        TextView kind = new TextView(this);
        kind.setText("Appel vocal de ton agent");
        kind.setTextColor(Color.parseColor("#A9AEB8"));
        kind.setTextSize(15);
        kind.setGravity(Gravity.CENTER);
        page.addView(kind);

        TextView who = new TextView(this);
        who.setText(title);
        who.setTextColor(Color.WHITE);
        who.setTextSize(30);
        who.setGravity(Gravity.CENTER);
        who.setPadding(0, dp(8), 0, 0);
        page.addView(who);

        // Le visage de l'agent et ses ondes, au centre libre de l'écran.
        FrameLayout center = new FrameLayout(this);
        LinearLayout.LayoutParams grow = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
        page.addView(center, grow);
        FrameLayout.LayoutParams middle = new FrameLayout.LayoutParams(dp(112), dp(112), Gravity.CENTER);
        for (int i = 0; i < 3; i++) center.addView(wave(i), middle);
        TextView face = new TextView(this);
        face.setText(title.substring(0, 1).toUpperCase());
        face.setTextColor(Color.WHITE);
        face.setTextSize(44);
        face.setTypeface(Typeface.DEFAULT_BOLD);
        face.setGravity(Gravity.CENTER);
        face.setBackground(round(ACCENT));
        center.addView(face, middle);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER);
        actions.addView(action("Refuser", "✕", DECLINE, v -> decline()));
        View gap = new View(this);
        actions.addView(gap, new LinearLayout.LayoutParams(dp(72), 1));
        actions.addView(action("Répondre", "✆", ANSWER, v -> answer()));
        page.addView(actions);

        setContentView(page);
        later.postDelayed(this::finish, RING_MILLIS);
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density);
    }

    private static GradientDrawable round(int color) {
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.OVAL);
        d.setColor(color);
        return d;
    }

    /** Une onde : part du visage, grandit et s'efface, décalée des deux autres. */
    private View wave(int index) {
        View v = new View(this);
        v.setBackground(round(ACCENT));
        v.setAlpha(0f);
        ValueAnimator grow = ValueAnimator.ofFloat(0f, 1f);
        grow.setDuration(2400);
        grow.setStartDelay(index * 800L);
        grow.setRepeatCount(ValueAnimator.INFINITE);
        grow.addUpdateListener(a -> {
            float t = (float) a.getAnimatedValue();
            v.setScaleX(1f + t * 1.1f);
            v.setScaleY(1f + t * 1.1f);
            v.setAlpha(0.42f * (1f - t));
        });
        grow.start();
        waves.add(grow);
        return v;
    }

    private View action(String label, String sign, int color, View.OnClickListener click) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        TextView button = new TextView(this);
        button.setText(sign);
        button.setTextColor(Color.WHITE);
        button.setTextSize(30);
        button.setGravity(Gravity.CENTER);
        button.setBackground(round(color));
        button.setContentDescription(label);
        button.setClickable(true);
        button.setFocusable(true);
        button.setOnClickListener(click);
        box.addView(button, new LinearLayout.LayoutParams(dp(76), dp(76)));
        if (color == ANSWER) { // le bouton vert appelle le geste, comme sur un téléphone
            AnimatorSet nudge = new AnimatorSet();
            ObjectAnimator x = ObjectAnimator.ofFloat(button, "scaleX", 1f, 1.1f);
            ObjectAnimator y = ObjectAnimator.ofFloat(button, "scaleY", 1f, 1.1f);
            for (ObjectAnimator a : new ObjectAnimator[] { x, y }) {
                a.setDuration(600);
                a.setRepeatCount(ValueAnimator.INFINITE);
                a.setRepeatMode(ValueAnimator.REVERSE);
                waves.add(a);
            }
            nudge.playTogether(x, y);
            nudge.start();
        }
        TextView name = new TextView(this);
        name.setText(label);
        name.setTextColor(Color.WHITE);
        name.setTextSize(14);
        name.setGravity(Gravity.CENTER);
        name.setPadding(0, dp(8), 0, 0);
        box.addView(name);
        return box;
    }

    private void silence() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(getIntent().getIntExtra(NOTIFICATION, 0));
    }

    /** Déverrouiller d'abord : la conversation ne s'affiche pas par-dessus un téléphone verrouillé. */
    private void answer() {
        silence();
        Intent open = new Intent(this, MainActivity.class).putExtra("url", getIntent().getStringExtra(URL))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        KeyguardManager keyguard = getSystemService(KeyguardManager.class);
        if (Build.VERSION.SDK_INT >= 26 && keyguard != null && keyguard.isKeyguardLocked()) {
            keyguard.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                @Override
                public void onDismissSucceeded() {
                    startActivity(open);
                    finish();
                }
            });
            return;
        }
        startActivity(open);
        finish();
    }

    private void decline() {
        silence();
        String url = getIntent().getStringExtra(URL);
        Pairing pairing = new Pairing(this);
        String server = pairing.server(), token = pairing.session();
        if (url != null && url.startsWith(NoahPush.CALL_URL) && server != null && token != null) {
            String id = url.substring(NoahPush.CALL_URL.length());
            new Thread(() -> {
                try {
                    NoahPush.call("POST", server + "/api/calls/" + id + "/decline", token, "{}");
                } catch (Exception ignored) {
                    // serveur injoignable : l'appel finira en « manqué », et le compte rendu reste écrit
                }
            }).start();
        }
        finish();
    }

    @Override
    protected void onDestroy() {
        later.removeCallbacksAndMessages(null);
        for (ValueAnimator a : waves) a.cancel();
        super.onDestroy();
    }
}
