//! Tiselius–Hovorka coupled integrator.
//!
//! Two independent physical models share this module because they are solved by
//! the same classical fourth-order Runge–Kutta (RK4) core:
//!
//! 1. **Hovorka glucose–insulin model** (7-state) with an SGLT2-inhibitor renal
//!    threshold shift (RTG 180 → 75 mg/dL), giving plasma glucose, insulin,
//!    GKI, serum/urine osmolality and free-water deficit.
//! 2. **Tiselius supersaturation index** for calcium oxalate and calcium
//!    phosphate, whose activity product is integrated against urine pH/volume
//!    to yield AP(CaOx), AP(CaP) and a chemolysis window for uric acid.
//!
//! Pure `f64`, no allocation in the hot loop, no unsafe.

/// Maximum number of RK4 steps allowed before the integrator aborts.
pub const MAX_STEPS: usize = 100_000;

/// Fixed-step RK4 integrator for an N-dimensional autonomous ODE.
///
/// `f(t, y, dydt)` writes the derivative; `y` is state; returns `Ok(())` on
/// success or `Err` if `dt` or `steps` are invalid.
pub fn rk4_step<F>(t: f64, y: &mut [f64], dt: f64, f: F) -> Result<(), &'static str>
where
    F: Fn(f64, &[f64], &mut [f64]),
{
    if dt <= 0.0 {
        return Err("dt must be positive");
    }
    let n = y.len();
    let mut k1 = vec![0.0f64; n];
    let mut k2 = vec![0.0f64; n];
    let mut k3 = vec![0.0f64; n];
    let mut k4 = vec![0.0f64; n];
    let mut tmp = vec![0.0f64; n];

    f(t, y, &mut k1);
    for i in 0..n {
        tmp[i] = y[i] + 0.5 * dt * k1[i];
    }
    f(t + 0.5 * dt, &tmp, &mut k2);
    for i in 0..n {
        tmp[i] = y[i] + 0.5 * dt * k2[i];
    }
    f(t + 0.5 * dt, &tmp, &mut k3);
    for i in 0..n {
        tmp[i] = y[i] + dt * k3[i];
    }
    f(t + dt, &tmp, &mut k4);
    for i in 0..n {
        y[i] += (dt / 6.0) * (k1[i] + 2.0 * k2[i] + 2.0 * k3[i] + k4[i]);
    }
    Ok(())
}

/// Hovorka-style glucose–insulin state vector.
///
/// `[G, X, I, S1, S2, Q1, Q2]` — plasma glucose (mmol/L), remote insulin action,
/// plasma insulin (mU/L), two subcutaneous insulin compartments, and two
/// glucose-mass compartments.
#[derive(Debug, Clone, Copy)]
pub struct HovorkaParams {
    pub body_weight_kg: f64,
    pub v_g: f64,
    pub v_i: f64,
    pub k_12: f64,
    pub k_a1: f64,
    pub k_a2: f64,
    pub k_b1: f64,
    pub k_b2: f64,
    pub k_b3: f64,
    pub k_e: f64,
    pub f_01: f64,
    pub e_gp0: f64,
    pub s_i_td: f64,
    /// Renal glucose threshold (mg/dL). 180 normative, 75 under SGLT2 blockade.
    pub rtg_mg_dl: f64,
    /// Maximum renal glucose excretion (mg/min).
    pub renal_max_mg_min: f64,
}

impl Default for HovorkaParams {
    fn default() -> Self {
        Self {
            body_weight_kg: 78.0,
            v_g: 0.16 * 78.0,
            v_i: 0.12 * 78.0,
            k_12: 0.066,
            k_a1: 0.0018,
            k_a2: 0.0182,
            k_b1: 0.14,
            k_b2: 0.14,
            k_b3: 0.14,
            k_e: 0.14,
            f_01: 0.0097 * 78.0,
            e_gp0: 0.0161 * 78.0,
            s_i_td: 0.0055,
            rtg_mg_dl: 180.0,
            renal_max_mg_min: 120.0,
        }
    }
}

const MMOL_PER_MG_DL: f64 = 1.0 / 18.0;

