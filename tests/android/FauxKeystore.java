package agent.noah.mobile;

import android.security.keystore.KeyGenParameterSpec;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.Key;
import java.security.KeyStore;
import java.security.KeyStoreSpi;
import java.security.Provider;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.spec.AlgorithmParameterSpec;
import java.util.Collections;
import java.util.Date;
import java.util.Enumeration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import javax.crypto.KeyGeneratorSpi;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;

/**
 * Simulation du fournisseur « AndroidKeyStore » : mêmes noms, même règle (générer sur un alias existant remplace la clé).
 * La clé reste une clé logicielle ici : ce test prouve ce que le code demande et ce qu'il écrit, pas le matériel du
 * téléphone.
 */
public final class FauxKeystore extends Provider {
    static final Map<String, SecretKey> KEYS = new ConcurrentHashMap<>();
    static final AtomicInteger GENERATED = new AtomicInteger();
    static volatile KeyGenParameterSpec lastSpec;

    public FauxKeystore() {
        super("AndroidKeyStore", "1.0", "simulation pour les tests");
        put("KeyStore.AndroidKeyStore", Store.class.getName());
        put("KeyGenerator.AES", Generator.class.getName());
    }

    public static final class Generator extends KeyGeneratorSpi {
        private KeyGenParameterSpec spec;

        @Override
        protected void engineInit(SecureRandom random) {
            throw new IllegalStateException("le Keystore Android exige un KeyGenParameterSpec");
        }

        @Override
        protected void engineInit(AlgorithmParameterSpec params, SecureRandom random) {
            spec = (KeyGenParameterSpec) params;
        }

        @Override
        protected void engineInit(int size, SecureRandom random) {
            throw new IllegalStateException("le Keystore Android exige un KeyGenParameterSpec");
        }

        @Override
        protected SecretKey engineGenerateKey() {
            byte[] raw = new byte[spec.keySize / 8];
            new SecureRandom().nextBytes(raw);
            try {
                Thread.sleep(40); // une génération dans le Keystore prend ce temps-là ou plus : la course est réaliste
            } catch (InterruptedException e) {
                throw new IllegalStateException(e);
            }
            SecretKey key = new SecretKeySpec(raw, "AES");
            KEYS.put(spec.alias, key);
            lastSpec = spec;
            GENERATED.incrementAndGet();
            return key;
        }
    }

    public static final class Store extends KeyStoreSpi {
        @Override
        public Key engineGetKey(String alias, char[] password) {
            return KEYS.get(alias);
        }

        @Override
        public KeyStore.Entry engineGetEntry(String alias, KeyStore.ProtectionParameter protection) {
            SecretKey key = KEYS.get(alias);
            return key == null ? null : new KeyStore.SecretKeyEntry(key);
        }

        @Override
        public Certificate[] engineGetCertificateChain(String alias) {
            return null;
        }

        @Override
        public Certificate engineGetCertificate(String alias) {
            return null;
        }

        @Override
        public Date engineGetCreationDate(String alias) {
            return null;
        }

        @Override
        public void engineSetKeyEntry(String alias, Key key, char[] password, Certificate[] chain) {
            throw new UnsupportedOperationException();
        }

        @Override
        public void engineSetKeyEntry(String alias, byte[] key, Certificate[] chain) {
            throw new UnsupportedOperationException();
        }

        @Override
        public void engineSetCertificateEntry(String alias, Certificate cert) {
            throw new UnsupportedOperationException();
        }

        @Override
        public void engineDeleteEntry(String alias) {
            KEYS.remove(alias);
        }

        @Override
        public Enumeration<String> engineAliases() {
            return Collections.enumeration(KEYS.keySet());
        }

        @Override
        public boolean engineContainsAlias(String alias) {
            return KEYS.containsKey(alias);
        }

        @Override
        public int engineSize() {
            return KEYS.size();
        }

        @Override
        public boolean engineIsKeyEntry(String alias) {
            return KEYS.containsKey(alias);
        }

        @Override
        public boolean engineIsCertificateEntry(String alias) {
            return false;
        }

        @Override
        public String engineGetCertificateAlias(Certificate cert) {
            return null;
        }

        @Override
        public void engineStore(OutputStream stream, char[] password) {
            throw new UnsupportedOperationException();
        }

        @Override
        public void engineLoad(InputStream stream, char[] password) {}

        @Override
        public void engineLoad(KeyStore.LoadStoreParameter param) {}
    }
}
