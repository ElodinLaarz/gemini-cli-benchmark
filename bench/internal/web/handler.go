package web

import (
	"embed"
	"fmt"
	"html/template"
	"net/http"
	"strings"
	"time"

	"github.com/elodin/tti-bench/internal/benchmark"
)

//go:embed templates
var templateFS embed.FS

var defaultPatterns = `NORMAL mode
\[INSERT\]
for shortcuts
shift.tab to accept
Enter a prompt
Type a message
Type your message
Gemini>
>>>`

type Handler struct {
	store  *benchmark.Store
	runner *benchmark.Runner
	tmpl   *template.Template
}

func NewHandler(store *benchmark.Store, runner *benchmark.Runner) (*Handler, error) {
	funcMap := template.FuncMap{
		"deref": func(p *int64) int64 {
			if p == nil {
				return 0
			}
			return *p
		},
	}
	tmpl, err := template.New("").Funcs(funcMap).ParseFS(templateFS, "templates/*.html")
	if err != nil {
		return nil, fmt.Errorf("parse templates: %w", err)
	}
	return &Handler{store: store, runner: runner, tmpl: tmpl}, nil
}

func (h *Handler) ServeHTTP(mux *http.ServeMux) {
	mux.HandleFunc("GET /{$}", h.home)
	mux.HandleFunc("POST /benchmark", h.createBenchmark)
	mux.HandleFunc("GET /benchmark/{id}", h.detailPage)
	mux.HandleFunc("GET /benchmark/{id}/results", h.resultsPartial)
	mux.HandleFunc("DELETE /benchmark/{id}", h.deleteBenchmark)
}

type homeData struct {
	Jobs         []*benchmark.BenchmarkResult
	FormBinary   string
	FormArgs     string
	FormPatterns string
	FormRuns     int
	FormTimeout  int
	FormCooldown int
	FormError    string
}

type detailData struct {
	Job     *benchmark.BenchmarkResult
	JobID   string
	BarData []barBar
}

type barBar struct {
	Idx      int
	Val      *int64
	Height   int
	TimedOut bool
}

func (h *Handler) home(w http.ResponseWriter, r *http.Request) {
	jobs := h.store.List()
	data := homeData{
		Jobs:         jobs,
		FormPatterns: defaultPatterns,
		FormRuns:     5,
		FormTimeout:  60,
		FormCooldown: 500,
	}
	h.render(w, "list", data)
}

func (h *Handler) createBenchmark(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", 400)
		return
	}
	binary := strings.TrimSpace(r.FormValue("binary"))
	if binary == "" {
		h.renderForm(w, r, "Binary path is required")
		return
	}

	var args []string
	if a := strings.TrimSpace(r.FormValue("args")); a != "" {
		args = strings.Fields(a)
	}

	var patterns []string
	for _, p := range strings.Split(r.FormValue("patterns"), "\n") {
		p = strings.TrimSpace(p)
		if p != "" {
			patterns = append(patterns, p)
		}
	}
	if len(patterns) == 0 {
		patterns = strings.Split(defaultPatterns, "\n")
	}

	runs := 5
	if v := r.FormValue("runs"); v != "" {
		fmt.Sscanf(v, "%d", &runs)
	}
	if runs < 1 {
		runs = 1
	}
	if runs > 50 {
		runs = 50
	}

	timeoutSec := 60
	if v := r.FormValue("timeout"); v != "" {
		fmt.Sscanf(v, "%d", &timeoutSec)
	}

	cooldown := 500
	if v := r.FormValue("cooldown"); v != "" {
		fmt.Sscanf(v, "%d", &cooldown)
	}

	cfg := benchmark.BenchmarkConfig{
		Binary:         binary,
		Args:           args,
		PromptPatterns: patterns,
		Runs:           runs,
		Timeout:        time.Duration(timeoutSec) * time.Second,
		CooldownMs:     cooldown,
	}

	job := h.store.Create(cfg)
	go h.runner.RunAll(job.ID)

	w.Header().Set("HX-Redirect", "/benchmark/"+job.ID)
	w.WriteHeader(http.StatusOK)
}

func (h *Handler) renderForm(w http.ResponseWriter, r *http.Request, errMsg string) {
	data := homeData{
		FormBinary:   r.FormValue("binary"),
		FormArgs:     r.FormValue("args"),
		FormPatterns: r.FormValue("patterns"),
		FormRuns:     5,
		FormTimeout:  60,
		FormCooldown: 500,
		FormError:    errMsg,
	}
	fmt.Sscanf(r.FormValue("runs"), "%d", &data.FormRuns)
	fmt.Sscanf(r.FormValue("timeout"), "%d", &data.FormTimeout)
	fmt.Sscanf(r.FormValue("cooldown"), "%d", &data.FormCooldown)
	w.Header().Set("Content-Type", "text/html")
	h.render(w, "form", data)
}

func (h *Handler) detailPage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	job, ok := h.store.Get(id)
	if !ok {
		http.NotFound(w, r)
		return
	}
	data := detailData{Job: job, JobID: id, BarData: buildBars(job)}
	h.render(w, "detail", data)
}

func (h *Handler) resultsPartial(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	job, ok := h.store.Get(id)
	if !ok {
		http.NotFound(w, r)
		return
	}
	data := detailData{Job: job, JobID: id, BarData: buildBars(job)}
	w.Header().Set("Content-Type", "text/html")
	if err := h.tmpl.ExecuteTemplate(w, "results_partial", data); err != nil {
		http.Error(w, err.Error(), 500)
	}
}

func (h *Handler) deleteBenchmark(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	h.store.Delete(id)
	w.WriteHeader(http.StatusOK)
}

func (h *Handler) render(w http.ResponseWriter, name string, data any) {
	w.Header().Set("Content-Type", "text/html")
	if err := h.tmpl.ExecuteTemplate(w, name, data); err != nil {
		http.Error(w, err.Error(), 500)
	}
}

func buildBars(job *benchmark.BenchmarkResult) []barBar {
	var maxMs int64
	for _, r := range job.Runs {
		if r.TTIMs != nil && *r.TTIMs > maxMs {
			maxMs = *r.TTIMs
		}
	}
	bars := make([]barBar, len(job.Runs))
	for i, r := range job.Runs {
		b := barBar{Idx: i, Val: r.TTIMs, TimedOut: r.TimedOut}
		if r.TTIMs != nil && maxMs > 0 {
			b.Height = int(float64(*r.TTIMs) / float64(maxMs) * 120)
			if b.Height < 2 {
				b.Height = 2
			}
		}
		bars[i] = b
	}
	return bars
}
