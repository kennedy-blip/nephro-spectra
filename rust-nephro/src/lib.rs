//! NEPHRO-SPECTRA — Rust acoustic sonouroflowmetry core.
//!
//! Compiled to `wasm32-unknown-unknown` via wasm-bindgen and loaded by
//! `src/engines/rustNephroBridge.js`. A byte-identical deterministic JS mirror
//! is used on Vercel so builds never require a cargo toolchain.
//!
//! Layout:
//!   * `fft`            — in-place iterative radix-2 Cooley–Tukey FFT
//!   * `hann`           — periodic Hann analysis window
//!   * `power_spectrum` — one-sided PSD (Pa²/Hz) with window energy normalisation
//!   * `welch_psd`      — averaged PSD over overlapping frames
//!   * `jet_power`      — band-limited spectral subtraction (550–6200 Hz)
//!   * `flow_from_power`— non-linear acoustic → volumetric transfer function
//!   * `minnaert`       — bubble resonance frequency / inverse radius
//!   * `siroky_norm`    — Siroky flow nomogram quantiles
//!   * `classify_morphology` — 5-pattern uroflow geometry classifier

#![forbid(unsafe_code)]

pub mod sonouroflow_dsp;
pub mod tiselius_hovorka_rk4;

use sonouroflow_dsp::*;

/// Fixed analysis parameters shared with the JS mirror.
pub const SAMPLE_RATE: f64 = 48_000.0;
pub const FFT_SIZE: usize = 2048;
pub const BAND_LO_HZ: f64 = 550.0;
pub const BAND_HI_HZ: f64 = 6200.0;
pub const GAMMA_JET: f64 = 0.58;

/// Aggregate result returned across the WASM boundary for one acoustic frame.
#[derive(Debug, Clone, Copy, Default)]
pub struct FrameResult {
    pub jet_power: f64,
    pub flow_ml_s: f64,
    pub centroid_hz: f64,
    pub bubble_radius_um: f64,
    pub dominant_hz: f64,
    pub snr_db: f64,
}

/// Analyse one frame end-to-end: window → FFT → PSD → subtraction → flow.
pub fn analyse_frame(frame: &[f64], noise_floor: &[f64], k_cal: f64) -> FrameResult {
    let n = frame.len().min(FFT_SIZE);
    if n < 32 || frame.len() < n {
        return FrameResult::default();
    }
    let psd = power_spectrum(&frame[..n], SAMPLE_RATE);
    let df = SAMPLE_RATE / n as f64;
    let p = jet_power(&psd, df, noise_floor, BAND_LO_HZ, BAND_HI_HZ);
    let centroid = spectral_centroid(&psd, df);
    let dominant = dominant_frequency(&psd, df, BAND_LO_HZ, BAND_HI_HZ);
    let snr = band_snr_db(&psd, df, noise_floor, BAND_LO_HZ, BAND_HI_HZ);
    FrameResult {
        jet_power: p,
        flow_ml_s: flow_from_power(p, k_cal, GAMMA_JET),
        centroid_hz: centroid,
        // minnaert_radius_um already returns micrometres
        bubble_radius_um: minnaert_radius_um(centroid),
        dominant_hz: dominant,
        snr_db: snr,
    }
}

/// Convenience: peak flow from a whole recording.
pub fn peak_flow(signal: &[f64], frame: usize, noise_floor: &[f64], k_cal: f64) -> f64 {
    let hop = frame / 2;
    let mut qmax: f64 = 0.0;
    let mut start = 0usize;
    while start + frame <= signal.len() {
        let r = analyse_frame(&signal[start..start + frame], noise_floor, k_cal);
        if r.flow_ml_s > qmax {
            qmax = r.flow_ml_s;
        }
        start += hop;
    }
    qmax
}

/// Build a baseline spectral noise floor by averaging `frames` frames.
pub fn estimate_noise_floor(signal: &[f64], frames: usize) -> Vec<f64> {
    let bins = FFT_SIZE / 2;
    let mut acc = vec![0.0f64; bins];
    let mut count = 0usize;
    for f in 0..frames {
        let start = f * FFT_SIZE;
        if start + FFT_SIZE > signal.len() {
            break;
        }
        let psd = power_spectrum(&signal[start..start + FFT_SIZE], SAMPLE_RATE);
        for (a, v) in acc.iter_mut().zip(psd.iter()) {
            *a += *v;
        }
        count += 1;
    }
    if count > 0 {
        for a in acc.iter_mut() {
            *a /= count as f64;
        }
    }
    acc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fft_impulse_has_flat_spectrum() {
        let mut re = vec![0.0f64; 8];
        let mut im = vec![0.0f64; 8];
        re[0] = 1.0;
        fft_in_place(&mut re, &mut im);
        for v in re.iter() {
            assert!((v - 1.0).abs() < 1e-12);
        }
    }

    #[test]
    fn sine_peak_lands_on_expected_bin() {
        let n = 1024;
        let f = 1500.0;
        let sig: Vec<f64> = (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * f * i as f64 / SAMPLE_RATE).sin())
            .collect();
        let psd = power_spectrum(&sig, SAMPLE_RATE);
        let df = SAMPLE_RATE / n as f64;
        let dom = dominant_frequency(&psd, df, 100.0, 6000.0);
        assert!((dom - f).abs() < 3.0 * df, "dominant={dom} expected≈{f}");
    }

    #[test]
    fn minnaert_roundtrip() {
        // Both helpers speak micrometres; 4200 Hz is a ≈781.7 µm bubble.
        let f = 4200.0;
        let r_um = minnaert_radius_um(f);
        assert!((r_um - 781.72).abs() < 0.5, "r_um={r_um}");
        let back = minnaert_frequency_hz(r_um);
        assert!((back - f).abs() < 1e-6 * f, "back={back}");
        // and the metre-space helpers agree with the micrometre ones
        assert!((minnaert_frequency_hz_m(r_um * 1e-6) - f).abs() < 1e-6 * f);
    }

    #[test]
    fn siroky_reference_value() {
        // Siroky: 30*(1-exp(-400/230)) ≈ 24.7 mL/s
        let m = siroky_mean(400.0, 1.0);
        assert!((m - 24.75).abs() < 0.2, "mean={m}");
    }

    #[test]
    fn stricture_is_classified_as_plateau() {
        let m = MorphFeatures {
            q_max: 11.0,
            q_avg: 9.6,
            t_qmax: 5.0,
            t_flow: 26.0,
            plateau_ratio: 0.87,
            skewness: 0.1,
            kurtosis: -1.1,
            interruptions: 0,
            acceleration: 2.2,
            female: false,
        };
        assert_eq!(classify_morphology(&m), 2);
    }

    #[test]
    fn normal_bell_is_index_zero() {
        let m = MorphFeatures {
            q_max: 23.0,
            q_avg: 11.0,
            t_qmax: 6.0,
            t_flow: 30.0,
            plateau_ratio: 0.48,
            skewness: 0.35,
            kurtosis: -0.2,
            interruptions: 0,
            acceleration: 3.8,
            female: false,
        };
        assert_eq!(classify_morphology(&m), 0);
    }
}
