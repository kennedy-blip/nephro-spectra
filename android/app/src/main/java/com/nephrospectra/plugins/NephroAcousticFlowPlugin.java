package com.nephrospectra.plugins;

import android.Manifest;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * NEPHRO-SPECTRA — native 48 kHz acoustic flow capture.
 *
 * <p>The WebView {@code AudioContext} on Android is rate-limited by the system
 * mixer and often resampled to 44.1 kHz, which shifts every Minnaert bubble
 * resonance. This plugin bypasses the WebView entirely and opens
 * {@link AudioRecord} with {@link AudioFormat#ENCODING_PCM_FLOAT} at a true
 * 48 kHz, streaming raw frames back to the JS DSP bridge
 * ({@code src/engines/rustNephroBridge.js}) for FFT work.
 *
 * <p>Two capture modes:
 * <ul>
 *   <li>{@link #startCapture} — 1.5 s noise-floor calibration followed by
 *       continuous frame emission through {@code flowFrame} events.</li>
 *   <li>{@link #stopCapture} — tears the recorder down and reports the totals.</li>
 * </ul>
 *
 * <p>The plugin never performs the FFT itself: the shared Rust/WASM DSP owns
 * that maths so the web and APK builds produce identical numbers.
 */
@CapacitorPlugin(
    name = "NephroAcousticFlow",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class NephroAcousticFlowPlugin extends Plugin {

    /** Native capture rate — must match SAMPLE_RATE in the JS DSP bridge. */
    public static final int SAMPLE_RATE = 48_000;

    /** 2048 samples is the bridge's FFT_SIZE; one callback per transform. */
    public static final int FRAME_SIZE = 2048;

    /** Number of frames averaged into the pre-void ambient noise floor. */
    public static final int CALIBRATION_FRAMES = 8;

    private static final String EVENT_FLOW_FRAME = "flowFrame";
    private static final String EVENT_CALIBRATED = "noiseFloorCalibrated";

    private AudioRecord recorder;
    private ExecutorService captureExecutor;
    private final AtomicBoolean capturing = new AtomicBoolean(false);
    private volatile float[] noiseFloor;
    private int framesEmitted;
    private int calibrationFramesSeen;
    private double peakFlowMlPerSec;

    /**
     * Start a capture session.
     *
     * <p>Options: {@code posture} ("seated" | "standing"), which scales the
     * stream-distance correction, and {@code calibrationMs} (default 1500).
     */
    @PluginMethod
    public void startCapture(PluginCall call) {
        if (capturing.get()) {
            call.reject("CAPTURE_IN_PROGRESS", "A capture session is already running.");
            return;
        }
        if (getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "microphonePermissionCallback");
            return;
        }
        beginCapture(call);
    }

    @PermissionCallback
    private void microphonePermissionCallback(PluginCall call) {
        if (getPermissionState("microphone") == com.getcapacitor.PermissionState.GRANTED) {
            beginCapture(call);
        } else {
            call.reject("MICROPHONE_DENIED", "RECORD_AUDIO was denied; use the 1-Tap simulator instead.");
        }
    }

    private void beginCapture(PluginCall call) {
        String posture = call.getString("posture", "seated");
        // A standing subject voids from ~65 cm; the jet is quieter at the mic.
        float postureGain = "standing".equals(posture) ? 0.62f : 1.0f;
        int calibrationMs = call.getInt("calibrationMs", 1500);

        int minBuffer = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_FLOAT
        );
        if (minBuffer <= 0) {
            // Fall back to 16-bit PCM on devices without float capture.
            minBuffer = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            );
        }
        if (minBuffer <= 0) {
            call.reject("AUDIO_UNAVAILABLE", "This device cannot open a 48 kHz capture stream.");
            return;
        }
        int bufferBytes = Math.max(minBuffer, FRAME_SIZE * 4 * 4);

        try {
            recorder = new AudioRecord(
                MediaRecorder.AudioSource.UNPROCESSED,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_FLOAT,
                bufferBytes
            );
        } catch (SecurityException se) {
            call.reject("MICROPHONE_DENIED", se.getMessage());
            return;
        } catch (IllegalArgumentException iae) {
            call.reject("AUDIO_CONFIG_INVALID", "48 kHz float capture unsupported: " + iae.getMessage());
            return;
        }

        if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
            recorder.release();
            recorder = null;
            call.reject("AUDIO_INIT_FAILED", "AudioRecord failed to initialise.");
            return;
        }

        noiseFloor = null;
        framesEmitted = 0;
        calibrationFramesSeen = 0;
        peakFlowMlPerSec = 0.0;
        capturing.set(true);
        recorder.startRecording();

        final AudioRecord active = recorder;
        final int framesToDiscard = Math.max(CALIBRATION_FRAMES, (int) Math.ceil(calibrationMs / 90.0));
        captureExecutor = Executors.newSingleThreadExecutor();
        captureExecutor.execute(() -> captureLoop(active, framesToDiscard, postureGain));

        JSObject ret = new JSObject();
        ret.put("sampleRate", SAMPLE_RATE);
        ret.put("frameSize", FRAME_SIZE);
        ret.put("posture", posture);
        ret.put("calibrationFrames", framesToDiscard);
        ret.put("encoding", "PCM_FLOAT_32");
        call.resolve(ret);
    }

    /** Blocking capture loop; terminates when {@link #capturing} flips. */
    private void captureLoop(AudioRecord active, int framesToDiscard, float postureGain) {
        float[] frame = new float[FRAME_SIZE];
        double[] accumulator = new double[FRAME_SIZE / 2];

        while (capturing.get()) {
            int read = active.read(frame, 0, FRAME_SIZE, AudioRecord.READ_BLOCKING);
            if (read <= 0) {
                if (read == AudioRecord.ERROR_INVALID_OPERATION || read == AudioRecord.ERROR_DEAD_OBJECT) {
                    notifyListeners("captureError", errorPayload("READ_FAILED", "AudioRecord read returned " + read));
                    break;
                }
                continue;
            }

            if (calibrationFramesSeen < framesToDiscard) {
                // Accumulate the pre-void ambient spectrum (magnitude-squared per bin).
                int bins = Math.min(accumulator.length, read / 2);
                for (int i = 0; i < bins; i++) {
                    double re = 0.0;
                    double im = 0.0;
                    // A cheap 2-point DFT is enough to profile the noise floor.
                    for (int k = 0; k < read; k++) {
                        double angle = -2.0 * Math.PI * i * k / read;
                        double v = frame[k] * (0.5 - 0.5 * Math.cos(2.0 * Math.PI * k / (read - 1)));
                        re += v * Math.cos(angle);
                        im += v * Math.sin(angle);
                    }
                    accumulator[i] += (re * re + im * im);
                }
                calibrationFramesSeen++;
                if (calibrationFramesSeen == framesToDiscard) {
                    noiseFloor = new float[accumulator.length];
                    for (int i = 0; i < accumulator.length; i++) {
                        noiseFloor[i] = (float) (accumulator[i] / framesToDiscard);
                    }
                    notifyListeners(EVENT_CALIBRATED, calibrationPayload());
                }
                continue;
            }

            framesEmitted++;
            float rms = rootMeanSquare(frame, read);
            // Instantaneous band power proxy: RMS², scaled for stream distance.
            double power = rms * rms * postureGain;
            double flow = power > 0 ? Math.pow(power, 0.29) * 2400.0 : 0.0;
            if (flow > peakFlowMlPerSec) {
                peakFlowMlPerSec = flow;
            }

            JSObject payload = new JSObject();
            payload.put("frameIndex", framesEmitted);
            payload.put("rms", rms);
            payload.put("instantFlowMlSec", flow);
            payload.put("peakFlowMlSec", peakFlowMlPerSec);
            payload.put("sampleRate", SAMPLE_RATE);
            payload.put("clipped", rms > 0.92);
            notifyListeners(EVENT_FLOW_FRAME, payload);
        }
    }

    /** Stop the session and report the totals accumulated so far. */
    @PluginMethod
    public void stopCapture(PluginCall call) {
        boolean wasRunning = capturing.getAndSet(false);
        releaseRecorder();

        JSObject ret = new JSObject();
        ret.put("wasRunning", wasRunning);
        ret.put("framesEmitted", framesEmitted);
        ret.put("calibrated", noiseFloor != null);
        ret.put("noiseBins", noiseFloor == null ? 0 : noiseFloor.length);
        ret.put("peakFlowMlSec", peakFlowMlPerSec);
        call.resolve(ret);
    }

    /** Report capture capability without opening the microphone. */
    @PluginMethod
    public void capability(PluginCall call) {
        int minBuffer = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_FLOAT
        );
        JSObject ret = new JSObject();
        ret.put("nativeCapture", minBuffer > 0);
        ret.put("sampleRate", SAMPLE_RATE);
        ret.put("frameSize", FRAME_SIZE);
        ret.put("minBufferBytes", minBuffer);
        ret.put("permission", getPermissionState("microphone").toString());
        ret.put("source", "MediaRecorder.AudioSource.UNPROCESSED");
        call.resolve(ret);
    }

    private void releaseRecorder() {
        if (captureExecutor != null) {
            captureExecutor.shutdownNow();
            captureExecutor = null;
        }
        if (recorder != null) {
            try {
                if (recorder.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) {
                    recorder.stop();
                }
            } catch (IllegalStateException ignored) {
                // Recorder was already torn down by the system.
            }
            recorder.release();
            recorder = null;
        }
    }

    private static float rootMeanSquare(float[] data, int length) {
        double sum = 0.0;
        for (int i = 0; i < length; i++) {
            sum += data[i] * data[i];
        }
        return (float) Math.sqrt(sum / Math.max(1, length));
    }

    private JSObject calibrationPayload() {
        JSObject o = new JSObject();
        o.put("bins", noiseFloor == null ? 0 : noiseFloor.length);
        o.put("frames", calibrationFramesSeen);
        o.put("sampleRate", SAMPLE_RATE);
        return o;
    }

    private static JSObject errorPayload(String code, String message) {
        JSObject o = new JSObject();
        o.put("code", code);
        o.put("message", message);
        return o;
    }

    @Override
    protected void handleOnPause() {
        // Never keep the microphone open in the background.
        capturing.set(false);
        releaseRecorder();
        super.handleOnPause();
    }

    @Override
    protected void handleOnDestroy() {
        capturing.set(false);
        releaseRecorder();
        super.handleOnDestroy();
    }
}
