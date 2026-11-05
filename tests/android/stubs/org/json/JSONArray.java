package org.json;

import java.util.ArrayList;
import java.util.List;

public class JSONArray {
    private final List<Object> items = new ArrayList<>();

    public JSONArray() {}

    public JSONArray(String text) {
        items.addAll(((JSONArray) parse(text)).items);
    }

    static Object parse(String text) {
        return new Reader(text).value();
    }

    public JSONArray put(Object value) {
        items.add(value);
        return this;
    }

    public int length() {
        return items.size();
    }

    public JSONObject optJSONObject(int i) {
        Object v = i < items.size() ? items.get(i) : null;
        return v instanceof JSONObject ? (JSONObject) v : null;
    }

    @Override
    public String toString() {
        StringBuilder out = new StringBuilder("[");
        for (Object v : items) {
            if (out.length() > 1) out.append(',');
            out.append(write(v));
        }
        return out.append(']').toString();
    }

    static String write(Object v) {
        return v instanceof String ? quote((String) v) : String.valueOf(v);
    }

    static String quote(String s) {
        return '"' + s.replace("\\", "\\\\").replace("\"", "\\\"") + '"';
    }

    private static final class Reader {
        private final String s;
        private int i;

        Reader(String s) {
            this.s = s;
        }

        Object value() {
            char c = s.charAt(i);
            if (c == '[') {
                JSONArray a = new JSONArray();
                i++;
                while (s.charAt(i) != ']') {
                    a.put(value());
                    if (s.charAt(i) == ',') i++;
                }
                i++;
                return a;
            }
            if (c == '{') {
                JSONObject o = new JSONObject();
                i++;
                while (s.charAt(i) != '}') {
                    String key = (String) value();
                    i++; // :
                    o.put(key, value());
                    if (s.charAt(i) == ',') i++;
                }
                i++;
                return o;
            }
            if (Character.isDigit(c)) {
                int start = i;
                while (Character.isDigit(s.charAt(i)) || s.charAt(i) == '.') i++;
                return s.substring(start, i);
            }
            if (c != '"') throw new IllegalArgumentException("JSON : " + s);
            StringBuilder out = new StringBuilder();
            for (i++; s.charAt(i) != '"'; i++) {
                if (s.charAt(i) == '\\') i++;
                out.append(s.charAt(i));
            }
            i++;
            return out.toString();
        }
    }
}