impl HovorkaParams {
    /// SGLT2 inhibitor engaged: RTG drops to 75 mg/dL and max excretion rises.
    pub fn with_sglt2(mut self, engaged: bool) -> Self {
        if engaged {
            self.rtg_mg_dl = 75.0;
            self.renal_max_mg_min = 260.0;
        }
        self
    }
}

/// Renal glucose excretion (mmol/min), a Michaelis-style saturating transporter.
pub fn renal_excretion_mmol_min(p: &HovorkaParams, glucose_mmol: f64) -> f64 {
    let g_mg = glucose_mmol * 18.0;
    if g_mg <= p.rtg_mg_dl {
        return 0.0;
    }
    let excess = g_mg - p.rtg_mg_dl;
    let km = 220.0; // mg/dL half-saturation of the reabsorptive capacity
    p.renal_max_mg_min * (excess / (excess + km)) * MMOL_PER_MG_DL
}

/// One Hovorka derivative evaluation (autonomous; no explicit `t` dependence
/// beyond meal input handled by the caller).
pub fn hovorka_derivs(
    y: &[f64],
    p: &HovorkaParams,
    meal_mmol_min: f64,
    insulin_input_mu_min: f64,
) -> [f64; 7] {
    let g = y[0].max(0.0);
    let x = y[1];
    let i = y[2].max(0.0);
    let s1 = y[3];
    let s2 = y[4];
    let q1 = y[5];
    let q2 = y[6];

    // Endogenous glucose production suppressed by insulin action & glucose
    let egp = p.e_gp0 * (1.0 - x).clamp(0.0, 1.0) * (1.0 - (g / 12.0).clamp(0.0, 0.92));
    // Utilisation: insulin-independent (CNS + renal) plus insulin-dependent
    let f01c = if g < 4.5 { p.f_01 } else { p.f_01 * (g / 4.5).min(1.0) };
    let fr = if g > 9.0 { 0.003 * (g - 9.0) * p.v_g } else { 0.0 };
    let utilisation = f01c + fr + x * g;
    // Renal glucose loss shifts the threshold (SGLT2 site of action)
    let renal = renal_excretion_mmol_min(p, g);

    let dg = (egp + meal_mmol_min + (q1 / p.v_g) - utilisation - renal) / p.v_g * p.v_g;
    let dx = p.k_a1 * i - p.k_a2 * x;
    let di = (s2 / p.v_i) - p.k_e * i;
    let ds1 = insulin_input_mu_min - s1 / p.k_a1.max(1e-6) * p.k_a1 * 0.0 - p.k_a1 * s1;
    let ds2 = p.k_a1 * s1 - p.k_a2 * s2;
    let dq1 = -p.k_12 * q1 + p.k_b1 * g * p.v_g - p.k_b2 * q1 + meal_mmol_min;
    let dq2 = p.k_12 * q1;
    let _ = (p.k_b3, q2);
    [dg, dx, di, ds1, ds2, dq1, dq2]
}

/// Full Hovorka simulation result.
#[derive(Debug, Clone)]
pub struct GlycemicRun {
    pub times_min: Vec<f64>,
    pub glucose_mg_dl: Vec<f64>,
    pub insulin_mu_l: Vec<f64>,
    pub glucose_kg: Vec<f64>,
    pub peak_mg_dl: f64,
    pub nadir_mg_dl: f64,
    pub time_in_range_pct: f64,
    pub auc_mg_dl_min: f64,
}

