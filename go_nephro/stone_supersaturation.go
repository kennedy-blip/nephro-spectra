// Package gonephro implements the NEPHRO-SPECTRA serverless clinical kernels.
//
// This file is the Go authority for stone chemistry: Tiselius activity products
// AP(CaOx) / AP(CaP), uric-acid Henderson–Hasselbalch speciation at pKa1 5.35
// with the 6.2–6.8 chemolysis window, and the logistic spontaneous-passage
// model. Every function is deterministic and dependency-free so it compiles on
// Vercel's Go 1.22 runtime with no module downloads.
package gonephro

import "math"

// UricPKa1 is the first dissociation constant of uric acid at 37 °C.
const UricPKa1 = 5.35

// UricAcidSolubilityBase is the solubility of the undissociated acid (mmol/L).
const UricAcidSolubilityBase = 0.42

// ChemolysisLo and ChemolysisHi bound the therapeutic urine-pH window for
// uric-acid stone dissolution.
const (
	ChemolysisLo = 6.2
	ChemolysisHi = 6.8
)

// Calibration constants for the two Tiselius indices, fixed against a reference
// 24-hour urine (Ca 3.0, Ox 0.28, Mg 3.4, citrate 3.0, P 20 mmol/L, pH 6.2,
// V 2.4 L) so the healthy profile scores AP(CaOx) ≈ 0.70 and AP(CaP) ≈ 1.5.
const (
	APCaOxK = 2.25
	APCaPK  = 0.21
)

// UrineChemistry is a 24-hour urine panel. Concentrations are mmol/L and
// VolumeL is the total 24-hour voided volume in litres.
type UrineChemistry struct {
	Calcium      float64 `json:"calcium"`
	Oxalate      float64 `json:"oxalate"`
	Magnesium    float64 `json:"magnesium"`
	Citrate      float64 `json:"citrate"`
	Phosphate    float64 `json:"phosphate"`
	UricAcid     float64 `json:"uricAcidMmol"`
	PH           float64 `json:"ph"`
	VolumeL      float64 `json:"volumeL"`
	CalciumMgDay float64 `json:"calciumIntakeMg"`
}

