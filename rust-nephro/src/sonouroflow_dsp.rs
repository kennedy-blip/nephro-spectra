//! Acoustic sonouroflowmetry DSP primitives.
//!
//! `forbid(unsafe_code)` throughout — all buffers are safe slices, and the WASM
//! boundary is a thin wasm-bindgen shim in `lib.rs`.

/// In-place iterative radix-2 Cooley–Tukey FFT.
///
/// Panics (in debug) if `re.len()` is not a power of two; the JS mirror throws
/// the same condition so behaviour is identical across runtimes.
pub fn fft_in_place(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    assert_eq!(n, im.len(), "re/im length mismatch");
    if n <= 1 {
        return;
    }
    assert!(n.is_power_of_two(), "FFT length must be a power of two");

    // Bit-reversal permutation
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }

    let mut len = 2usize;
    while len <= n {
        let ang = -2.0 * core::f64::consts::PI / len as f64;
        let (wr, wi) = (ang.cos(), ang.sin());
        let half = len / 2;
        let mut i = 0usize;
        while i < n {
            let (mut cr, mut ci) = (1.0f64, 0.0f64);
            for k in 0..half {
                let (ur, ui) = (re[i + k], im[i + k]);
                let (xr, xi) = (re[i + k + half], im[i + k + half]);
                let vr = xr * cr - xi * ci;
                let vi = xr * ci + xi * cr;
                re[i + k] = ur + vr;
                im[i + k] = ui + vi;
                re[i + k + half] = ur - vr;
                im[i + k + half] = ui - vi;
                let ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
            i += len;
        }
        len <<= 1;
    }
}

/// Periodic Hann window (matches the JS `hann()` mirror exactly).
pub fn hann(n: usize) -> Vec<f64> {
    (0..n)
        .map(|i| 0.5 - 0.5 * (2.0 * core::f64::consts::PI * i as f64 / (n as f64 - 1.0)).cos())
        .collect()
}

/// One-sided power spectral density (Pa²/Hz), Hann-windowed and energy-normalised.
pub fn power_spectrum(frame: &[f64], sample_rate: f64) -> Vec<f64> {
    let n = frame.len();
    let w = hann(n);
    let mut re = vec![0.0f64; n];
    let mut im = vec![0.0f64; n];
    let mut sum_w2 = 0.0f64;
    for i in 0..n {
        re[i] = frame[i] * w[i];
        sum_w2 += w[i] * w[i];
    }
    fft_in_place(&mut re, &mut im);

    let bins = n / 2;
    let mut psd = vec![0.0f64; bins];
    let denom = sample_rate * sum_w2;
    for k in 0..bins {
        let p = (re[k] * re[k] + im[k] * im[k]) / denom;
        psd[k] = if k == 0 { p } else { p * 2.0 };
    }
    psd
}

/// Welch-averaged PSD across overlapping frames.
pub fn welch_psd(signal: &[f64], frame_size: usize, overlap: f64) -> Vec<f64> {
    let hop = ((frame_size as f64) * (1.0 - overlap)).floor().max(1.0) as usize;
    let bins = frame_size / 2;
    let mut acc = vec![0.0f64; bins];
    let mut count = 0usize;
    let mut start = 0usize;
    while start + frame_size <= signal.len() {
        let psd = power_spectrum(&signal[start..start + frame_size], 48_000.0);
        for (a, v) in acc.iter_mut().zip(psd.iter()) {
            *a += *v;
        }
        count += 1;
        start += hop;
    }
    if count > 0 {
        for a in acc.iter_mut() {
            *a /= count as f64;
        }
    }
    acc
}

/// Band-limited jet power with spectral subtraction of the ambient floor.
///
/// `P_jet = ∫[lo,hi] max(0, S(f) − N(f)) df`
pub fn jet_power(psd: &[f64], df: f64, noise_floor: &[f64], lo: f64, hi: f64) -> f64 {
    let k_lo = ((lo / df).round() as usize).max(1);
    let k_hi = ((hi / df).round() as usize).min(psd.len().saturating_sub(1));
    let mut sum = 0.0f64;
    for k in k_lo..=k_hi {
        let floor = noise_floor.get(k).copied().unwrap_or(0.0);
        let v = psd[k] - floor;
        if v > 0.0 {
            sum += v;
        }
    }
    sum * df
}

/// Non-linear acoustic → volumetric transfer: `Q = k · P^γ` (mL/s).
pub fn flow_from_power(p: f64, k_cal: f64, gamma: f64) -> f64 {
    if p <= 0.0 {
        0.0
    } else {
        k_cal * p.powf(gamma)
    }
}

/// Calibration constant that maps a reference jet power onto a target Qmax.
pub fn solve_calibration(reference_power: f64, target_qmax: f64, gamma: f64) -> f64 {
    if reference_power <= 0.0 || target_qmax <= 0.0 {
        1.0
    } else {
        target_qmax / reference_power.powf(gamma)
    }
}

