package gonephro

import (
	"math"
	"sort"
)

// ---------------------------------------------------------------------------
// Uroflowmetry: Siroky nomogram, morphology classification, IPSS.
// Mirrors src/engines/acousticUroflowEngine.js so the APK can compute offline
// while this serverless endpoint serves the same numbers to thin clients.
// ---------------------------------------------------------------------------

// SirokyNorm is the Siroky nomogram quantile set at a given voided volume.
type SirokyNorm struct {
	Mean     float64 `json:"mean"`
	SD       float64 `json:"sd"`
	Lower2SD float64 `json:"lower2sd"`
	Upper2SD float64 `json:"upper2sd"`
}

// Siroky computes the Siroky nomogram: mean = 30·(1 − e^(−V/230)),
// SD = 2.2 + 0.008·V (Haylen slope). Mirrors sirokyNorm() in the JS engine.
func Siroky(volumeMl float64, female bool) SirokyNorm {
	v := clamp(volumeMl, 0, 800)
	scale := 1.0
	if female {
		scale = 1.18
	}
	mean := 30 * (1 - math.Exp(-v/230)) * scale
	sd := 2.2 + 0.008*v
	return SirokyNorm{
		Mean:     roundTo(mean, 2),
		SD:       roundTo(sd, 2),
		Lower2SD: roundTo(math.Max(0, mean-2*sd), 2),
		Upper2SD: roundTo(mean+2*sd, 2),
	}
}

// SirokyZ places a (volume, Qmax) pair on the nomogram in standard deviations.
func SirokyZ(volumeMl, qMax float64, female bool) float64 {
	n := Siroky(volumeMl, female)
	if n.SD <= 0 {
		return 0
	}
	return roundTo((qMax-n.Mean)/n.SD, 2)
}

// Morphology codes, index-compatible with MORPHOLOGY_CODES in the JS mirror.
const (
	MorphNormal      = 0
	MorphBPH         = 1
	MorphStricture   = 2
	MorphUnderactive = 3
	MorphDyssynergia = 4
)

// MorphFeatures is the scale-free geometry consumed by the classifier.
type MorphFeatures struct {
	QMax          float64 `json:"qMax"`
	TQmax         float64 `json:"tQmax"`
	TFlow         float64 `json:"tFlow"`
	PlateauRatio  float64 `json:"plateauRatio"`
	Skewness      float64 `json:"skewness"`
	Kurtosis      float64 `json:"kurtosis"`
	Interruptions int     `json:"interruptionCount"`
	Female        bool    `json:"female"`
}

// MorphologyNames maps classifier codes to their stable identifiers.
var MorphologyNames = [5]string{
	"normal",
	"bph_obstruction",
	"stricture_plateau",
	"detrusor_underactivity",
	"dyssynergia_staccato",
}

// ClassifyMorphology returns the morphotype code for a flow curve.
//
// The rules are deliberately expressed on ratios (Time-to-Qmax / flow time,
// Qavg / Qmax) so thresholds hold across voided volumes.
func ClassifyMorphology(m MorphFeatures) int {
	normalThreshold := 15.0
	if m.Female {
		normalThreshold = 20.0
	}
	tRatio := 0.5
	if m.TFlow > 0 {
		tRatio = m.TQmax / m.TFlow
	}

	var s [5]float64

	// normal bell
	if m.QMax >= normalThreshold {
		s[MorphNormal] += 2.5
	}
	if tRatio >= 0.2 && tRatio <= 0.45 {
		s[MorphNormal] += 1.5
	}
	if math.Abs(m.Skewness) < 0.9 {
		s[MorphNormal] += 1.2
	}
	if m.Interruptions == 0 {
		s[MorphNormal] += 1.0
	}
	if m.PlateauRatio >= 0.4 && m.PlateauRatio <= 0.72 {
		s[MorphNormal] += 1.0
	}

	// prostatic obstruction
	if m.QMax < 12 {
		s[MorphBPH] += 3.0
	}
	if m.QMax < 8 {
		s[MorphBPH] += 1.2
	}
	if tRatio < 0.3 {
		s[MorphBPH] += 2.2
	}
	if m.TFlow > 40 {
		s[MorphBPH] += 0.8
	}

	// stricture plateau
	if m.PlateauRatio > 0.8 {
		s[MorphStricture] += 4.0
	}
	if m.PlateauRatio > 0.86 {
		s[MorphStricture] += 2.0
	}
	if m.Interruptions == 0 {
		s[MorphStricture] += 0.6
	}
	if m.Skewness < -1.4 {
		s[MorphStricture] += 1.0
	}

	// detrusor underactivity
	if tRatio > 0.42 {
		s[MorphUnderactive] += 3.0
	}
	if m.QMax < 10.5 {
		s[MorphUnderactive] += 2.5
	}
	if m.TFlow > 30 {
		s[MorphUnderactive] += 1.5
	}
	if math.Abs(m.Skewness) < 1.2 {
		s[MorphUnderactive] += 1.0
	}

	// detrusor-sphincter dyssynergia
	if m.Interruptions >= 3 {
		s[MorphDyssynergia] += 6.0
	}
	if m.Interruptions >= 5 {
		s[MorphDyssynergia] += 2.0
	}
	if m.Interruptions >= 2 {
		s[MorphDyssynergia] += 0.8
	}

	best := 0
	for i := 1; i < 5; i++ {
		if s[i] > s[best] {
			best = i
		}
	}
	return best
}