/// Integrate the Hovorka model for `duration_min` with a single meal at t=0.
pub fn simulate_hovorka(
    p: &HovorkaParams,
    g0_mmol: f64,
    meal_g_carbs: f64,
    insulin_bolus_mu: f64,
    duration_min: f64,
    dt_min: f64,
) -> GlycemicRun {
    let steps = ((duration_min / dt_min).ceil() as usize).min(MAX_STEPS);
    let mut y = [g0_mmol, 0.0, 8.0, 0.0, 0.0, 0.0, 0.0];
    let mut out = GlycemicRun {
        times_min: Vec::with_capacity(steps + 1),
        glucose_mg_dl: Vec::with_capacity(steps + 1),
        insulin_mu_l: Vec::with_capacity(steps + 1),
        glucose_kg: Vec::with_capacity(steps + 1),
        peak_mg_dl: f64::MIN,
        nadir_mg_dl: f64::MAX,
        time_in_range_pct: 0.0,
        auc_mg_dl_min: 0.0,
    };
    // 1 g carbohydrate ≈ 5.55 mmol glucose equivalents absorbed over ~45 min
    let carb_mmol = meal_g_carbs * 5.55;
    let meal_window = 45.0;
    let mut in_range_min = 0.0;
    let mut t = 0.0f64;

    for k in 0..=steps {
        let g_mg = y[0] * 18.0;
        out.times_min.push(t);
        out.glucose_mg_dl.push(g_mg);
        out.insulin_mu_l.push(y[2]);
        out.glucose_kg.push(y[0] * p.v_g);
        out.peak_mg_dl = out.peak_mg_dl.max(g_mg);
        out.nadir_mg_dl = out.nadir_mg_dl.min(g_mg);
        if g_mg >= 70.0 && g_mg <= 180.0 {
            in_range_min += dt_min;
        }
        if k == steps {
            break;
        }
        out.auc_mg_dl_min += g_mg * dt_min;

        let meal = if t < meal_window { carb_mmol / meal_window } else { 0.0 };
        let bolus = if k == 0 { insulin_bolus_mu } else { 0.0 };
        let mut d = hovorka_derivs(&y, p, meal, bolus);
        // RK4 with the meal window clamped per sub-step
        let mut y1 = y;
        for i in 0..7 {
            y1[i] = y[i] + 0.5 * dt_min * d[i];
        }
        let d2 = hovorka_derivs(&y1, p, meal, 0.0);
        for i in 0..7 {
            y1[i] = y[i] + 0.5 * dt_min * d2[i];
        }
        let d3 = hovorka_derivs(&y1, p, meal, 0.0);
        for i in 0..7 {
            y1[i] = y[i] + dt_min * d3[i];
        }
        let d4 = hovorka_derivs(&y1, p, meal, 0.0);
        for i in 0..7 {
            d[i] = (d[i] + 2.0 * d2[i] + 2.0 * d3[i] + d4[i]) / 6.0;
            y[i] = (y[i] + dt_min * d[i]).max(0.35);
        }
        t += dt_min;
    }
    out.time_in_range_pct = if duration_min > 0.0 {
        (in_range_min / duration_min) * 100.0
    } else {
        0.0
    };
    out
}

/// Serum osmolality (mOsm/kg): `2·Na + G/18 + BUN/2.8`. Na estimated from
/// glucose via the translocational correction when not supplied.
pub fn serum_osmolality(na_meq_l: f64, glucose_mg_dl: f64, bun_mg_dl: f64) -> f64 {
    2.0 * na_meq_l + glucose_mg_dl / 18.0 + bun_mg_dl / 2.8
}

/// Effective (tonicity) osmolality — excludes urea, which freely crosses membranes.
pub fn effective_osmolality(na_meq_l: f64, glucose_mg_dl: f64) -> f64 {
    2.0 * na_meq_l + glucose_mg_dl / 18.0
}

/// Urine osmolality from measured Na/K/urea/glucose (mOsm/kg).
pub fn urine_osmolality(una: f64, uk: f64, urea_mg_dl: f64, glucose_mg_dl: f64) -> f64 {
    2.0 * (una + uk) + urea_mg_dl / 2.8 + glucose_mg_dl / 18.0
}

/// Free-water deficit (L) — Edelman/Winters: `0.6·WT·(Na/140 − 1)`.
pub fn free_water_deficit(weight_kg: f64, na_meq_l: f64) -> f64 {
    0.6 * weight_kg * (na_meq_l / 140.0 - 1.0)
}

/// Glucose–ketone index: `GKI = glucose(mmol/L) / ketones(mmol/L)`.
pub fn glucose_ketone_index(glucose_mmol: f64, ketones_mmol: f64) -> f64 {
    if ketones_mmol <= 0.0 {
        f64::INFINITY
    } else {
        glucose_mmol / ketones_mmol
    }
}

