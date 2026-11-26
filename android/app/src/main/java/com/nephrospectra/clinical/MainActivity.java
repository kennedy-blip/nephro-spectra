package com.nephrospectra.clinical;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.nephrospectra.plugins.NephroAcousticFlowPlugin;
import com.nephrospectra.plugins.NephroDipstickCameraPlugin;

/**
 * NEPHRO-SPECTRA Android host activity.
 *
 * <p>Registers the two native clinical plugins before the Capacitor bridge is
 * created so the WebView can resolve {@code NephroAcousticFlow} and
 * {@code NephroDipstickCamera} on first paint.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NephroAcousticFlowPlugin.class);
        registerPlugin(NephroDipstickCameraPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
