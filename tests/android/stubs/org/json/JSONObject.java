package org.json;

import java.util.LinkedHashMap;
import java.util.Map;

/** Simulation réduite à ce que Pairing utilise : texte, tableaux et objets, écrits puis relus en vrai JSON. */
public class JSONObject {
    final Map<String, Object> values = new LinkedHashMap<>();

    public JSONObject put(String key, Object value) {
        values.put(key, value);
        return this;
    }

    public String optString(String key) {
        return optString(key, "");
    }

    public String optString(String key, String fallback) {
        Object v = values.get(key);
        return v == null ? fallback : v.toString();
    }

    @Override
    public String toString() {
        StringBuilder out = new StringBuilder("{");
        for (Map.Entry<String, Object> e : values.entrySet()) {
            if (out.length() > 1) out.append(',');
            out.append(JSONArray.quote(e.getKey())).append(':').append(JSONArray.write(e.getValue()));
        }
        return out.append('}').toString();
    }
}
