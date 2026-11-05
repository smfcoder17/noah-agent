package agent.noah.mobile;

import android.Manifest;
import android.animation.ValueAnimator;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Matrix;
import android.graphics.PixelFormat;
import android.graphics.Shader;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioRecordingConfiguration;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.widget.TextView;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Le mode flottant : une bulle au visage de l'agent, au-dessus des autres apps. Toucher ouvre Noah ; maintenir dicte, relâcher
 * envoie ; glisser sur « Annuler » annule. Elle ne lit rien des autres apps et n'utilise le réseau que le temps d'une dictée.
 *
 * Le micro : Android coupe le son d'un service lancé en arrière-plan (Android 11 et plus). Celui-ci démarre toujours depuis l'app ouverte,
 * à la demande de la personne, avec le type « microphone » : il garde le droit d'écouter tant qu'il tourne. Il ne redémarre donc
 * jamais seul, ni après un redémarrage du téléphone. Le jeton reste dans Pairing, chiffré : aucune vue ne le touche.
 */
public class NoahBubble extends Service {

    private static final String TAG = "NoahBulle";
    private static final String STOP = "agent.noah.mobile.BULLE_ARRETER";
    private static final String CHANNEL = "noah-bulle";
    private static final int NOTIFICATION = 7303;
    private static final long HOLD_MILLIS = 300;
    private static final long SHORTEST_MILLIS = 500;
    private static final int LONGEST_MILLIS = 120_000;
    private static final int HEARD_FROM = 300; // sur 32 767 : en dessous, un modèle de transcription inventerait un texte
    private static final long FOLLOW_MILLIS = 32_000; // au-delà de 30 s, le serveur notifie la fin : la carte passe la main
    private static final long CARD_MILLIS = 14_000;

    private static volatile boolean running;
    private static volatile int heardFrom = HEARD_FROM;

    /** APK de débogage : le micro d'un émulateur reste muet, et le parcours d'essai doit pouvoir envoyer son vrai son. */
    static void testThreshold(int value) {
        if (BuildConfig.DEBUG) heardFrom = value;
    }

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private WindowManager windows;
    private SharedPreferences prefs;
    private Face face;
    private WindowManager.LayoutParams faceParams;
    private TextView cancelZone;
    private TextView card;
    private String cardUrl;

    private MediaRecorder recorder;
    private File recording;
    private long recordingSince;
    private int peak;
    private volatile boolean silenced;
    private boolean overCancel;
    private long generation; // une nouvelle dictée remplace le suivi de la précédente

    static boolean isRunning() {
        return running;
    }

    static String chosenAgent(Context context) {
        return Pairing.options(context).getString("agent", null);
    }