// IndexResult is the shared shape of an activity-product evaluation.
type IndexResult struct {
	Index          float64 `json:"index"`
	Valid          bool    `json:"valid"`
	Supersaturated bool    `json:"supersaturated"`
	RiskBand       string  `json:"riskBand"`
	Reason         string  `json:"reason,omitempty"`
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func roundTo(v float64, places int) float64 {
	f := math.Pow(10, float64(places))
	return math.Round(v*f) / f
}

// APCaOx computes the Tiselius calcium-oxalate activity product:
//
//	AP(CaOx) = K · Ca^1.07 · Ox^0.68 · Mg^-0.18 · Cit^-0.12 · V^-1.31
//
// An index ≥ 1 indicates thermodynamic supersaturation.
func APCaOx(c UrineChemistry) IndexResult {
	if c.VolumeL <= 0 {
		return IndexResult{Valid: false, Reason: "voided volume must be positive"}
	}
	ca := math.Max(0.05, c.Calcium)
	ox := math.Max(0.01, c.Oxalate)
	mg := math.Max(0.2, c.Magnesium)
	cit := math.Max(0.05, c.Citrate)

	idx := APCaOxK *
		math.Pow(ca, 1.07) *
		math.Pow(ox, 0.68) *
		math.Pow(mg, -0.18) *
		math.Pow(cit, -0.12) *
		math.Pow(c.VolumeL, -1.31)

	return IndexResult{
		Index:          roundTo(idx, 3),
		Valid:          true,
		Supersaturated: idx >= 1,
		RiskBand:       riskBandCaOx(idx),
	}
}

func riskBandCaOx(idx float64) string {
	switch {
	case idx < 1:
		return "low"
	case idx < 2:
		return "borderline"
	case idx < 3.5:
		return "elevated"
	default:
		return "high"
	}
}

// APCaP computes the Tiselius calcium-phosphate activity product:
//
//	AP(CaP) = K · Ca^1.34 · P^0.55 · (pH/7.0)^3.2 · V^-0.90
//
// The strong pH exponent is the reason over-alkalinisation paradoxically drives
// brushite and apatite formation. An index ≥ 2 indicates supersaturation.
func APCaP(c UrineChemistry) IndexResult {
	if c.VolumeL <= 0 {
		return IndexResult{Valid: false, Reason: "voided volume must be positive"}
	}
	ca := math.Max(0.05, c.Calcium)
	p := math.Max(0.05, c.Phosphate)
	ph := math.Max(4, c.PH)

	idx := APCaPK *
		math.Pow(ca, 1.34) *
		math.Pow(p, 0.55) *
		math.Pow(ph/7.0, 3.2) *
		math.Pow(c.VolumeL, -0.9)

	return IndexResult{
		Index:          roundTo(idx, 3),
		Valid:          true,
		Supersaturated: idx >= 2,
		RiskBand:       riskBandCaP(idx),
	}
}

func riskBandCaP(idx float64) string {
	switch {
	case idx < 2:
		return "low"
	case idx < 4:
		return "borderline"
	case idx < 8:
		return "elevated"
	default:
		return "high"
	}
}

// UrateIonisedFraction is the Henderson–Hasselbalch ionised fraction:
//
//	α = 1 / (1 + 10^(pKa1 − pH))
func UrateIonisedFraction(ph float64) float64 {
	return 1 / (1 + math.Pow(10, UricPKa1-ph))
}

// UricAcidSolubility is the total (ionised + un-ionised) uric-acid solubility in
// mmol/L at a given urine pH.
func UricAcidSolubility(ph float64) float64 {
	return UricAcidSolubilityBase * (1 + math.Pow(10, ph-UricPKa1))
}

// UricAcidSupersaturation is concentration / solubility at the given pH.
func UricAcidSupersaturation(concMmol, ph float64) float64 {
	s := UricAcidSolubility(ph)
	if s <= 0 {
		return 0
	}
	return concMmol / s
}

// UricAcidProfile is the full speciation panel for one urine sample.
type UricAcidProfile struct {
	PH                 float64  `json:"ph"`
	Concentration      float64  `json:"concentration"`
	IonisedFraction    float64  `json:"ionisedFraction"`
	SolubilityMmol     float64  `json:"solubilityMmol"`
	Supersaturation    float64  `json:"supersaturation"`
	InChemolysisWindow bool     `json:"inChemolysisWindow"`
	ChemolysisEligible bool     `json:"chemolysisEligible"`
	RequiredPH         *float64 `json:"requiredPh"`
	HalfLifeHours      float64  `json:"dissolutionHalfLifeHours"`
}

// UricAcidPanel evaluates the full uric-acid speciation panel.
func UricAcidPanel(concMmol, ph float64) UricAcidProfile {
	alpha := UrateIonisedFraction(ph)
	sol := UricAcidSolubility(ph)
	ss := UricAcidSupersaturation(concMmol, ph)
	inWindow := ph >= ChemolysisLo && ph <= ChemolysisHi

	// pH required to reach SS = 1.0 at the current urate load.
	ratio := concMmol/UricAcidSolubilityBase - 1
	var required *float64
	if ratio > 0 {
		v := UricPKa1 + math.Log10(ratio)
		v = clamp(v, 4.5, 7.6)
		v = roundTo(v, 2)
		required = &v
	}

	// Empirical dissolution rate: faster at higher pH and higher supersaturation.
	rate := 0.055 * math.Pow(10, math.Max(0, ph-UricPKa1)*0.9)
	driven := math.Max(1.05, ss)
	halfLife := math.Log(2) / (rate * math.Log(driven))

	return UricAcidProfile{
		PH:                 roundTo(ph, 2),
		Concentration:      roundTo(concMmol, 3),
		IonisedFraction:    roundTo(alpha, 4),
		SolubilityMmol:     roundTo(sol, 3),
		Supersaturation:    roundTo(ss, 3),
		InChemolysisWindow: inWindow,
		ChemolysisEligible: ss > 1 && ph < ChemolysisLo,
		RequiredPH:         required,
		HalfLifeHours:      roundTo(halfLife, 2),
	}
}

// PassageInput describes a ureteral calculus.
type PassageInput struct {
	SizeMm             float64 `json:"sizeMm"`
	Location           string  `json:"location"` // distal | mid | proximal
	Hydronephrosis     bool    `json:"hydronephrosis"`
	PriorIntervention  bool    `json:"priorIntervention"`
	DurationDays       float64 `json:"durationDays"`
	SymptomsControlled bool    `json:"symptomsControlled"`
}

// PassageResult is the spontaneous-passage prediction.
type PassageResult struct {
	Probability    float64 `json:"probability"`
	Logit          float64 `json:"logit"`
	ExpectedWeeks  int     `json:"expectedWeeks"`
	Urgency        string  `json:"urgency"`
	Recommendation string  `json:"recommendation"`
}

// StonePassage computes the logistic spontaneous-passage probability:
//
//	logit(P) = 3.05 − 0.62·size + location − 0.72·hydro + prior − duration + symptom
func StonePassage(in PassageInput) PassageResult {
	size := clamp(in.SizeMm, 1, 20)

	var locTerm float64
	switch in.Location {
	case "distal":
		locTerm = 0.55
	case "mid":
		locTerm = -0.15
	default:
		locTerm = -0.85
	}

	hTerm := 0.15
	if in.Hydronephrosis {
		hTerm = -0.72
	}
	pTerm := 0.0
	if in.PriorIntervention {
		pTerm = -0.30
	}
	dTerm := math.Min(0.9, in.DurationDays*0.01)
	symTerm := -0.35
	if in.SymptomsControlled {
		symTerm = 0.20
	}

	logit := 3.05 - 0.62*size + locTerm + hTerm + pTerm - dTerm + symTerm
	prob := 1 / (1 + math.Exp(-logit))
	prob = clamp(prob, 0.005, 0.985)

	weekFactor := 1.0
	switch in.Location {
	case "proximal":
		weekFactor = 1.5
	case "mid":
		weekFactor = 1.2
	}
	weeks := int(math.Round(6.2 * math.Exp(0.19*size) * weekFactor))

	urgency := "routine"
	switch {
	case in.Hydronephrosis && !in.SymptomsControlled:
		urgency = "emergency"
	case prob < 0.3:
		urgency = "expedited"
	case prob < 0.6:
		urgency = "routine-close"
	}

	rec := "Watchful waiting with medical expulsive therapy, analgesia and follow-up imaging."
	switch {
	case size > 10:
		rec = "Stone larger than 10 mm — urology referral for ureteroscopy (CPT 52356) or SWL (CPT 50590)."
	case in.Hydronephrosis && !in.SymptomsControlled:
		rec = "Obstructing stone with uncontrolled symptoms — urgent decompression."
	case prob < 0.5:
		rec = "Low modelled passage probability — close follow-up and early surgical planning."
	}

	return PassageResult{
		Probability:    roundTo(prob*100, 1),
		Logit:          roundTo(logit, 3),
		ExpectedWeeks:  weeks,
		Urgency:        urgency,
		Recommendation: rec,
	}
}

// RiskProfile aggregates the three stone families and names the dominant one,
// each normalised by its own supersaturation threshold.
type RiskProfile struct {
	CaOx      IndexResult     `json:"caox"`
	CaP       IndexResult     `json:"cap"`
	UricAcid  UricAcidProfile `json:"uricAcid"`
	Dominant  string          `json:"dominant"`
	Aggregate float64         `json:"aggregate"`
}

// StoneRiskProfile evaluates all three stone families for one urine sample.
func StoneRiskProfile(c UrineChemistry) RiskProfile {
	caox := APCaOx(c)
	cap := APCaP(c)
	uric := UricAcidPanel(c.UricAcid, c.PH)

	caoxScore := caox.Index
	capScore := cap.Index / 2.0
	uricScore := uric.Supersaturation

	dominant := "calcium-oxalate"
	if capScore >= caoxScore && capScore >= uricScore {
		dominant = "calcium-phosphate"
	} else if uricScore > caoxScore && uricScore >= capScore {
		dominant = "uric-acid"
	}

	return RiskProfile{
		CaOx:      caox,
		CaP:       cap,
		UricAcid:  uric,
		Dominant:  dominant,
		Aggregate: roundTo(math.Max(caoxScore, math.Max(capScore, uricScore)), 3),
	}
}
