package agent.noah.mobile;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;
import android.view.View;

/**
 * Noah dans sa tuile, à la couleur, la forme et le détail de l'agent : les mêmes tracés que frontend/src/components/Noah.tsx,
 * sur une grille de 64. Une forme ou un détail inconnu (agent plus récent que l'app) retombe sur le visage d'origine.
 */
class NoahFace extends View {

    private static final int INK = Color.parseColor("#2b1611");

    private final int color;
    private final String detail;
    private final Path body;
    private final float top; // haut du corps : où se pose l'antenne
    private final boolean arms;
    private final float shineX, shineY, groundWidth;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path mouth = new Path();
    private final RectF oval = new RectF();

    NoahFace(Context context, int color) {
        this(context, color, null, null);
    }

    NoahFace(Context context, int color, String shape, String detail) {
        super(context);
        this.color = color;
        this.detail = detail == null ? "" : detail;
        body = new Path();
        switch (shape == null ? "" : shape) {
            case "bulle":
                body.addCircle(32, 33, 23, Path.Direction.CW);
                top = 10; arms = false; shineX = 23; shineY = 19; groundWidth = 18;
                break;
            case "cube":
                body.moveTo(23, 11);
                body.lineTo(41, 11);
                body.cubicTo(50, 11, 54, 15, 54, 24);
                body.lineTo(54, 42);
                body.cubicTo(54, 51, 50, 55, 41, 55);
                body.lineTo(23, 55);
                body.cubicTo(14, 55, 10, 51, 10, 42);
                body.lineTo(10, 24);
                body.cubicTo(10, 15, 14, 11, 23, 11);
                body.close();
                top = 11; arms = false; shineX = 22; shineY = 19; groundWidth = 18;
                break;
            case "goutte":
                body.moveTo(32, 11);
                body.cubicTo(34.5f, 21, 55, 27.5f, 55, 41);
                body.cubicTo(55, 50.5f, 45, 56, 32, 56);
                body.cubicTo(19, 56, 9, 50.5f, 9, 41);
                body.cubicTo(9, 27.5f, 29.5f, 21, 32, 11);
                body.close();
                top = 11; arms = false; shineX = 20; shineY = 31; groundWidth = 18;
                break;
            case "pastille":
                body.moveTo(22, 19);
                body.lineTo(42, 19);
                body.cubicTo(51, 19, 58, 26, 58, 37.5f);
                body.cubicTo(58, 49, 51, 56, 42, 56);
                body.lineTo(22, 56);
                body.cubicTo(13, 56, 6, 49, 6, 37.5f);
                body.cubicTo(6, 26, 13, 19, 22, 19);
                body.close();
                top = 19; arms = false; shineX = 21; shineY = 25; groundWidth = 22;
                break;
            default: // gomme, et toute valeur inconnue
                body.moveTo(13, 55);
                body.cubicTo(7.2f, 55, 6, 48.5f, 7.6f, 39.5f);
                body.cubicTo(10, 21, 18.5f, 10, 32, 10);
                body.cubicTo(45.5f, 10, 54, 21, 56.4f, 39.5f);
                body.cubicTo(58, 48.5f, 56.8f, 55, 51, 55);
                body.close();
                top = 10; arms = true; shineX = 24; shineY = 18.5f; groundWidth = 20;
        }
        mouth.moveTo(28.2f, 40);
        mouth.quadTo(32, 44.2f, 35.8f, 40);
        mouth.quadTo(32, 41.5f, 28.2f, 40);
        mouth.close();
    }

    /** La couleur de l'agent, sinon la même couleur stable que l'interface web, tirée de son identifiant. */
    static int colorOf(String chosen, String agentId) {
        try {
            if (chosen != null && !chosen.isEmpty()) return Color.parseColor(chosen);
        } catch (IllegalArgumentException ignored) {
            // valeur inattendue : la couleur stable
        }
        String[] colors = { "#ff7a59", "#f5b82e", "#2fbf8f", "#4a9df8", "#8b6cf0", "#f06292", "#64748b" };
        long h = 0;
        for (char c : (agentId == null ? "" : agentId).toCharArray()) h = (h * 31 + c) & 0xFFFFFFFFL;
        return Color.parseColor(colors[(int) (h % colors.length)]);
    }

    /** Le même visage en image, pour une notification. */
    static Bitmap bitmap(Context context, int color, String shape, String detail, int size) {
        NoahFace face = new NoahFace(context, color, shape, detail);
        face.layout(0, 0, size, size);
        Bitmap image = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        face.draw(new Canvas(image));
        return image;
    }

    private static int shade(int color, float amount) {
        float keep = amount >= 0 ? 1 - amount : 1 + amount;
        int toward = amount >= 0 ? 255 : 0;
        return Color.rgb((int) (Color.red(color) * keep + toward * (1 - keep)), (int) (Color.green(color) * keep + toward * (1 - keep)),
            (int) (Color.blue(color) * keep + toward * (1 - keep)));
    }

    /** Un radialGradient de SVG : centre et rayon en fractions du cadre de ce qu'il remplit, donc elliptique. */
    private static Shader gradient(RectF box, float cx, float cy, float r, int[] colors, float[] stops) {
        RadialGradient g = new RadialGradient(0, 0, 1, colors, stops, Shader.TileMode.CLAMP);
        Matrix place = new Matrix();
        place.setScale(r * box.width(), r * box.height());
        place.postTranslate(box.left + cx * box.width(), box.top + cy * box.height());
        g.setLocalMatrix(place);
        return g;
    }