    /** Depuis l'app ouverte seulement : c'est ce qui donne au service le droit d'écouter une fois l'app derrière. */
    static void start(Context context, String agent, String name, String color, String shape, String detail) {
        Pairing.options(context).edit().putString("agent", agent).putString("nom", name)
            .putString("couleur", color).putString("forme", shape).putString("detail", detail).apply();
        ContextCompat.startForegroundService(context, new Intent(context, NoahBubble.class));
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, NoahBubble.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        windows = getSystemService(WindowManager.class);
        prefs = Pairing.options(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Bulle de Noah", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, NOTIFICATION, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent halt = PendingIntent.getService(this, NOTIFICATION, new Intent(this, NoahBubble.class).setAction(STOP), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification note = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_noah).setContentTitle("La bulle de Noah est active")
            .setContentText("Maintiens-la pour dicter. Le micro n'écoute que pendant ce geste.")
            .setOngoing(true).setContentIntent(open).addAction(0, "Arrêter", halt).build();
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE | ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            else if (Build.VERSION.SDK_INT >= 30) startForeground(NOTIFICATION, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            else startForeground(NOTIFICATION, note);
        } catch (RuntimeException refused) { // micro retiré entre-temps, ou app déjà derrière : on ne reste pas à moitié
            Log.w(TAG, "démarrage refusé par Android : " + refused.getClass().getSimpleName());
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!Settings.canDrawOverlays(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        running = true;
        if (face == null) addFace();
        else face.refresh();
        return START_NOT_STICKY; // jamais relancé sans une action de la personne
    }

    @Override
    public void onDestroy() {
        running = false;
        ui.removeCallbacksAndMessages(null);
        stopRecorder(true);
        hideCancelZone();
        hideCard();
        if (face != null) windows.removeViewImmediate(face);
        face = null;
        network.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private int dp(float value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    private static WindowManager.LayoutParams overlay(int width, int height, int extraFlags) {
        WindowManager.LayoutParams p = new WindowManager.LayoutParams(width, height, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | extraFlags, PixelFormat.TRANSLUCENT);
        p.gravity = Gravity.TOP | Gravity.START;
        return p;
    }

    private int screenWidth() {
        return getResources().getDisplayMetrics().widthPixels;
    }

    private int screenHeight() {
        return getResources().getDisplayMetrics().heightPixels;
    }

    // --- La bulle ------------------------------------------------------------------------------------------------------

    private void addFace() {
        int size = dp(72);
        face = new Face(this, size);
        faceParams = overlay(size, size, WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS);
        faceParams.x = prefs.getInt("x", screenWidth() - size);
        faceParams.y = prefs.getInt("y", screenHeight() / 3);
        windows.addView(face, faceParams);
    }

    @Override
    public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (face != null) settleOnEdge(); // l'écran a tourné : la bulle reste visible
    }

    private void settleOnEdge() {
        int size = face.getWidth() > 0 ? face.getWidth() : dp(72);
        int from = faceParams.x, to = faceParams.x + size / 2 < screenWidth() / 2 ? 0 : screenWidth() - size;
        faceParams.y = Math.max(0, Math.min(faceParams.y, screenHeight() - size));
        ValueAnimator slide = ValueAnimator.ofInt(from, to).setDuration(180);
        slide.addUpdateListener(a -> {
            if (face == null) return;
            faceParams.x = (int) a.getAnimatedValue();
            windows.updateViewLayout(face, faceParams);
        });
        slide.start();
        prefs.edit().putInt("x", to).putInt("y", faceParams.y).apply();
    }

    private void openNoah(String url) {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (url != null) open.putExtra("url", url);
        startActivity(open); // la permission de superposition autorise cette ouverture depuis l'arrière-plan
    }

    private String agentAddress() {
        String agent = prefs.getString("agent", null);
        return agent == null ? null : "/#agent=" + agent;
    }

    /** La vue de la bulle : le visage, un anneau qui suit la voix, et les gestes. */
    private final class Face extends View {
        private final int size;
        private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint skin = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final int slop;
        private Bitmap picture;
        private float level; // 0 à 1 pendant la dictée, -1 : au repos, -2 : envoi en cours
        private float downX, downY;
        private int startX, startY;
        private boolean dragging, holding, pressed;

        private final Runnable beginHold = () -> {
            holding = true;
            performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
            startDictation();
        };

        Face(Context context, int size) {
            super(context);
            this.size = size;
            slop = ViewConfiguration.get(context).getScaledTouchSlop();
            level = -1;
            setContentDescription("Noah : toucher pour ouvrir, maintenir pour dicter");
            refresh();
        }

        void refresh() {
            int color = NoahFace.colorOf(prefs.getString("couleur", null), prefs.getString("agent", null));
            picture = NoahFace.bitmap(getContext(), color, prefs.getString("forme", null), prefs.getString("detail", null), dp(52));
            BitmapShader shader = new BitmapShader(picture, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP);
            Matrix place = new Matrix();
            place.setTranslate(size / 2f - picture.getWidth() / 2f, size / 2f - picture.getHeight() / 2f);
            shader.setLocalMatrix(place);
            skin.setShader(shader);
            invalidate();
        }

        void setLevel(float value) {
            level = value;
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float center = size / 2f, radius = dp(26);
            if (level != -1) {
                boolean sending = level == -2;
                ring.setStyle(Paint.Style.FILL);
                ring.setColor(sending ? 0x554A9DF8 : 0x66FF5A4F);
                canvas.drawCircle(center, center, radius + dp(sending ? 6 : 3 + 7 * Math.max(0, level)), ring);
            }
            ring.setStyle(Paint.Style.FILL);
            ring.setColor(0x33000000);
            canvas.drawCircle(center, center + dp(1), radius + dp(1), ring);
            ring.setColor(0xFFFFFFFF);
            canvas.drawCircle(center, center, radius, ring);
            canvas.drawCircle(center, center, radius, skin); // le visage, sans les coins de son image
        }

        @Override
        public boolean onTouchEvent(MotionEvent e) {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downX = e.getRawX();
                    downY = e.getRawY();
                    startX = faceParams.x;
                    startY = faceParams.y;
                    dragging = holding = false;
                    pressed = true;
                    ui.postDelayed(beginHold, HOLD_MILLIS);
                    return true;
                case MotionEvent.ACTION_MOVE:
                    float dx = e.getRawX() - downX, dy = e.getRawY() - downY;
                    if (holding) {
                        trackCancel(e.getRawY());
                    } else if (dragging || Math.abs(dx) > slop || Math.abs(dy) > slop) {
                        dragging = true;
                        ui.removeCallbacks(beginHold);
                        faceParams.x = startX + Math.round(dx);
                        faceParams.y = startY + Math.round(dy);
                        windows.updateViewLayout(this, faceParams);
                    }
                    return true;
                case MotionEvent.ACTION_UP:
                    ui.removeCallbacks(beginHold);
                    if (holding) finishDictation(overCancel);
                    else if (dragging) settleOnEdge();
                    else if (pressed) {
                        performClick();
                    }
                    pressed = false;
                    return true;
                case MotionEvent.ACTION_CANCEL:
                    ui.removeCallbacks(beginHold);
                    if (holding) finishDictation(true);
                    else if (dragging) settleOnEdge();
                    pressed = false;
                    return true;
                default:
                    return true;
            }
        }

        @Override
        public boolean performClick() {
            super.performClick();
            hideCard();
            openNoah(agentAddress());
            return true;
        }
    }

    // --- La dictée -----------------------------------------------------------------------------------------------------

    private void startDictation() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            showCard("Autorise le micro dans Réglages > Téléphone.", "/", false);
            return;
        }
        if (CallSession.isActive()) {
            showCard("Un appel est en cours : le micro est déjà pris.", agentAddress(), false);
            return;
        }
        generation++;
        hideCard();
        try {
            recording = File.createTempFile("bulle-", ".m4a", getCacheDir());
            recorder = Build.VERSION.SDK_INT >= 31 ? new MediaRecorder(this) : new MediaRecorder();
            recorder.setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioChannels(1);
            recorder.setAudioSamplingRate(16000);
            recorder.setAudioEncodingBitRate(32000);
            recorder.setMaxDuration(LONGEST_MILLIS);
            recorder.setOutputFile(recording.getPath());
            recorder.setOnInfoListener((r, what, extra) -> {
                if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) finishDictation(false);
            });
            recorder.prepare();
            recorder.start();
        } catch (Exception e) {
            Log.w(TAG, "micro indisponible : " + e.getClass().getSimpleName());
            stopRecorder(true);
            showCard("Le micro n'est pas disponible. Une autre app s'en sert peut-être.", agentAddress(), false);
            return;
        }
        recordingSince = System.currentTimeMillis();
        peak = 0;
        silenced = false;
        overCancel = false;
        showCancelZone();
        showCard("Je t'écoute… Relâche pour envoyer.", null, false);
        ui.post(listen);
        if (Build.VERSION.SDK_INT >= 29) ui.postDelayed(checkSilenced, 400);
    }