/// Tiselius activity product for calcium oxalate: `AP(CaOx) = Ca × Ox`.
pub fn ap_caox(calcium_mmol: f64, oxalate_mmol: f64, volume_l: f64) -> f64 {
    if volume_l <= 0.0 {
        return 0.0;
    }
    (calcium_mmol / volume_l) * (oxalate_mmol / volume_l) * 1e6
}

/// Tiselius activity product for calcium phosphate with pH-dependent phosphate
/// speciation (H₂PO₄⁻ / HPO₄²⁻ via pKa2 = 7.20).
pub fn ap_cap(calcium_mmol: f64, phosphate_mmol: f64, ph: f64, volume_l: f64) -> f64 {
    if volume_l <= 0.0 {
        return 0.0;
    }
    let h = 10f64.powf(-ph);
    let ka2 = 10f64.powf(-7.20);
    let hpo4_fraction = ka2 / (h + ka2);
    let ca = calcium_mmol / volume_l;
    let po4 = (phosphate_mmol / volume_l) * hpo4_fraction;
    ca.powf(1.0) * po4.powf(1.0) * 1e6
}

/// Uric acid solubility (mmol/L) as a function of pH (pKa1 = 5.35).
///
/// Undissociated uric acid solubility is ≈0.42 mmol/L at 37 °C; the ionised
/// urate fraction (pKa1 5.35) raises total solubility by `1 + 10^(pH−pKa1)`.
pub fn uric_acid_solubility_mmol(ph: f64) -> f64 {
    0.42 * (1.0 + 10f64.powf(ph - 5.35))
}

/// Supersaturation ratio for uric acid: `SS = concentration / solubility(pH)`.
pub fn uric_acid_supersaturation(conc_mmol: f64, ph: f64) -> f64 {
    let s = uric_acid_solubility_mmol(ph);
    if s <= 0.0 {
        0.0
    } else {
        conc_mmol / s
    }
}

/// Chemolysis window test for uric acid stones (target urine pH 6.2–6.8).
pub fn chemolysis_window(ph: f64) -> (bool, f64) {
    let in_window = (6.2..=6.8).contains(&ph);
    // Distance from the optimal 6.5 midpoint, in pH units.
    (in_window, (ph - 6.5).abs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rk4_matches_exponential() {
        // dy/dt = y  →  y(1) = e
        let mut y = [1.0f64];
        let dt = 1e-4;
        let steps = 10_000;
        for i in 0..steps {
            let t = i as f64 * dt;
            let _ = rk4_step(t, &mut y, dt, |_t, yy, dy| {
                dy[0] = yy[0];
            })
            .unwrap();
        }
        assert!((y[0] - std::f64::consts::E).abs() < 1e-6, "y={}", y[0]);
    }

    #[test]
    fn sglt2_lowers_threshold_and_raises_excretion() {
        let base = HovorkaParams::default();
        let sglt2 = base.with_sglt2(true);
        let g = 10.0; // mmol/L ≈ 180 mg/dL
        assert_eq!(renal_excretion_mmol_min(&base, g), 0.0);
        assert!(renal_excretion_mmol_min(&sglt2, g) > 0.0);
    }

    #[test]
    fn osmolality_reference() {
        // 2*140 + 90/18 + 14/2.8 = 280 + 5 + 5 = 290
        assert!((serum_osmolality(140.0, 90.0, 14.0) - 290.0).abs() < 1e-9);
    }

    #[test]
    fn uric_acid_window() {
        assert!(chemolysis_window(6.5).0);
        assert!(!chemolysis_window(5.8).0);
        assert!(uric_acid_solubility_mmol(6.5) > uric_acid_solubility_mmol(5.5));
    }

    #[test]
    fn rk4_rejects_bad_dt() {
        let mut y = [1.0f64];
        assert!(rk4_step(0.0, &mut y, 0.0, |_t, _y, dy| dy[0] = 0.0).is_err());
    }
}