// ---------------------------------------------------------------------------
// Flow-curve biometrics from a sampled Q(t) trace.
// ---------------------------------------------------------------------------

// FlowSample is one (time, flow, cumulative volume) triplet.
type FlowSample struct {
	T float64 `json:"t"`
	Q float64 `json:"q"`
	V float64 `json:"v"`
}

// Biometrics is the uroflowmetry summary computed from a trace.
type Biometrics struct {
	QMax          float64  `json:"qMax"`
	QAvg          float64  `json:"qAvg"`
	VVoided       float64  `json:"vVoided"`
	TQmax         float64  `json:"tQmax"`
	TFlow         float64  `json:"tFlow"`
	PlateauRatio  float64  `json:"plateauRatio"`
	Skewness      float64  `json:"skewness"`
	Kurtosis      float64  `json:"kurtosis"`
	Interruptions int      `json:"interruptionCount"`
	MorphCode     int        `json:"morphologyCode"`
	Morphology    string     `json:"morphology"`
	Nomogram      SirokyNorm `json:"nomogram"`
	ZScore        float64  `json:"zScore"`
	Flags         []string `json:"flags"`
}

func mean(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	var s float64
	for _, v := range xs {
		s += v
	}
	return s / float64(len(xs))
}

func stdev(xs []float64) float64 {
	if len(xs) < 2 {
		return 0
	}
	m := mean(xs)
	var s float64
	for _, v := range xs {
		s += (v - m) * (v - m)
	}
	return math.Sqrt(s / float64(len(xs)-1))
}

func skewOf(xs []float64) float64 {
	n := len(xs)
	if n < 3 {
		return 0
	}
	m, sd := mean(xs), stdev(xs)
	if sd == 0 {
		return 0
	}
	var s float64
	for _, v := range xs {
		s += math.Pow((v-m)/sd, 3)
	}
	return s * float64(n) / float64((n-1)*(n-2))
}

func kurtosisOf(xs []float64) float64 {
	n := len(xs)
	if n < 4 {
		return 0
	}
	m, sd := mean(xs), stdev(xs)
	if sd == 0 {
		return 0
	}
	var s float64
	for _, v := range xs {
		s += math.Pow((v-m)/sd, 4)
	}
	return s/float64(n) - 3
}