    /** Ce qu'Android dit vraiment de ce micro : coupé ou pas. C'est la mesure de la restriction sur le micro en arrière-plan. */
    private final Runnable checkSilenced = () -> {
        if (recorder == null || Build.VERSION.SDK_INT < 29) return;
        AudioRecordingConfiguration configuration = recorder.getActiveRecordingConfiguration();
        silenced = configuration != null && configuration.isClientSilenced();
        Log.i(TAG, "micro : silencieux=" + silenced + " android=" + Build.VERSION.SDK_INT);
    };

    private final Runnable listen = new Runnable() {
        @Override
        public void run() {
            if (recorder == null) return;
            int amplitude = 0;
            try {
                amplitude = recorder.getMaxAmplitude();
            } catch (RuntimeException ignored) {
                // arrêté entre-temps
            }
            peak = Math.max(peak, amplitude);
            if (face != null) face.setLevel(Math.min(1f, amplitude / 12000f));
            ui.postDelayed(this, 80);
        }
    };

    private void trackCancel(float rawY) {
        boolean over = rawY > screenHeight() - dp(140);
        if (over == overCancel) return;
        overCancel = over;
        if (over && face != null) face.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
        if (cancelZone != null) {
            ((GradientDrawable) cancelZone.getBackground()).setColor(over ? 0xFFD9403A : 0xE6303338);
            cancelZone.setText(over ? "Relâche pour annuler" : "Glisse ici pour annuler");
        }
    }

