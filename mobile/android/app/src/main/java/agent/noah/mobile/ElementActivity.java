package agent.noah.mobile;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.pdf.PdfRenderer;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.File;

/** Image au pincement et PDF page par page, sans bibliothèque supplémentaire. */
public class ElementActivity extends Activity {
    private PdfRenderer pdf;
    private ParcelFileDescriptor descriptor;
    private int page;
    private ZoomImage image;
    private TextView title;
    private String name;
    private final java.util.concurrent.ExecutorService render = java.util.concurrent.Executors.newSingleThreadExecutor();
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); layout.setBackgroundColor(Color.BLACK);
        LinearLayout bar = new LinearLayout(this);
        Button close = new Button(this); close.setText("✕"); close.setContentDescription("Fermer"); close.setOnClickListener(v -> finish()); bar.addView(close);
        name = getIntent().getStringExtra("name");
        title = new TextView(this); title.setTextColor(Color.WHITE); title.setText(name); bar.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        layout.addView(bar);
        image = new ZoomImage(); image.setContentDescription(name); layout.addView(image, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(layout);
        File file = new File(getIntent().getStringExtra("file"));
        File allowed = new File(getCacheDir(), "elements");
        try { if (!file.getCanonicalPath().startsWith(allowed.getCanonicalPath() + File.separator)) throw new Exception(); }
        catch (Exception e) { finish(); return; }
        LinearLayout actions = new LinearLayout(this);
        for (String action : new String[] { "Partager", "Ouvrir avec", "Enregistrer" }) {
            Button button = new Button(this); button.setText(action);
            button.setOnClickListener(v -> {
                String mime = getIntent().getStringExtra("mime");
                if ("Enregistrer".equals(action)) {
                    render.execute(() -> {
                        try {
                            if (android.os.Build.VERSION.SDK_INT < 29) throw new Exception();
                            android.content.ContentValues values = new android.content.ContentValues();
                            values.put(android.provider.MediaStore.Downloads.DISPLAY_NAME, file.getName().replaceFirst("^[a-f0-9-]{36}-", ""));
                            values.put(android.provider.MediaStore.Downloads.MIME_TYPE, mime);
                            android.net.Uri target = getContentResolver().insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                            if (target == null) throw new Exception();
                            try (java.io.InputStream in = new java.io.FileInputStream(file); java.io.OutputStream out = getContentResolver().openOutputStream(target)) { byte[] buffer = new byte[16384]; for (int n; (n = in.read(buffer)) > 0;) out.write(buffer, 0, n); }
                            runOnUiThread(() -> android.widget.Toast.makeText(this, "Fichier enregistré", android.widget.Toast.LENGTH_SHORT).show());
                        } catch (Exception e) { runOnUiThread(() -> android.widget.Toast.makeText(this, "Enregistrement impossible", android.widget.Toast.LENGTH_LONG).show()); }
                    });
                    return;
                }
                android.net.Uri uri = androidx.core.content.FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", file);
                android.content.Intent intent = "Partager".equals(action) ? new android.content.Intent(android.content.Intent.ACTION_SEND).setType(mime).putExtra(android.content.Intent.EXTRA_STREAM, uri) : new android.content.Intent(android.content.Intent.ACTION_VIEW).setDataAndType(uri, mime);
                intent.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION); intent.setClipData(android.content.ClipData.newRawUri(name, uri));
                try { startActivity(android.content.Intent.createChooser(intent, action)); } catch (android.content.ActivityNotFoundException e) { android.widget.Toast.makeText(this, "Aucune application ne peut ouvrir ce fichier", android.widget.Toast.LENGTH_LONG).show(); }
            });
            actions.addView(button, new LinearLayout.LayoutParams(0, -2, 1));
        }
        layout.addView(actions);
        if (getIntent().getBooleanExtra("pdf", false)) {
            try { descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY); pdf = new PdfRenderer(descriptor); }
            catch (Exception e) { title.setText("PDF illisible. Utilise Ouvrir avec."); return; }
            LinearLayout pages = new LinearLayout(this);
            Button previous = new Button(this); previous.setText("←"); previous.setContentDescription("Page précédente"); previous.setOnClickListener(v -> { if (page > 0) { page--; showPage(); } });
            Button next = new Button(this); next.setText("→"); next.setContentDescription("Page suivante"); next.setOnClickListener(v -> { if (page + 1 < pdf.getPageCount()) { page++; showPage(); } });
            pages.addView(previous); pages.addView(next); layout.addView(pages); showPage();
        } else render.execute(() -> {
            BitmapFactory.Options bounds = new BitmapFactory.Options(); bounds.inJustDecodeBounds = true; BitmapFactory.decodeFile(file.getPath(), bounds);
            BitmapFactory.Options options = new BitmapFactory.Options(); options.inSampleSize = Math.max(1, Math.max(bounds.outWidth, bounds.outHeight) / 2048);
            Bitmap bitmap = BitmapFactory.decodeFile(file.getPath(), options);
            runOnUiThread(() -> { if (!isFinishing()) { if (bitmap == null) title.setText("Image illisible. Utilise Ouvrir avec."); else image.show(bitmap); } });
        });
    }
    private void showPage() {
        final int wanted = page;
        title.setText(name + " · " + (wanted + 1) + " / " + pdf.getPageCount());
        render.execute(() -> {
            try (PdfRenderer.Page p = pdf.openPage(wanted)) {
                int width = Math.min(2048, getResources().getDisplayMetrics().widthPixels * 2);
                int height = Math.min(4096, Math.max(1, (int) ((long) width * p.getHeight() / Math.max(1, p.getWidth()))));
                Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888); bitmap.eraseColor(Color.WHITE);
                p.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                runOnUiThread(() -> { if (!isFinishing() && page == wanted) image.show(bitmap); else bitmap.recycle(); });
            } catch (Exception e) { runOnUiThread(() -> title.setText("Page illisible")); }
        });
    }
    @Override protected void onDestroy() {
        render.execute(() -> { if (pdf != null) pdf.close(); try { if (descriptor != null) descriptor.close(); } catch (Exception ignored) {} });
        render.shutdown(); super.onDestroy();
    }
    private final class ZoomImage extends View {
        Bitmap bitmap;
        float scale = 1, dx, dy, startX, startY, downY;
        final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        final ScaleGestureDetector detector;
        ZoomImage() { super(ElementActivity.this); detector = new ScaleGestureDetector(ElementActivity.this, new ScaleGestureDetector.SimpleOnScaleGestureListener() {
            @Override public boolean onScale(ScaleGestureDetector d) { scale = Math.max(1, Math.min(6, scale * d.getScaleFactor())); invalidate(); return true; }
        }); }
        void show(Bitmap next) { if (bitmap != null && bitmap != next) bitmap.recycle(); bitmap = next; scale = 1; dx = dy = 0; invalidate(); }
        @Override protected void onDraw(Canvas canvas) {
            if (bitmap == null) return;
            float fit = Math.min((float) getWidth() / bitmap.getWidth(), (float) getHeight() / bitmap.getHeight());
            canvas.save(); canvas.translate(getWidth() / 2f + dx, getHeight() / 2f + dy); canvas.scale(fit * scale, fit * scale); canvas.drawBitmap(bitmap, -bitmap.getWidth() / 2f, -bitmap.getHeight() / 2f, paint); canvas.restore();
        }
        @Override public boolean onTouchEvent(MotionEvent e) {
            detector.onTouchEvent(e);
            if (e.getActionMasked() == MotionEvent.ACTION_DOWN) { startX = e.getX(); startY = downY = e.getY(); }
            if (e.getActionMasked() == MotionEvent.ACTION_MOVE && e.getPointerCount() == 1 && scale > 1) { dx += e.getX() - startX; dy += e.getY() - startY; startX = e.getX(); startY = e.getY(); invalidate(); }
            if (e.getActionMasked() == MotionEvent.ACTION_UP) { if (scale == 1 && e.getY() - downY > 150) finish(); performClick(); }
            return true;
        }
        @Override public boolean performClick() { super.performClick(); return true; }
    }
}
