package agent.noah.mobile;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;
import android.view.View;

/** Noah dans sa tuile, à la couleur de l'agent : les mêmes formes que frontend/src/components/Noah.tsx, sur une grille de 64. */
class NoahFace extends View {

    private final int color;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path body = new Path();
    private final Path mouth = new Path();
    private final RectF oval = new RectF();

    NoahFace(Context context, int color) {
        super(context);
        this.color = color;
        body.moveTo(13, 55);
        body.cubicTo(7.2f, 55, 6, 48.5f, 7.6f, 39.5f);
        body.cubicTo(10, 21, 18.5f, 10, 32, 10);
        body.cubicTo(45.5f, 10, 54, 21, 56.4f, 39.5f);
        body.cubicTo(58, 48.5f, 56.8f, 55, 51, 55);
        body.close();
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

    private static int shade(int color, float amount) {
        float keep = amount >= 0 ? 1 - amount : 1 + amount;
        int toward = amount >= 0 ? 255 : 0;
        return Color.rgb((int) (Color.red(color) * keep + toward * (1 - keep)), (int) (Color.green(color) * keep + toward * (1 - keep)),
            (int) (Color.blue(color) * keep + toward * (1 - keep)));
    }

    private void circle(Canvas c, float x, float y, float rx, float ry) {
        oval.set(x - rx, y - ry, x + rx, y + ry);
        c.drawOval(oval, paint);
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
        circle(c, 32, 57, 20, 2.6f);
        paint.setShader(new RadialGradient(22, 30, 40, shade(color, 0.35f), shade(color, -0.18f), Shader.TileMode.CLAMP));
        circle(c, 8.6f, 41.5f, 6.4f, 6.4f);
        circle(c, 56, 35.5f, 6, 6);
        paint.setShader(new RadialGradient(24, 22, 48, new int[] { shade(color, 0.45f), color, shade(color, -0.28f) },
            new float[] { 0, 0.45f, 1 }, Shader.TileMode.CLAMP));
        c.drawPath(body, paint);
        paint.setShader(null);
        paint.setColor(Color.argb(71, 255, 255, 255));
        c.save();
        c.rotate(-24, 24, 18.5f);
        circle(c, 24, 18.5f, 7, 3.6f);
        c.restore();
        paint.setColor(Color.parseColor("#2b1611"));
        circle(c, 24.6f, 32, 3.9f, 5.1f);
        circle(c, 39.4f, 32, 3.9f, 5.1f);
        paint.setColor(Color.WHITE);
        circle(c, 26, 29.8f, 1.35f, 1.35f);
        circle(c, 40.8f, 29.8f, 1.35f, 1.35f);
        paint.setColor(Color.parseColor("#6b1d1d"));
        c.drawPath(mouth, paint);
        c.restore();
    }
}
