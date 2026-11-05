package android.security.keystore;

import java.security.spec.AlgorithmParameterSpec;
import java.util.Arrays;

/** Simulation : garde ce que le code demande, pour que le test le vérifie. */
public final class KeyGenParameterSpec implements AlgorithmParameterSpec {
    public final String alias;
    public final int purposes;
    public final String[] blockModes;
    public final String[] paddings;
    public final int keySize;

    private KeyGenParameterSpec(Builder b) {
        alias = b.alias;
        purposes = b.purposes;
        blockModes = b.blockModes;
        paddings = b.paddings;
        keySize = b.keySize;
    }

    public static final class Builder {
        private final String alias;
        private final int purposes;
        private String[] blockModes = {};
        private String[] paddings = {};
        private int keySize = -1;

        public Builder(String alias, int purposes) {
            this.alias = alias;
            this.purposes = purposes;
        }

        public Builder setBlockModes(String... modes) {
            blockModes = Arrays.copyOf(modes, modes.length);
            return this;
        }

        public Builder setEncryptionPaddings(String... values) {
            paddings = Arrays.copyOf(values, values.length);
            return this;
        }

        public Builder setKeySize(int size) {
            keySize = size;
            return this;
        }

        public KeyGenParameterSpec build() {
            return new KeyGenParameterSpec(this);
        }
    }
}