    private void finishDictation(boolean cancel) {
        if (recorder == null) return; // le micro n'a pas démarré : sa carte reste affichée
        boolean tooShort = System.currentTimeMillis() - recordingSince < SHORTEST_MILLIS;
        File sound = recording;
        boolean stopped = stopRecorder(cancel || tooShort);
        hideCancelZone();
        hideCard();
        if (face != null) face.setLevel(-1);
        if (cancel) return;
        if (tooShort || !stopped) {
            showCard("Maintiens un peu plus longtemps pour dicter.", null, false);
            return;
        }
        if (silenced) {
            if (sound != null) sound.delete();
            showCard("Android a coupé le micro en arrière-plan. Ouvre Noah, relance la bulle, puis réessaie.", agentAddress(), false);
            return;
        }
        Log.i(TAG, "dictée : " + (sound == null ? 0 : sound.length()) + " octets, pic " + peak);
        if (peak < heardFrom) {
            if (sound != null) sound.delete();
            showCard("Je n'ai rien entendu. Rien n'est parti.", null, false);
            return;
        }
        send(sound);
    }

    /** true si un enregistrement utilisable a été fermé. */
    private boolean stopRecorder(boolean discard) {
        ui.removeCallbacks(listen);
        ui.removeCallbacks(checkSilenced);
        boolean ok = false;
        if (recorder != null) {
            try {
                recorder.stop();
                ok = true;
            } catch (RuntimeException tooShort) {
                ok = false; // arrêté avant le premier échantillon
            }
            recorder.release();
            recorder = null;
        }
        if ((discard || !ok) && recording != null) recording.delete();
        if (discard || !ok) recording = null;
        return ok;
    }

    // --- L'envoi : transcription, message, réponse courte ------------------------------------------------------------------

    private void send(File sound) {
        final long mine = generation;
        if (face != null) face.setLevel(-2);
        showCard("J'écris ce que tu as dit…", null, false);
        network.execute(() -> {
            String answerUrl = agentAddress();
            String shown;
            boolean posting = false;
            try {
                Pairing pairing = new Pairing(this);
                String server = pairing.server(), token = pairing.token();
                if (server == null || token == null) throw new Refused("Cet appareil n'est plus relié à ton serveur.");
                String agent = prefs.getString("agent", "");
                String text = transcribe(server, token, agent, sound);
                if (text.trim().isEmpty()) throw new Refused("Je n'ai rien entendu. Rien n'est parti.");
                showOnUi(mine, "« " + shorten(text, 90) + " »", null);
                JSONObject body = new JSONObject().put("agent_id", agent).put("text", text).put("client_id", "bulle-" + UUID.randomUUID());
                posting = true;
                JSONObject result = post(server + "/api/chat/pendant", token, body);
                String conversation = result.optString("conversation_id");
                if (!conversation.isEmpty()) answerUrl = agentAddress() + "&conversation=" + conversation;
                String reply = result.optString("reponse");
                if (!"tache".equals(result.optString("type")) && !reply.isEmpty()) shown = shorten(reply, 160);
                else shown = follow(mine, server, token, conversation, answerUrl);
            } catch (Refused e) {
                shown = e.getMessage();
            } catch (Exception e) {
                Log.w(TAG, "envoi impossible : " + e.getClass().getSimpleName());
                shown = posting ? "Ton serveur ne répond plus. Regarde la conversation : ton message est peut-être parti." : "Ton serveur ne répond pas. Rien n'est parti.";
            } finally {
                sound.delete();
            }
            final String text = shown, url = answerUrl;
            ui.post(() -> {
                if (mine != generation || face == null) return;
                face.setLevel(-1);
                showCard(text, url, true);
            });
        });
    }