    private void ellipse(Canvas c, float x, float y, float rx, float ry) {
        oval.set(x - rx, y - ry, x + rx, y + ry);
        c.drawOval(oval, paint);
    }

    /** Un petit bras ou la boule de l'antenne : son dégradé est calé sur lui, comme dans le SVG. */
    private void ball(Canvas c, float x, float y, float r) {
        oval.set(x - r, y - r, x + r, y + r);
        paint.setColor(Color.BLACK); // un dégradé garde l'opacité de la couleur courante
        paint.setShader(gradient(oval, 0.35f, 0.3f, 0.75f, new int[] { shade(color, 0.35f), shade(color, -0.18f) }, new float[] { 0, 1 }));
        c.drawOval(oval, paint);
        paint.setShader(null);
    }

    private void line(Canvas c, float x1, float y1, float x2, float y2) {
        c.drawLine(x1, y1, x2, y2, paint);
    }

    private void stroke(int ink, float width) {
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeCap(Paint.Cap.ROUND);
        paint.setStrokeJoin(Paint.Join.ROUND);
        paint.setStrokeWidth(width);
        paint.setColor(ink);
    }

    @Override
    protected void onDraw(Canvas c) {
        float size = Math.min(getWidth(), getHeight());
        paint.setStyle(Paint.Style.FILL);
        paint.setShader(new LinearGradient(0, 0, size * 0.34f, size, Color.WHITE, shade(color, 0.84f), Shader.TileMode.CLAMP));
        c.drawRoundRect(0, 0, size, size, size * 0.3f, size * 0.3f, paint);
        c.save();
        float unit = size * 0.82f / 64;
        c.translate(size * 0.09f, size * 0.09f + size * 0.82f * 0.04f);
        c.scale(unit, unit);
        paint.setShader(null);
        paint.setColor(Color.argb(30, 0, 0, 0));
        ellipse(c, 32, 57, groundWidth, 2.6f);
        if (detail.equals("antenne")) {
            stroke(shade(color, -0.35f), 1.8f);
            line(c, 32, top + 1.5f, 32, top - 3.4f);
            paint.setStyle(Paint.Style.FILL);
            ball(c, 32, top - 5.6f, 2.7f);
            stroke(shade(color, -0.35f), 0.8f);
            ellipse(c, 32, top - 5.6f, 2.7f, 2.7f);
            paint.setStyle(Paint.Style.FILL);
        }
        if (arms) {
            ball(c, 8.6f, 41.5f, 6.4f);
            ball(c, 56, 35.5f, 6);
        }
        paint.setColor(Color.BLACK); // un dégradé garde l'opacité de la couleur courante : celle de l'ombre rendait le corps transparent
        RectF box = new RectF();
        body.computeBounds(box, true);
        paint.setShader(gradient(box, 0.38f, 0.28f, 0.8f, new int[] { shade(color, 0.45f), color, shade(color, -0.28f) }, new float[] { 0, 0.45f, 1 }));
        c.drawPath(body, paint);
        paint.setShader(null);
        paint.setColor(Color.argb(71, 255, 255, 255));
        c.save();
        c.rotate(-24, shineX, shineY);
        ellipse(c, shineX, shineY, 7, 3.6f);
        c.restore();
        if (detail.equals("joues")) {
            paint.setColor(Color.argb(128, 255, 93, 122));
            ellipse(c, 17.5f, 40.5f, 3.6f, 2.3f);
            ellipse(c, 46.5f, 40.5f, 3.6f, 2.3f);
        }
        paint.setColor(INK);
        ellipse(c, 24.6f, 32, 3.9f, 5.1f);
        ellipse(c, 39.4f, 32, 3.9f, 5.1f);
        paint.setColor(Color.WHITE);
        ellipse(c, 26, 29.8f, 1.35f, 1.35f);
        ellipse(c, 40.8f, 29.8f, 1.35f, 1.35f);
        int lips = Color.parseColor("#6b1d1d");
        paint.setColor(lips);
        c.drawPath(mouth, paint);
        stroke(lips, 1.4f);
        c.drawPath(mouth, paint);
        if (detail.equals("lunettes")) {
            paint.setStyle(Paint.Style.FILL);
            paint.setColor(Color.argb(56, 255, 255, 255));
            ellipse(c, 24.6f, 31.2f, 6.6f, 6.6f);
            ellipse(c, 39.4f, 31.2f, 6.6f, 6.6f);
            stroke(INK, 1.7f);
            ellipse(c, 24.6f, 31.2f, 6.6f, 6.6f);
            ellipse(c, 39.4f, 31.2f, 6.6f, 6.6f);
            line(c, 31.2f, 31.2f, 32.8f, 31.2f);
        } else if (detail.equals("sourcils")) {
            stroke(INK, 2.2f);
            line(c, 21.8f, 25, 28.2f, 22.6f);
            line(c, 35.8f, 22.6f, 42.2f, 25);
        }
        paint.setStyle(Paint.Style.FILL);
        c.restore();
    }
}
