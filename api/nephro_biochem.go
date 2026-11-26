// NEPHRO-SPECTRA serverless clinical API — Vercel Go 1.22 runtime.
//
//	GET|POST /api/nephro_biochem?op=<operation>
//
// Operations
//   stonesupersaturation  → Tiselius AP(CaOx)/AP(CaP), uric-acid speciation
//   uroflowkdigo          → Siroky nomogram, morphotype, KDIGO staging, KFRE
//   health                → runtime + version probe used by the inspector
//
// The handler is deliberately dependency-free (stdlib only) so `go build`
// succeeds on Vercel without a module download step. It is POST-friendly
// because clinical payloads carry full urine panels in the body.
package handler

import (
	"encoding/json"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"time"

	gonephro "nephro-spectra/go_nephro"
)

// Version is stamped into every response so the client can prove which build
// produced a number.
const Version = "28.0.0-polyglot"

// envelope is the common response shape.
type envelope struct {
	OK        bool        `json:"ok"`
	Operation string      `json:"operation"`
	Engine    string      `json:"engine"`
	Version   string      `json:"version"`
	ElapsedMs float64     `json:"elapsedMs"`
	Error     string      `json:"error,omitempty"`
	Data      interface{} `json:"data,omitempty"`
}

type stoneResponse struct {
	Profile    gonephro.RiskProfile    `json:"profile"`
	Passage    gonephro.PassageResult  `json:"passage"`
	Chemistry  gonephro.UrineChemistry `json:"chemistry"`
	ComputedAt string                  `json:"computedAt"`
}

type uroflowRequest struct {
	Trace  []gonephro.FlowSample `json:"trace"`
	Female bool                  `json:"female"`
	Volume float64               `json:"volumeMl"`
	Age    float64               `json:"age"`
	ACR    float64               `json:"acrMgG"`
	Egfr   float64               `json:"egfr"`
}

type uroflowResponse struct {
	Biometrics gonephro.Biometrics `json:"biometrics"`
	GStage     string              `json:"gStage"`
	AStage     string              `json:"aStage"`
	Risk       string              `json:"kdigoRisk"`
	Monitors   int                 `json:"monitorsPerYear"`
	ReferNeph  bool                `json:"referNephrology"`
	Kfre2yr    float64             `json:"kfre2yr"`
	Kfre5yr    float64             `json:"kfre5yr"`
}

func writeJSON(w http.ResponseWriter, status int, payload envelope) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

// Handler is the Vercel serverless entry point.
func Handler(w http.ResponseWriter, r *http.Request) {
	started := time.Now()

	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	op := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("op")))
	if op == "" {
		op = "health"
	}

	base := envelope{
		OK:        true,
		Operation: op,
		Engine:    "go" + runtime.Version()[2:] + " · go_nephro",
		Version:   Version,
	}

	switch op {
	case "health":
		base.Data = map[string]interface{}{
			"status":      "ok",
			"goVersion":   runtime.Version(),
			"goroutines":  runtime.NumGoroutine(),
			"numCPU":      runtime.NumCPU(),
			"operations":  []string{"stonesupersaturation", "uroflowkdigo", "health"},
			"serverTime":  time.Now().UTC().Format(time.RFC3339),
		}
		base.ElapsedMs = msSince(started)
		writeJSON(w, http.StatusOK, base)

	case "stonesupersaturation":
		var chem gonephro.UrineChemistry
		if r.Method == http.MethodPost {
			if err := json.NewDecoder(r.Body).Decode(&chem); err != nil {
				base.OK = false
				base.Error = "invalid JSON body: " + err.Error()
				base.ElapsedMs = msSince(started)
				writeJSON(w, http.StatusBadRequest, base)
				return
			}
		} else {
			q := r.URL.Query()
			chem = gonephro.UrineChemistry{
				Calcium:      parseFloat(q.Get("calcium"), 3.0),
				Oxalate:      parseFloat(q.Get("oxalate"), 0.28),
				Magnesium:    parseFloat(q.Get("magnesium"), 3.4),
				Citrate:      parseFloat(q.Get("citrate"), 3.0),
				Phosphate:    parseFloat(q.Get("phosphate"), 20),
				UricAcid:     parseFloat(q.Get("uricAcidMmol"), 2.4),
				PH:           parseFloat(q.Get("ph"), 6.2),
				VolumeL:      parseFloat(q.Get("volumeL"), 2.4),
				CalciumMgDay: parseFloat(q.Get("calciumIntakeMg"), 1000),
			}
		}
		if chem.VolumeL <= 0 {
			base.OK = false
			base.Error = "volumeL must be greater than zero"
			base.ElapsedMs = msSince(started)
			writeJSON(w, http.StatusUnprocessableEntity, base)
			return
		}

		profile := gonephro.StoneRiskProfile(chem)
		passage := gonephro.StonePassage(gonephro.PassageInput{
			SizeMm:             6,
			Location:           "distal",
			Hydronephrosis:     false,
			PriorIntervention:  false,
			DurationDays:       0,
			SymptomsControlled: true,
		})

		base.Data = stoneResponse{
			Profile:    profile,
			Passage:    passage,
			Chemistry:  chem,
			ComputedAt: time.Now().UTC().Format(time.RFC3339),
		}
		base.ElapsedMs = msSince(started)
		writeJSON(w, http.StatusOK, base)

	case "uroflowkdigo":
		var req uroflowRequest
		if r.Method == http.MethodPost {
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				base.OK = false
				base.Error = "invalid JSON body: " + err.Error()
				base.ElapsedMs = msSince(started)
				writeJSON(w, http.StatusBadRequest, base)
				return
			}
		} else {
			req.Female = r.URL.Query().Get("female") == "true"
			req.Volume = parseFloat(r.URL.Query().Get("volumeMl"), 400)
			req.Age = parseFloat(r.URL.Query().Get("age"), 45)
			req.ACR = parseFloat(r.URL.Query().Get("acrMgG"), 30)
		}

		biometrics := gonephro.AnalyseFlow(req.Trace, req.Female)

		// Uroflowmetry itself does not yield an eGFR: staging here uses the
		// caller-supplied eGFR when present, otherwise a neutral G2 reference.
		egfr := req.Egfr
		if egfr <= 0 {
			egfr = 90
		}
		g := gonephro.GStage(egfr)
		a := gonephro.AStage(req.ACR)
		risk, monitors, refer := gonephro.KdigoCell(g, a)
		k2, k5 := gonephro.Kfre4(req.Age, req.Female, egfr, req.ACR)

		base.Data = uroflowResponse{
			Biometrics: biometrics,
			GStage:     g,
			AStage:     a,
			Risk:       risk,
			Monitors:   monitors,
			ReferNeph:  refer,
			Kfre2yr:    k2,
			Kfre5yr:    k5,
		}
		base.ElapsedMs = msSince(started)
		writeJSON(w, http.StatusOK, base)

	default:
		base.OK = false
		base.Error = "unknown operation '" + op + "' — use health, stonesupersaturation or uroflowkdigo"
		base.ElapsedMs = msSince(started)
		writeJSON(w, http.StatusNotFound, base)
	}
}

func msSince(t time.Time) float64 {
	return float64(time.Since(t).Microseconds()) / 1000.0
}

// parseFloat reads a query parameter, falling back when absent or malformed.
func parseFloat(raw string, fallback float64) float64 {
	if raw == "" {
		return fallback
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return fallback
	}
	return v
}