    /** Le temps d'une réponse courte, relevé toutes les 2 s, puis plus rien : au-delà, le serveur notifie la fin. */
    private String follow(long mine, String server, String token, String conversation, String url) throws Exception {
        showOnUi(mine, "Message envoyé. Il y travaille…", url);
        long until = System.currentTimeMillis() + FOLLOW_MILLIS;
        String now = server + "/api/conversations/" + URLEncoder.encode(conversation, "UTF-8") + "/en-cours?suivi=false";
        while (System.currentTimeMillis() < until && mine == generation) {
            Thread.sleep(2000);
            JSONObject state = new JSONObject(request("GET", now, token, null, null, 8000));
            if (state.optBoolean("occupe") || state.optJSONArray("file") != null && state.optJSONArray("file").length() > 0) continue;
            JSONArray messages = new JSONArray(request("GET", server + "/api/conversations/" + URLEncoder.encode(conversation, "UTF-8") + "/messages", token, null, null, 8000));
            JSONObject last = messages.length() == 0 ? null : messages.getJSONObject(messages.length() - 1);
            if (last != null && !"user".equals(last.optString("role"))) return shorten(last.optString("text"), 160);
        }
        return "Il y travaille encore. Tu recevras une notification à la fin.";
    }

    /** Coupure passagère : renvoyé tel quel. Le serveur reconnaît `client_id`, un message renvoyé ne part qu'une fois. */
    private static JSONObject post(String url, String token, JSONObject body) throws Exception {
        for (int attempt = 0; ; attempt++) {
            try {
                return new JSONObject(request("POST", url, token, body.toString().getBytes(StandardCharsets.UTF_8), "application/json", 90_000));
            } catch (Temporary e) {
                if (attempt >= 2) throw e;
                Thread.sleep(2000 * (attempt + 1));
            }
        }
    }

    private String transcribe(String server, String token, String agent, File sound) throws Exception {
        byte[] audio = new byte[(int) sound.length()];
        try (InputStream in = new FileInputStream(sound)) {
            int off = 0;
            for (int n; off < audio.length && (n = in.read(audio, off, audio.length - off)) > 0; ) off += n;
        }
        String url = server + "/api/voice/transcribe?format=m4a&agent_id=" + URLEncoder.encode(agent, "UTF-8");
        for (int attempt = 0; ; attempt++) {
            try {
                return new JSONObject(request("POST", url, token, audio, "application/octet-stream", 90_000)).optString("text");
            } catch (Temporary e) { // comme le navigateur : le son est gardé et renvoyé
                if (attempt >= 2) throw e;
                Thread.sleep(2000 * (attempt + 1));
            }
        }
    }

    private static final class Refused extends Exception {
        Refused(String sentence) {
            super(sentence);
        }
    }

    private static final class Temporary extends Exception {
    }

    /** Le jeton part dans l'en-tête, vers le serveur relié ; il n'est jamais gardé ici ni montré dans une vue. */
    private static String request(String method, String url, String token, byte[] body, String type, int timeout) throws Exception {
        HttpURLConnection http = (HttpURLConnection) new URL(url).openConnection();
        http.setRequestMethod(method);
        http.setRequestProperty("Authorization", "Bearer " + token);
        http.setConnectTimeout(10_000);
        http.setReadTimeout(timeout);
        try {
            if (body != null) {
                http.setDoOutput(true);
                http.setRequestProperty("Content-Type", type);
                try (OutputStream out = http.getOutputStream()) {
                    out.write(body);
                }
            }
            int code;
            try {
                code = http.getResponseCode();
            } catch (java.io.IOException unreachable) {
                throw new Temporary();
            }
            if (code == 401) throw new Refused("Cet appareil n'est plus relié à ton serveur.");
            if (code == 404) throw new Refused("Cet agent n'existe plus. Choisis-en un autre dans Réglages > Téléphone.");
            if (code == 503) throw new Temporary();
            if (code >= 300) throw new Refused(detail(http));
            return read(http.getInputStream());
        } finally {
            http.disconnect();
        }
    }