// CountInterruptions counts troughs that recover by at least 8% of Qmax on both
// sides — this rejects smooth-curve ripple while capturing staccato troughs.
func CountInterruptions(qs []float64, qMax float64) int {
	prominence := math.Max(0.35, 0.08*qMax)
	count := 0
	for i := 1; i < len(qs)-1; i++ {
		if qs[i] > qs[i-1] || qs[i] > qs[i+1] {
			continue
		}
		trough := qs[i]
		leftPeak := 0.0
		for j := maxInt(0, i-12); j <= i; j++ {
			leftPeak = math.Max(leftPeak, qs[j])
		}
		rightPeak := 0.0
		j := i
		for j < minInt(len(qs), i+120) && qs[j] < leftPeak {
			rightPeak = math.Max(rightPeak, qs[j])
			j++
		}
		if rightPeak-trough >= prominence && leftPeak-trough >= prominence {
			count++
			i = j
		}
	}
	return count
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// AnalyseFlow computes the full biometric panel from a sampled trace.
func AnalyseFlow(trace []FlowSample, female bool) Biometrics {
	qMax := 0.0
	for _, s := range trace {
		if s.Q > qMax {
			qMax = s.Q
		}
	}
	if len(trace) < 3 || qMax <= 0 {
		return Biometrics{}
	}

	// Flow time spans the first to the last sample above 5% of Qmax.
	floor := math.Max(0.25, 0.05*qMax)
	first, last := -1, -1
	for i, s := range trace {
		if s.Q > floor {
			if first < 0 {
				first = i
			}
			last = i
		}
	}
	if first < 0 || last <= first {
		return Biometrics{}
	}
	tFlow := trace[last].T - trace[first].T
	vVoided := trace[len(trace)-1].V
	qAvg := 0.0
	if tFlow > 0 {
		qAvg = vVoided / tFlow
	}

	peakIdx := 0
	for i, s := range trace {
		if s.Q > trace[peakIdx].Q {
			peakIdx = i
		}
	}

	active := make([]float64, 0, last-first+1)
	all := make([]float64, 0, len(trace))
	for _, s := range trace {
		all = append(all, s.Q)
	}
	for i := first; i <= last; i++ {
		active = append(active, trace[i].Q)
	}

	interruptions := CountInterruptions(all, qMax)
	feat := MorphFeatures{
		QMax:          qMax,
		TQmax:         trace[peakIdx].T,
		TFlow:         tFlow,
		PlateauRatio:  qAvg / qMax,
		Skewness:      skewOf(active),
		Kurtosis:      kurtosisOf(active),
		Interruptions: interruptions,
		Female:        female,
	}
	code := ClassifyMorphology(feat)
	nom := Siroky(vVoided, female)

	var flags []string
	if vVoided < 150 {
		flags = append(flags, "VOIDED_VOLUME_LOW: under 150 mL — repeat the study with a fuller bladder")
	}
	threshold := 15.0
	if female {
		threshold = 20.0
	}
	if qMax < threshold {
		flags = append(flags, "QMAX_BELOW_THRESHOLD: obstruction or detrusor underactivity likely")
	}
	if feat.PlateauRatio > 0.78 {
		flags = append(flags, "PLATEAU_GEOMETRY: Qavg/Qmax > 0.78 suggests fixed lumen narrowing")
	}
	if interruptions >= 3 {
		flags = append(flags, "STACCATO_TRACE: three or more interruptions — straining or dyssynergia")
	}

	return Biometrics{
		QMax:          roundTo(qMax, 2),
		QAvg:          roundTo(qAvg, 2),
		VVoided:       roundTo(vVoided, 1),
		TQmax:         roundTo(trace[peakIdx].T, 2),
		TFlow:         roundTo(tFlow, 2),
		PlateauRatio:  roundTo(feat.PlateauRatio, 3),
		Skewness:      roundTo(feat.Skewness, 3),
		Kurtosis:      roundTo(feat.Kurtosis, 3),
		Interruptions: interruptions,
		MorphCode:     code,
		Morphology:    MorphologyNames[code],
		Nomogram:      nom,
		ZScore:        roundTo((qMax-nom.Mean)/math.Max(0.01, nom.SD), 2),
		Flags:         flags,
	}
}

// ---------------------------------------------------------------------------
// KDIGO: 2021 race-free CKD-EPI, Cockcroft–Gault, G/A staging, KFRE.
// ---------------------------------------------------------------------------

// CkdEpi2021Cr is the race-free 2021 CKD-EPI creatinine equation.
func CkdEpi2021Cr(scrMgDl, age float64, female bool) float64 {
	kappa := 0.9
	alpha := -0.302
	factor := 1.0
	if female {
		kappa = 0.7
		alpha = -0.241
		factor = 1.012
	}
	ratio := scrMgDl / kappa
	return roundTo(142*math.Pow(math.Min(ratio, 1), alpha)*
		math.Pow(math.Max(ratio, 1), -1.2)*
		math.Pow(0.9938, age)*factor, 1)
}

// CkdEpi2021CrCys is the 2021 creatinine–cystatin C equation.
func CkdEpi2021CrCys(scrMgDl, scysMgL, age float64, female bool) float64 {
	kappa := 0.9
	alpha := -0.144
	factor := 1.0
	if female {
		kappa = 0.7
		alpha = -0.219
		factor = 0.963
	}
	r := scrMgDl / kappa
	c := scysMgL / 0.8
	return roundTo(135*math.Pow(math.Min(r, 1), alpha)*
		math.Pow(math.Max(r, 1), -0.544)*
		math.Pow(math.Min(c, 1), -0.323)*
		math.Pow(math.Max(c, 1), -0.778)*
		math.Pow(0.9961, age)*factor, 1)
}

// CockcroftGault is the creatinine clearance used for drug dosing (mL/min).
func CockcroftGault(scrMgDl, age, weightKg float64, female bool) float64 {
	if scrMgDl <= 0 {
		return 0
	}
	crcl := ((140 - age) * weightKg) / (72 * scrMgDl)
	if female {
		crcl *= 0.85
	}
	return roundTo(crcl, 1)
}

// GStage returns the KDIGO G category for an eGFR.
func GStage(egfr float64) string {
	switch {
	case egfr >= 90:
		return "G1"
	case egfr >= 60:
		return "G2"
	case egfr >= 45:
		return "G3a"
	case egfr >= 30:
		return "G3b"
	case egfr >= 15:
		return "G4"
	default:
		return "G5"
	}
}

// AStage returns the KDIGO A category for a urine albumin-to-creatinine ratio.
func AStage(acrMgG float64) string {
	switch {
	case acrMgG < 30:
		return "A1"
	case acrMgG <= 300:
		return "A2"
	default:
		return "A3"
	}
}

// kdigoRiskMatrix is the canonical 6×3 heat grid.
var kdigoRiskMatrix = [6][3]string{
	{"low", "moderate", "high"},
	{"low", "moderate", "high"},
	{"moderate", "high", "very-high"},
	{"high", "very-high", "very-high"},
	{"very-high", "very-high", "very-high"},
	{"very-high", "very-high", "very-high"},
}

// KdigoCell returns the risk band and monitoring frequency for a G×A cell.
func KdigoCell(g, a string) (risk string, monitorsPerYear int, referNephrology bool) {
	gi := map[string]int{"G1": 0, "G2": 1, "G3a": 2, "G3b": 3, "G4": 4, "G5": 5}[g]
	ai := map[string]int{"A1": 0, "A2": 1, "A3": 2}[a]
	risk = kdigoRiskMatrix[gi][ai]
	switch risk {
	case "low", "moderate":
		monitorsPerYear = 1
	case "high":
		monitorsPerYear = 2
	default:
		monitorsPerYear = 3
	}
	referNephrology = risk == "very-high" || gi >= 3 || (gi == 2 && ai == 2)
	return
}

// Kfre4 is the 4-variable Kidney Failure Risk Equation. Returns the 2- and
// 5-year risk of renal replacement therapy as percentages.
func Kfre4(age float64, female bool, egfr, acrMgG float64) (risk2yr, risk5yr float64) {
	femaleTerm := 0.0
	if female {
		femaleTerm = 1.0
	}
	lnAcr := math.Log(math.Max(0.1, acrMgG))
	lp := -0.2201*(age/10-7.036) +
		0.2467*(femaleTerm-0.5642) -
		0.5567*(egfr/5-7.222) +
		0.4510*(lnAcr-5.137)
	risk2yr = (1 - math.Pow(0.9750, math.Exp(lp))) * 100
	risk5yr = (1 - math.Pow(0.9365, math.Exp(lp))) * 100
	return roundTo(clamp(risk2yr, 0, 99), 1), roundTo(clamp(risk5yr, 0, 99), 1)
}

// FractionalExcretion returns FENa and FEUrea as percentages.
func FractionalExcretion(una, sna, scrMgDl, ucrMgDl, uureaMgDl, bunMgDl float64) (fena, feurea float64) {
	if sna > 0 && ucrMgDl > 0 {
		fena = (una * scrMgDl) / (sna * ucrMgDl) * 100
	}
	if bunMgDl > 0 && ucrMgDl > 0 {
		feurea = (uureaMgDl * scrMgDl) / (bunMgDl * ucrMgDl) * 100
	}
	return roundTo(fena, 2), roundTo(feurea, 2)
}

// SortFlowByTime is a convenience for callers that receive unsorted traces.
func SortFlowByTime(trace []FlowSample) {
	sort.Slice(trace, func(i, j int) bool { return trace[i].T < trace[j].T })
}