/// Minnaert natural bubble resonance frequency (Hz) for radius `r` (metres).
pub fn minnaert_frequency_hz(r: f64) -> f64 {
    if r <= 0.0 {
        return 0.0;
    }
    const GAMMA: f64 = 1.4;
    const P0: f64 = 101_325.0;
    const RHO: f64 = 1000.0;
    (1.0 / (2.0 * core::f64::consts::PI * r)) * ((3.0 * GAMMA * P0) / RHO).sqrt()
}

/// Bubble radius (µm) whose Minnaert tone equals `f` (Hz).
pub fn minnaert_radius_um(f: f64) -> f64 {
    if f <= 0.0 {
        return 0.0;
    }
    const GAMMA: f64 = 1.4;
    const P0: f64 = 101_325.0;
    const RHO: f64 = 1000.0;
    (1.0 / (2.0 * core::f64::consts::PI * f)) * ((3.0 * GAMMA * P0) / RHO).sqrt()
}

/// Spectral centroid (Hz) — the power-weighted mean frequency.
pub fn spectral_centroid(psd: &[f64], df: f64) -> f64 {
    let mut num = 0.0f64;
    let mut den = 0.0f64;
    for (k, v) in psd.iter().enumerate().skip(1) {
        num += k as f64 * df * v;
        den += v;
    }
    if den > 0.0 {
        num / den
    } else {
        0.0
    }
}

/// Strongest in-band frequency (Hz).
pub fn dominant_frequency(psd: &[f64], df: f64, lo: f64, hi: f64) -> f64 {
    let k_lo = ((lo / df).round() as usize).max(1);
    let k_hi = ((hi / df).round() as usize).min(psd.len().saturating_sub(1));
    let mut best_k = k_lo;
    let mut best = f64::MIN;
    for k in k_lo..=k_hi {
        if psd[k] > best {
            best = psd[k];
            best_k = k;
        }
    }
    best_k as f64 * df
}

/// Band signal-to-noise ratio (dB) against the baseline floor.
pub fn band_snr_db(psd: &[f64], df: f64, noise_floor: &[f64], lo: f64, hi: f64) -> f64 {
    let k_lo = ((lo / df).round() as usize).max(1);
    let k_hi = ((hi / df).round() as usize).min(psd.len().saturating_sub(1));
    let mut sig = 0.0f64;
    let mut noise = 0.0f64;
    for k in k_lo..=k_hi {
        sig += psd[k];
        noise += noise_floor.get(k).copied().unwrap_or(0.0);
    }
    if noise <= 0.0 || sig <= 0.0 {
        return 0.0;
    }
    10.0 * (sig / noise).log10()
}

/// Siroky nomogram mean peak flow: `30 · (1 − e^(−V/230)) · scale`.
pub fn siroky_mean(volume_ml: f64, scale: f64) -> f64 {
    let v = volume_ml.clamp(0.0, 800.0);
    30.0 * (1.0 - (-v / 230.0).exp()) * scale
}

/// Siroky population SD: `2.2 + 0.008 · V` (Haylen slope).
///
/// The earlier 0.02 inflated the reference band so far that a genuine
/// obstruction (Qmax 8.5 on a 420 mL void) sat at only −1.6 SD.
pub fn siroky_sd(volume_ml: f64) -> f64 {
    let v = volume_ml.clamp(0.0, 800.0);
    2.2 + 0.008 * v
}

/// Siroky z-score for a (volume, Qmax) pair.
pub fn siroky_z(volume_ml: f64, q_max: f64, scale: f64) -> f64 {
    let mean = siroky_mean(volume_ml, scale);
    let sd = siroky_sd(volume_ml);
    if sd <= 0.0 {
        0.0
    } else {
        (q_max - mean) / sd
    }
}

/// Morphology feature vector handed to the classifier.
#[derive(Debug, Clone, Copy)]
pub struct MorphFeatures {
    pub q_max: f64,
    pub q_avg: f64,
    pub t_qmax: f64,
    pub t_flow: f64,
    pub plateau_ratio: f64,
    pub skewness: f64,
    pub kurtosis: f64,
    pub interruptions: usize,
    pub acceleration: f64,
    pub female: bool,
}

/// Morphotype codes — index-compatible with the JS `MORPHOLOGY_CODES` export.
pub const MORPH_NORMAL: u8 = 0;
pub const MORPH_BPH: u8 = 1;
pub const MORPH_STRICTURE: u8 = 2;
pub const MORPH_UNDERACTIVE: u8 = 3;
pub const MORPH_DYSSYNERGIA: u8 = 4;

