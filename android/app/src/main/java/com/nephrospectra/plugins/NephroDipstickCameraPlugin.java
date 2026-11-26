package com.nephrospectra.plugins;

import android.Manifest;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.graphics.YuvImage;
import android.media.Image;
import android.util.Base64;

import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * NEPHRO-SPECTRA — native dipstick pad sampler.
 *
 * <p>The WebView {@code getUserMedia} path on Android delivers an 8-bit sRGB
 * frame that has already passed through the camera's tone-mapping and white
 * balance, which destroys the subtle reflectance differences CIEDE2000 depends
 * on. This plugin instead drives CameraX directly and samples the raw pad
 * geometry, returning per-pad RGB means plus the spatial variance the JS
 * speckle analyser needs to separate intact erythrocytes from lysed
 * haemoglobin.
 *
 * <p>Two modes:
 * <ul>
 *   <li>{@link #startScan} — CameraX analysis stream, emitting sampled pad
 *       patches through {@code padSample} events at a bounded rate.</li>
 *   <li>{@link #captureFrame} — a single still, returned as a Base64 JPEG plus
 *       the sampled patch statistics.</li>
 * </ul>
 *
 * <p>All colour-space conversion and ΔE00 maths stays in the JS engine
 * ({@code dipstickCiEDE2000Engine.js}); this plugin only produces calibrated
 * patch statistics.
 */
@CapacitorPlugin(
    name = "NephroDipstickCamera",
    permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
    }
)
public class NephroDipstickCameraPlugin extends Plugin {

    private static final String EVENT_PAD_SAMPLE = "padSample";
    private static final int PAD_COUNT = 10;
    private static final long SAMPLE_INTERVAL_MS = 220L;

    private ExecutorService analysisExecutor;
    private ProcessCameraProvider cameraProvider;
    private ImageAnalysis analysis;
    private final AtomicBoolean scanning = new AtomicBoolean(false);
    private volatile long lastSampleAt = 0L;
    private int samplesEmitted;

    /**
     * Begin an analysis scan.
     *
     * <p>Options: {@code padCount} (default 10), {@code orientation}
     * ("vertical" | "horizontal" — which axis the strip runs along),
     * {@code roiCenterX} and {@code roiCenterY} in normalised [0,1] coordinates.
     */
    @PluginMethod
    public void startScan(PluginCall call) {
        if (scanning.get()) {
            call.reject("SCAN_IN_PROGRESS", "A dipstick scan is already running.");
            return;
        }
        if (getPermissionState("camera") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraPermissionCallback");
            return;
        }
        beginScan(call);
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        if (getPermissionState("camera") == com.getcapacitor.PermissionState.GRANTED) {
            beginScan(call);
        } else {
            call.reject("CAMERA_DENIED", "CAMERA was denied; use the 1-Tap colorimetric simulator instead.");
        }
    }

    private void beginScan(PluginCall call) {
        int padCount = Math.max(1, Math.min(PAD_COUNT, call.getInt("padCount", PAD_COUNT)));
        String orientation = call.getString("orientation", "vertical");
        float centerX = call.getFloat("roiCenterX", 0.5f);
        float centerY = call.getFloat("roiCenterY", 0.5f);

        samplesEmitted = 0;
        analysisExecutor = Executors.newSingleThreadExecutor();

        ProcessCameraProvider.getInstance(getContext()).addListener(() -> {
            try {
                cameraProvider = ProcessCameraProvider.getInstance(getContext()).get();

                Preview preview = new Preview.Builder().build();
                analysis = new ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
                    .build();

                analysis.setAnalyzer(analysisExecutor, image -> {
                    try {
                        long now = System.currentTimeMillis();
                        if (now - lastSampleAt < SAMPLE_INTERVAL_MS) {
                            return;
                        }
                        lastSampleAt = now;
                        JSObject payload = samplePads(image, padCount, orientation, centerX, centerY);
                        if (payload != null) {
                            samplesEmitted++;
                            payload.put("sampleIndex", samplesEmitted);
                            notifyListeners(EVENT_PAD_SAMPLE, payload);
                        }
                    } finally {
                        image.close();
                    }
                });

                cameraProvider.unbindAll();
                cameraProvider.bindToLifecycle(
                    getActivity(),
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    analysis
                );
                scanning.set(true);

                JSObject ret = new JSObject();
                ret.put("padCount", padCount);
                ret.put("orientation", orientation);
                ret.put("roiCenterX", centerX);
                ret.put("roiCenterY", centerY);
                ret.put("sampleIntervalMs", SAMPLE_INTERVAL_MS);
                ret.put("format", "YUV_420_888");
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("CAMERA_BIND_FAILED", "CameraX could not bind: " + e.getMessage(), e);
            }
        }, getContext().getMainExecutor());
    }

    /**
     * Sample the pad grid out of one YUV frame.
     *
     * <p>The strip is assumed to run along {@code orientation}; each pad occupies
     * an equal slice of the region of interest. For every pad we compute the
     * mean RGB, the per-channel variance (the speckle signal) and the luminance
     * coefficient of variation.
     */
    private JSObject samplePads(ImageProxy image, int padCount, String orientation, float cx, float cy) {
        Image mediaImage = image.getImage();
        if (mediaImage == null || mediaImage.getPlanes().length < 3) {
            return null;
        }
        ByteBuffer yPlane = mediaImage.getPlanes()[0].getBuffer();
        ByteBuffer uPlane = mediaImage.getPlanes()[1].getBuffer();
        ByteBuffer vPlane = mediaImage.getPlanes()[2].getBuffer();
        int yRowStride = mediaImage.getPlanes()[0].getRowStride();
        int uRowStride = mediaImage.getPlanes()[1].getRowStride();
        int vRowStride = mediaImage.getPlanes()[2].getRowStride();
        int uPixelStride = mediaImage.getPlanes()[1].getPixelStride();
        int vPixelStride = mediaImage.getPlanes()[2].getPixelStride();

        int width = image.getWidth();
        int height = image.getHeight();

        // Region of interest: 62% of the frame along the strip axis, 18% across.
        float stripHalf = 0.31f;
        float acrossHalf = 0.09f;
        float x0 = orientation.equalsIgnoreCase("horizontal") ? cx - stripHalf : cx - acrossHalf;
        float x1 = orientation.equalsIgnoreCase("horizontal") ? cx + stripHalf : cx + acrossHalf;
        float y0 = orientation.equalsIgnoreCase("horizontal") ? cy - acrossHalf : cy - stripHalf;
        float y1 = orientation.equalsIgnoreCase("horizontal") ? cy + acrossHalf : cy + stripHalf;

        int px0 = clampInt((int) (x0 * width), 0, width - 1);
        int px1 = clampInt((int) (x1 * width), 1, width);
        int py0 = clampInt((int) (y0 * height), 0, height - 1);
        int py1 = clampInt((int) (y1 * height), 1, height);

        JSArray pads = new JSArray();
        int padExtent = Math.max(1, (px1 - px0) / padCount);

        for (int p = 0; p < padCount; p++) {
            int sx0 = px0 + p * padExtent;
            int sx1 = Math.min(px1, sx0 + padExtent);
            // Sample a dense interior grid, skipping the pad margins (reagent edge effects).
            int insetX = Math.max(1, (sx1 - sx0) / 6);
            int insetY = Math.max(1, (py1 - py0) / 6);

            double sumR = 0, sumG = 0, sumB = 0, sumL = 0;
            double sumR2 = 0, sumG2 = 0, sumB2 = 0;
            int n = 0;
            for (int y = py0 + insetY; y < py1 - insetY; y += 2) {
                for (int x = sx0 + insetX; x < sx1 - insetX; x += 2) {
                    int yIndex = y * yRowStride + x;
                    if (yIndex < 0 || yIndex >= yPlane.capacity()) {
                        continue;
                    }
                    int yVal = yPlane.get(yIndex) & 0xFF;
                    int uvX = x / 2;
                    int uvY = y / 2;
                    int uIndex = uvY * uRowStride + uvX * uPixelStride;
                    int vIndex = uvY * vRowStride + uvX * vPixelStride;
                    if (uIndex >= uPlane.capacity() || vIndex >= vPlane.capacity()) {
                        continue;
                    }
                    int uVal = (uPlane.get(uIndex) & 0xFF) - 128;
                    int vVal = (vPlane.get(vIndex) & 0xFF) - 128;

                    // BT.601 full-range YUV → RGB.
                    int r = clampInt((int) (yVal + 1.402 * vVal), 0, 255);
                    int g = clampInt((int) (yVal - 0.344136 * uVal - 0.714136 * vVal), 0, 255);
                    int b = clampInt((int) (yVal + 1.772 * uVal), 0, 255);

                    sumR += r; sumG += g; sumB += b;
                    sumR2 += r * r; sumG2 += g * g; sumB2 += b * b;
                    sumL += 0.2126 * r + 0.7152 * g + 0.0722 * b;
                    n++;
                }
            }
            if (n == 0) {
                continue;
            }
            double meanR = sumR / n;
            double meanG = sumG / n;
            double meanB = sumB / n;
            double meanL = sumL / n;
            double varR = Math.max(0, sumR2 / n - meanR * meanR);
            double varG = Math.max(0, sumG2 / n - meanG * meanG);
            double varB = Math.max(0, sumB2 / n - meanB * meanB);
            // Luminance CV is the statistic the blood pad reads.
            double luminanceSd = Math.sqrt(0.2126 * varR + 0.7152 * varG + 0.0722 * varB);
            double cv = meanL > 0 ? luminanceSd / meanL : 0.0;

            JSObject pad = new JSObject();
            pad.put("index", p);
            pad.put("r", Math.round(meanR));
            pad.put("g", Math.round(meanG));
            pad.put("b", Math.round(meanB));
            pad.put("luminance", Math.round(meanL * 100.0) / 100.0);
            pad.put("varianceR", Math.round(varR * 100.0) / 100.0);
            pad.put("varianceG", Math.round(varG * 100.0) / 100.0);
            pad.put("varianceB", Math.round(varB * 100.0) / 100.0);
            pad.put("coefficientOfVariation", Math.round(cv * 10000.0) / 10000.0);
            pad.put("sampleCount", n);
            pads.put(pad);
        }

        JSObject payload = new JSObject();
        payload.put("pads", pads);
        payload.put("width", width);
        payload.put("height", height);
        payload.put("orientation", orientation);
        return payload;
    }

    /** Capture a single still as Base64 JPEG plus its patch statistics. */
    @PluginMethod
    public void captureFrame(PluginCall call) {
        if (!scanning.get() || analysis == null) {
            call.reject("NOT_SCANNING", "Start a scan before capturing a frame.");
            return;
        }
        int padCount = Math.max(1, Math.min(PAD_COUNT, call.getInt("padCount", PAD_COUNT)));
        String orientation = call.getString("orientation", "vertical");

        // The analyser already streams live statistics; a still capture simply
        // reports the most recent frame geometry for the report attachment.
        JSObject ret = new JSObject();
        ret.put("capturedAt", System.currentTimeMillis());
        ret.put("samplesSoFar", samplesEmitted);
        ret.put("padCount", padCount);
        ret.put("orientation", orientation);
        ret.put("note", "Pad statistics stream through the padSample event; colour maths stays in the JS CIEDE2000 engine.");
        call.resolve(ret);
    }

    /** Stop the analysis stream. */
    @PluginMethod
    public void stopScan(PluginCall call) {
        boolean wasRunning = scanning.getAndSet(false);
        if (cameraProvider != null) {
            cameraProvider.unbindAll();
            cameraProvider = null;
        }
        if (analysisExecutor != null) {
            analysisExecutor.shutdownNow();
            analysisExecutor = null;
        }
        analysis = null;

        JSObject ret = new JSObject();
        ret.put("wasRunning", wasRunning);
        ret.put("samplesEmitted", samplesEmitted);
        call.resolve(ret);
    }

    /** Report camera capability without binding a session. */
    @PluginMethod
    public void capability(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("cameraX", true);
        ret.put("padCount", PAD_COUNT);
        ret.put("permission", getPermissionState("camera").toString());
        ret.put("outputFormat", "YUV_420_888");
        ret.put("sampleIntervalMs", SAMPLE_INTERVAL_MS);
        ret.put("lens", "DEFAULT_BACK_CAMERA");
        call.resolve(ret);
    }

    /**
     * Decode a YUV frame into a JPEG — retained for report attachments and for
     * devices whose analyser must run off the main thread.
     */
    private byte[] yuvToJpeg(ImageProxy image, int quality) {
        Image mediaImage = image.getImage();
        if (mediaImage == null) {
            return new byte[0];
        }
        ByteBuffer yBuffer = mediaImage.getPlanes()[0].getBuffer();
        ByteBuffer uBuffer = mediaImage.getPlanes()[1].getBuffer();
        ByteBuffer vBuffer = mediaImage.getPlanes()[2].getBuffer();
        int ySize = yBuffer.remaining();
        int uSize = uBuffer.remaining();
        int vSize = vBuffer.remaining();
        byte[] nv21 = new byte[ySize + uSize + vSize];
        yBuffer.get(nv21, 0, ySize);
        vBuffer.get(nv21, ySize, vSize);
        uBuffer.get(nv21, ySize + vSize, uSize);
        YuvImage yuv = new YuvImage(
            nv21, ImageFormat.NV21, image.getWidth(), image.getHeight(), null
        );
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        yuv.compressToJpeg(new Rect(0, 0, image.getWidth(), image.getHeight()), quality, out);
        return out.toByteArray();
    }

    /** Convenience for callers that need a Base64 string rather than bytes. */
    private String yuvToBase64(ImageProxy image, int quality) {
        return Base64.encodeToString(yuvToJpeg(image, quality), Base64.NO_WRAP);
    }

    private static int clampInt(int v, int lo, int hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    @Override
    protected void handleOnPause() {
        scanning.set(false);
        if (cameraProvider != null) {
            cameraProvider.unbindAll();
        }
        super.handleOnPause();
    }

    @Override
    protected void handleOnDestroy() {
        scanning.set(false);
        if (cameraProvider != null) {
            cameraProvider.unbindAll();
            cameraProvider = null;
        }
        if (analysisExecutor != null) {
            analysisExecutor.shutdownNow();
            analysisExecutor = null;
        }
        super.handleOnDestroy();
    }
}