    private static String detail(HttpURLConnection http) {
        try {
            String sentence = new JSONObject(read(http.getErrorStream())).optString("detail");
            if (!sentence.isEmpty()) return sentence;
        } catch (Exception ignored) {
            // pas de phrase lisible
        }
        return "Ton serveur a refusé ce message.";
    }

    private static String read(InputStream stream) throws Exception {
        try (InputStream in = stream) {
            ByteArrayOutputStream all = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            for (int n; (n = in.read(buf)) > 0; ) all.write(buf, 0, n);
            return all.toString("UTF-8");
        }
    }

    /** Une carte, pas un écran : le début de la réponse, sans code ni mise en forme. Toucher ouvre la suite. */
    static String shorten(String text, int limit) {
        String plain = text.replaceAll("(?s)```.*?(```|$)", " ").replaceAll("MEDIA:\\S+", " ").replaceAll("[*_`#>|]+", " ").replaceAll("\\s+", " ").trim();
        if (plain.isEmpty()) return "C'est fait. Le résultat est dans la conversation.";
        return plain.length() <= limit ? plain : plain.substring(0, limit - 1).trim() + "…";
    }

    // --- Les fenêtres autour de la bulle --------------------------------------------------------------------------------

    private void showCancelZone() {
        hideCancelZone();
        cancelZone = new TextView(this);
        cancelZone.setText("Glisse ici pour annuler");
        cancelZone.setTextColor(Color.WHITE);
        cancelZone.setGravity(Gravity.CENTER);
        cancelZone.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(0xE6303338);
        shape.setCornerRadius(dp(40));
        cancelZone.setBackground(shape);
        WindowManager.LayoutParams p = overlay(dp(260), dp(72), WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE);
        p.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
        p.y = dp(48);
        windows.addView(cancelZone, p);
    }

    private void hideCancelZone() {
        if (cancelZone != null) windows.removeViewImmediate(cancelZone);
        cancelZone = null;
    }

    private void showOnUi(long mine, String text, String url) {
        ui.post(() -> {
            if (mine == generation && face != null) showCard(text, url, false);
        });
    }

    /** `url` : ce que le toucher ouvre. `lasts` : la carte disparaît toute seule (sinon, elle reste le temps de l'action en cours). */
    private void showCard(String text, String url, boolean lasts) {
        ui.removeCallbacks(hideCardLater);
        cardUrl = url;
        if (card == null) {
            card = new TextView(this);
            card.setTextColor(Color.WHITE);
            card.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            card.setPadding(dp(14), dp(10), dp(14), dp(10));
            card.setMaxLines(4);
            GradientDrawable shape = new GradientDrawable();
            shape.setColor(0xF0202429);
            shape.setCornerRadius(dp(14));
            card.setBackground(shape);
            card.setElevation(dp(4));
            card.setOnClickListener(v -> {
                String target = cardUrl;
                hideCard();
                if (target != null) openNoah(target);
            });
            int width = Math.min(dp(300), screenWidth() - dp(24));
            int top = Math.max(dp(12), faceParams.y - dp(96));
            WindowManager.LayoutParams p = overlay(width, WindowManager.LayoutParams.WRAP_CONTENT, 0);
            p.x = faceParams.x + dp(36) < screenWidth() / 2 ? dp(12) : screenWidth() - width - dp(12);
            p.y = faceParams.y < dp(120) ? faceParams.y + dp(76) : top;
            windows.addView(card, p);
        }
        card.setText(text);
        if (lasts || url == null) ui.postDelayed(hideCardLater, CARD_MILLIS);
    }

    private final Runnable hideCardLater = this::hideCard;

    private void hideCard() {
        ui.removeCallbacks(hideCardLater);
        if (card != null) windows.removeViewImmediate(card);
        card = null;
    }
}