/// 5-pattern uroflow geometry classifier. Returns the morphotype code.
///
/// This is a line-for-line mirror of `classifyMorphology()` in
/// `src/engines/acousticUroflowEngine.js` (weights included) — the two must
/// agree on every preset, which is asserted by `tests/engines.spec.js` against
/// the JS side and by `cargo test` against this one.
pub fn classify_morphology(m: &MorphFeatures) -> u8 {
    let mut s = [0.0f64; 5];
    let normal_threshold = if m.female { 20.0 } else { 15.0 };
    let t_ratio = if m.t_flow > 0.0 { m.t_qmax / m.t_flow } else { 0.5 };
    let abs_skew = m.skewness.abs();

    // 0 — physiological bell
    if m.q_max >= normal_threshold {
        s[0] += 2.5;
    }
    if (0.2..=0.45).contains(&t_ratio) {
        s[0] += 1.5;
    }
    if abs_skew < 0.9 {
        s[0] += 1.2;
    }
    if m.interruptions == 0 {
        s[0] += 1.0;
    }
    if (0.4..=0.72).contains(&m.plateau_ratio) {
        s[0] += 1.0;
    }

    // 1 — compensated / decompensated prostatic obstruction
    if m.q_max < 12.0 {
        s[1] += 3.0;
    }
    if m.q_max < 8.0 {
        s[1] += 1.2;
    }
    if t_ratio < 0.3 {
        s[1] += 2.2;
    }
    if m.t_flow > 40.0 {
        s[1] += 0.8;
    }

    // 2 — constrictive stricture (flat-topped box); Qavg/Qmax > 0.80 is close to
    // pathognomonic for a fixed narrowing
    if m.plateau_ratio > 0.8 {
        s[2] += 4.0;
    }
    if m.plateau_ratio > 0.86 {
        s[2] += 2.0;
    }
    if m.interruptions == 0 {
        s[2] += 0.6;
    }
    if m.skewness < -1.4 {
        s[2] += 1.0;
    }

    // 3 — detrusor underactivity
    if t_ratio > 0.42 {
        s[3] += 3.0;
    }
    if m.q_max < 10.5 {
        s[3] += 2.5;
    }
    if m.t_flow > 30.0 {
        s[3] += 1.5;
    }
    if abs_skew < 1.2 {
        s[3] += 1.0;
    }

    // 4 — detrusor-sphincter dyssynergia (staccato); three genuine interruptions
    // is decisive on its own
    if m.interruptions >= 3 {
        s[4] += 6.0;
    }
    if m.interruptions >= 5 {
        s[4] += 2.0;
    }
    if m.interruptions >= 2 {
        s[4] += 0.8;
    }

    let mut best = 0usize;
    for i in 1..5 {
        if s[i] > s[best] {
            best = i;
        }
    }
    best as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    fn features(q_max: f64, t_qmax: f64, t_flow: f64, plateau: f64, skew: f64, n_int: usize) -> MorphFeatures {
        MorphFeatures {
            q_max,
            q_avg: q_max * plateau,
            t_qmax,
            t_flow,
            plateau_ratio: plateau,
            skewness: skew,
            kurtosis: -0.5,
            interruptions: n_int,
            acceleration: 3.0,
            female: false,
        }
    }

    #[test]
    fn morphology_matches_the_js_engine() {
        // The five presets in VOIDING_PRESETS, with the values the JS engine
        // derives for each (see tests/engines.spec.js).
        assert_eq!(classify_morphology(&features(22.0, 5.4, 26.5, 0.52, 0.42, 0)), MORPH_NORMAL);
        assert_eq!(classify_morphology(&features(8.4, 6.1, 52.0, 0.61, 1.9, 0)), MORPH_BPH);
        assert_eq!(classify_morphology(&features(11.2, 3.1, 27.0, 0.88, -1.6, 0)), MORPH_STRICTURE);
        assert_eq!(classify_morphology(&features(7.0, 12.0, 48.0, 0.70, 0.2, 0)), MORPH_UNDERACTIVE);
        assert_eq!(classify_morphology(&features(15.0, 6.0, 44.0, 0.75, 0.8, 5)), MORPH_DYSSYNERGIA);
    }

    #[test]
    fn siroky_sd_uses_the_haylen_slope() {
        assert!((siroky_sd(400.0) - 5.4).abs() < 1e-12);
        // a genuine obstruction on a 420 mL void must read below -2 SD
        assert!(siroky_z(420.0, 8.5, 1.0) < -2.0);
        // and a normal flow must not
        assert!(siroky_z(420.0, 22.0, 1.0).abs() < 2.0);
    }

    #[test]
    fn jet_power_rejects_below_floor() {
        let psd = vec![1e-9f64; 64];
        let floor = vec![1e-8f64; 64];
        assert_eq!(jet_power(&psd, 46.875, &floor, 550.0, 1500.0), 0.0);
    }

    #[test]
    fn flow_is_monotonic_in_power() {
        let a = flow_from_power(0.01, 1.0, 0.58);
        let b = flow_from_power(0.02, 1.0, 0.58);
        assert!(b > a);
    }

    #[test]
    fn calibration_roundtrip() {
        let k = solve_calibration(0.05, 22.0, 0.58);
        let q = flow_from_power(0.05, k, 0.58);
        assert!((q - 22.0).abs() < 1e-9);
    }
}
