package web

import (
	"embed"
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/elodin/tti-bench/internal/benchmark"
	"github.com/elodin/tti-bench/internal/profile"
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
	mux.HandleFunc("GET /benchmark/{id}/events", h.sseEvents)
	mux.HandleFunc("GET /benchmark/{id}/profile/cpu", h.profileCPU)
	mux.HandleFunc("GET /benchmark/{id}/profile/wall", h.profileWall)
	mux.HandleFunc("GET /benchmark/{id}/profile/memory", h.profileMemory)
	mux.HandleFunc("DELETE /benchmark/{id}", h.deleteBenchmark)
}

type homeData struct {
	Jobs                  []*benchmark.BenchmarkResult
	FormBinary            string
	FormArgs              string
	FormPatterns          string
	FormRuns              int
	FormTimeout           int
	FormCooldown          int
	FormError             string
	FormUseProfileScript  bool
	FormProfileScriptPath string
}

type detailData struct {
	Job        *benchmark.BenchmarkResult
	JobID      string
	BarData    []barBar
	HasProfile bool
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

	useProfileScript := r.FormValue("use_profile_script") == "on"
	profileScriptPath := strings.TrimSpace(r.FormValue("profile_script_path"))

	cfg := benchmark.BenchmarkConfig{
		Binary:            binary,
		Args:              args,
		PromptPatterns:    patterns,
		Runs:              runs,
		Timeout:           time.Duration(timeoutSec) * time.Second,
		CooldownMs:        cooldown,
		UseProfileScript:  useProfileScript,
		ProfileScriptPath: profileScriptPath,
	}

	job := h.store.Create(cfg)
	go h.runner.RunAll(job.ID)

	w.Header().Set("HX-Redirect", "/benchmark/"+job.ID)
	w.WriteHeader(http.StatusOK)
}

func (h *Handler) renderForm(w http.ResponseWriter, r *http.Request, errMsg string) {
	data := homeData{
		FormBinary:            r.FormValue("binary"),
		FormArgs:              r.FormValue("args"),
		FormPatterns:          r.FormValue("patterns"),
		FormRuns:              5,
		FormTimeout:           60,
		FormCooldown:          500,
		FormError:             errMsg,
		FormUseProfileScript:  r.FormValue("use_profile_script") == "on",
		FormProfileScriptPath: r.FormValue("profile_script_path"),
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
	data := detailData{Job: job, JobID: id, BarData: buildBars(job), HasProfile: hasProfileData(job)}
	h.render(w, "detail", data)
}

func (h *Handler) resultsPartial(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	job, ok := h.store.Get(id)
	if !ok {
		http.NotFound(w, r)
		return
	}
	data := detailData{Job: job, JobID: id, BarData: buildBars(job), HasProfile: hasProfileData(job)}
	w.Header().Set("Content-Type", "text/html")
	if err := h.tmpl.ExecuteTemplate(w, "results_partial", data); err != nil {
		http.Error(w, err.Error(), 500)
	}
}

func (h *Handler) sseEvents(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ch, unsub := h.store.Subscribe(id)
	defer unsub()

	// Send initial state
	if job, ok := h.store.Get(id); ok {
		h.sendSSEUpdate(w, job)
		flusher.Flush()
		if job.Status == benchmark.StatusDone || job.Status == benchmark.StatusError {
			return
		}
	}

	for {
		select {
		case <-r.Context().Done():
			return
		case _, ok := <-ch:
			if !ok {
				return
			}
			job, found := h.store.Get(id)
			if !found {
				return
			}
			h.sendSSEUpdate(w, job)
			flusher.Flush()
			if job.Status == benchmark.StatusDone || job.Status == benchmark.StatusError {
				fmt.Fprintf(w, "event: job-done\ndata: done\n\n")
				flusher.Flush()
				return
			}
		}
	}
}

func (h *Handler) sendSSEUpdate(w http.ResponseWriter, job *benchmark.BenchmarkResult) {
	data, _ := json.Marshal(job)
	fmt.Fprintf(w, "event: update\ndata: %s\n\n", data)
}

func (h *Handler) profileCPU(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	job, ok := h.store.Get(id)
	if !ok {
		http.NotFound(w, r)
		return
	}

	runDir := firstProfileDir(job)
	if runDir == "" {
		http.Error(w, "no profile data", http.StatusNotFound)
		return
	}

	cpuPath, err := profile.FindCPUProfile(runDir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	tree, err := profile.ParseCPUProfile(cpuPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(tree)
}

func (h *Handler) profileWall(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	job, ok := h.store.Get(id)
	if !ok {
		http.NotFound(w, r)
		return
	}

	runDir := firstProfileDir(job)
	if runDir == "" {
		http.Error(w, "no profile data", http.StatusNotFound)
		return
	}

	wallPath, err := profile.FindWallTrace(runDir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	tree, err := profile.ParseWallTrace(wallPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(tree)
}

func (h *Handler) profileMemory(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	job, ok := h.store.Get(id)
	if !ok {
		http.NotFound(w, r)
		return
	}

	runDir := firstProfileDir(job)
	if runDir == "" {
		http.Error(w, "no profile data", http.StatusNotFound)
		return
	}

	memPath, err := profile.FindMemTrace(runDir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	data, err := profile.ParseMemTrace(memPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

// firstProfileDir returns the ProfileDir of the first completed run that has one.
func firstProfileDir(job *benchmark.BenchmarkResult) string {
	for _, run := range job.Runs {
		if run.ProfileDir != "" {
			if _, err := os.Stat(run.ProfileDir); err == nil {
				return run.ProfileDir
			}
		}
	}
	return ""
}

// hasProfileData returns true if any run has profile data.
func hasProfileData(job *benchmark.BenchmarkResult) bool {
	return firstProfileDir(job) != ""
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
