<div align="center">

# NEPHRO-SPECTRA

**Day 28 of 30 — Champion Stack B**
A browser-native nephrology & urology workstation. Acoustic uroflowmetry, chrono-gated
dipstick colorimetry, Tiselius stone supersaturation, Hovorka glucose–insulin simulation
and KDIGO staging — all in one Vue shell, with **0.0 % TypeScript**.

`v28.0.0-polyglot` · `com.nephrospectra.clinical` · Vue 3.5 · Rust/WASM · Go 1.22 · Java 17 · GLSL ES 3.00

</div>

---

## What this is

Five clinical modules, each running a real solver rather than a canned animation:

| # | Module | What it actually computes |
| - | ------ | ------------------------- |
| 01 | **Acoustic Uroflowmetry Laboratory** | The voiding jet is recorded at 48 kHz, transformed with a 2048-point FFT (Welch-averaged, Hann window) and inverted through `Q = k·P^γ` with γ = 0.58. Siroky nomogram position, voided volume, flow time, interruption count, IPSS and a posterior morphotype classification. |
| 02 | **Chrono Dipstick Scanner** | Ten reagent pads read against a CIEDE2000 ΔE₀₀ nearest-swatch classifier, with Bradford adaptation from illuminant A (tungsten) to D65, per-pad read-window gating, alkaline interference correction for specific gravity, and a speckle test that separates intact RBCs from lysed blood. |
| 03 | **Kidney Stone Supersaturation Lab** | Tiselius AP(CaOx) and AP(CaP) indices, Henderson–Hasselbalch uric-acid speciation (pKa₁ = 5.35) with an explicit 6.2–6.8 chemolysis window, stone-passage probability, CT Hounsfield composition inference and SWL suitability. |
| 04 | **Glycemic–Renal Osmolality Lab** | A 5-state Hovorka glucose–insulin model (`[G, X, I, M1, M2]`) integrated with RK4, saturating renal glucose reabsorption, SGLT2 threshold shift 180 → 75 mg/dL, serum/effective osmolality, free-water deficit and GKI. |
| 05 | **KDIGO eGFR + Quote Auditor** | 2021 race-free CKD-EPI (creatinine and creatinine–cystatin C), Cockcroft–Gault, the 18-cell KDIGO heat map, KFRE-4, AKI staging, AKI-aware fractional excretion of sodium, and a CPT quote auditor that catches bundling, missing modifier 25 and duplicated panels. |

Everything is deterministic: the same inputs produce the same numbers on every run,
which is what makes the test suite below meaningful.

## The stack (and the 0.0 % TypeScript gate)

| Language | Files | Lines | Share | Role |
| -------- | ----: | ----: | ----: | ---- |
| Vue 3.5 | 13 | 6 013 | 40.5 % | Interface shell, module orchestration, reactivity |
| JavaScript ES2024 | 13 | 4 354 | 29.3 % | Engines, composables, IndexedDB vault, exporters |
| Go 1.22 | 3 | 1 118 | 7.5 % | Serverless supersaturation + KDIGO kernels (`api/`) |
| CSS | 1 | 1 110 | 7.5 % | Four-theme token system + component layer |
| Rust | 3 | 926 | 6.2 % | Acoustic DSP + Tiselius–Hovorka RK4 → WASM |
| Java 17 | 3 | 729 | 4.9 % | Capacitor native plugins + host activity |
| GLSL ES 3.00 | 2 | 413 | 2.8 % | Renal-fluid underlay, chromatic dipstick lens |
| **Total** | **45** | **14 838** | **100 %** | |

**There is no TypeScript in this repository.** No `.ts`, no `.tsx`, no `.tsconfig`,
no `<script lang="ts">`. This is enforced twice: by `npm test`-independent CI grep in
`.github/workflows/build-and-bundle-apk.yml` and by the runtime inspector, which
reports the live share of every language it can see.

Vue SFCs use `<script setup>` with plain JavaScript; type information lives in
JSDoc comments and `jsconfig.json` (checked with `checkJs` off — the intent is
editor assistance, not a compile step).

## Quick start

```bash
npm install
npm run dev        # http://0.0.0.0:5173
npm test           # 170 assertions across engines + components
npm run build      # → dist/ (≈348 kB JS, ≈124 kB gzip)
```

Requires Node 22 (`.nvmrc` not used; the CI pins 22).

### Android / APK

```bash
npm run build
npx cap add android          # first run only
npx cap sync android
npm run apk                  # → public/releases/nephro-spectra-v28.0.0.apk
```

The Gradle project is generated in CI by
[`build-and-bundle-apk.yml`](.github/workflows/build-and-bundle-apk.yml), which
also compiles the two native plugins, registers them in `MainActivity`, signs the
APK and attaches it to the GitHub release for `v*` tags. See
[`android/README.md`](android/README.md).

## Verification

`npm test` runs 170 assertions. The ones that matter most:

```
✓ CKD-EPI 2021: 60 y/o male, SCr 1.0 mg/dL → 86 mL/min/1.73 m²
✓ CIEDE2000 against all six published Sharma reference pairs
✓ morphology classifier correct on all 5 voiding presets (scale-invariant)
✓ every preset reproduces its declared Qmax (±4 %) and voided volume (±2 %)
✓ FFT: an impulse stays flat; an on-bin tone lands on its own frequency
✓ acoustic synthesis → peakFlow() recovers declared Qmax within ±20 %
✓ Hovorka: bounded for every scenario, stable fasting fixed point, meal response
✓ SGLT2 blockade lowers RTG to 75 mg/dL and raises cumulative glycosuria
✓ AP(CaP) rises ~6× from pH 5.5 → 7.4, anchored to reference urine
✓ ACR 300 mg/g → A2 (inclusive KDIGO boundary)
✓ healthy FENa 0.24 is *not* labelled pre-renal
✓ CPT: bundling, modifier 25, duplicates, Litholink panel duplication all caught
```

Several of these started life as genuine defects and are now regression tests — the
Siroky SD slope, the AP(CaP) pH exponent, the ACR staging boundary and the FENa
gate were all wrong at some point today.

## Repository layout

```
api/nephro_biochem.go                     Go serverless handler (stdlib only)
go_nephro/stone_supersaturation.go        Tiselius APs, uric speciation, passage model
go_nephro/uroflow_kdigo_solver.go         Siroky, morphology, CKD-EPI, KFRE, FE
rust-nephro/src/sonouroflow_dsp.rs        Windowed FFT, jet power, calibration
rust-nephro/src/tiselius_hovorka_rk4.rs   Shared RK4 + Tiselius/Hovorka core
android/app/src/main/java/...             Capacitor plugins + MainActivity
src/engines/                              JS engines (authoritative, testable)
src/db/indexedDbNephroVault.js            nephro_spectra_vault_v1 (5 stores)
src/composables/                          Springs, RBAC, report export
src/components/modules/                   The five clinical modules
src/components/ui/                        PlotFrame, GooeyDock, shaders, inspector
src/shaders/                              GLSL ES 3.00 programs
tests/                                    170 assertions
```

### Numeric contract, shared across languages

The same constants appear in the Rust, JS and Go implementations, and the test
suite pins them:

| Quantity | Value |
| -------- | ----- |
| Sample rate / FFT | 48 000 Hz / 2 048 |
| Jet band | 550 – 6200 Hz, γ = 0.58, `DEFAULT_K_CAL` = 1350 |
| Minnaert | γ = 1.4, P = 101 325 Pa, ρ = 1000 kg/m³ |
| Siroky | mean `30·(1 − e^(−V/230))`, SD `2.2 + 0.008·V` (female ×1.18) |
| CKD-EPI 2021 Cr | 142, κ 0.7/0.9, α −0.241/−0.302, ×0.9938^age, ×1.012 (f) |
| CKD-EPI 2021 Cr-Cys | 135, α −0.219/−0.144, −0.544, cys 0.8/−0.323/−0.778 |
| KFRE-4 | −0.2201, 0.2467, −0.5567, 0.4510; baseline 0.9750 / 0.9365 |
| Uric acid | pKa₁ 5.35, solubility `0.42·(1 + 10^(pH−5.35))` |
| Chemolysis | pH 6.2 – 6.8, optimum 6.5 |
| SGLT2 RTG | 180 → 75 mg/dL |
| Free-water deficit | `0.6·WT·(Na/140 − 1)` |

## Design system

Four themes are switched with `data-theme` on `<html>` and persisted to
`localStorage['nephro-spectra.theme']`:

- `obsidian` (default) — dark clinical console
- `daylight` — high-contrast light
- `colorimeter` — the dipstick module's lab palette
- `eco` — low-light night-round palette

Motion uses a real spring integrator (stiffness 210, damping 19, mass 1.0, ζ ≈ 0.66),
not CSS easing. The dock's metaballs come from an SVG `feGaussianBlur` →
`feColorMatrix` alpha threshold → `feComposite` filter applied **only** to a
dedicated blob layer, so labels above it stay crisp.

## Data & privacy

All records live in IndexedDB (`nephro_spectra_vault_v1`: 5 object stores) on the
device. Nothing leaves the browser unless you explicitly export it. Android release
builds are configured TLS-only (`android/.../res/xml/network_security_config.xml`)
because the vault syncs clinical records to Supabase when a user connects an account.

## Clinical disclaimer

**This is a demonstration / engineering artefact, not a medical device.** It carries
no regulatory clearance (no CE mark, no FDA 510(k), no FDA De Novo). The models are
faithful to the literature they cite, but they are not validated for diagnosis,
treatment decisions or billing adjudication. Every screen that shows a computed
result is paired with the equation and its reference — read them, and confirm
anything that matters against a real laboratory system.

## License

MIT.
