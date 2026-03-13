package benchmark

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type StoreConfig struct {
	DataDir string // default: ./data
}

type Store struct {
	mu        sync.RWMutex
	jobs      map[string]*BenchmarkResult
	seq       int
	dataDir   string
	listeners map[string][]chan struct{}
}

func NewStore(cfg StoreConfig) *Store {
	if cfg.DataDir == "" {
		cfg.DataDir = "./data"
	}
	s := &Store{
		jobs:      make(map[string]*BenchmarkResult),
		dataDir:   cfg.DataDir,
		listeners: make(map[string][]chan struct{}),
	}
	s.loadFromDisk()
	return s
}

func (s *Store) jobDataDir(id string) string {
	return filepath.Join(s.dataDir, "jobs", id)
}

// diskResult is the JSON representation stored on disk.
type diskResult struct {
	ID         string      `json:"id"`
	Config     diskConfig  `json:"config"`
	Runs       []RunResult `json:"runs"`
	Status     JobStatus   `json:"status"`
	StartedAt  time.Time   `json:"started_at"`
	FinishedAt *time.Time  `json:"finished_at,omitempty"`
	Stats      *Statistics `json:"stats,omitempty"`
	SystemInfo *SystemInfo `json:"system_info,omitempty"`
	DataDir    string      `json:"data_dir"`
}

type diskConfig struct {
	Binary            string   `json:"binary"`
	Args              []string `json:"args"`
	PromptPatterns    []string `json:"prompt_patterns"`
	Runs              int      `json:"runs"`
	TimeoutSec        int64    `json:"timeout_sec"`
	CooldownMs        int      `json:"cooldown_ms"`
	UseProfileScript  bool     `json:"use_profile_script"`
	ProfileScriptPath string   `json:"profile_script_path"`
}

func toMem(d diskResult) *BenchmarkResult {
	return &BenchmarkResult{
		ID: d.ID,
		Config: BenchmarkConfig{
			Binary:            d.Config.Binary,
			Args:              d.Config.Args,
			PromptPatterns:    d.Config.PromptPatterns,
			Runs:              d.Config.Runs,
			Timeout:           time.Duration(d.Config.TimeoutSec) * time.Second,
			CooldownMs:        d.Config.CooldownMs,
			UseProfileScript:  d.Config.UseProfileScript,
			ProfileScriptPath: d.Config.ProfileScriptPath,
		},
		Runs:       d.Runs,
		Status:     d.Status,
		StartedAt:  d.StartedAt,
		FinishedAt: d.FinishedAt,
		Stats:      d.Stats,
		SystemInfo: d.SystemInfo,
		DataDir:    d.DataDir,
	}
}

func toDisk(r *BenchmarkResult) diskResult {
	return diskResult{
		ID: r.ID,
		Config: diskConfig{
			Binary:            r.Config.Binary,
			Args:              r.Config.Args,
			PromptPatterns:    r.Config.PromptPatterns,
			Runs:              r.Config.Runs,
			TimeoutSec:        int64(r.Config.Timeout / time.Second),
			CooldownMs:        r.Config.CooldownMs,
			UseProfileScript:  r.Config.UseProfileScript,
			ProfileScriptPath: r.Config.ProfileScriptPath,
		},
		Runs:       r.Runs,
		Status:     r.Status,
		StartedAt:  r.StartedAt,
		FinishedAt: r.FinishedAt,
		Stats:      r.Stats,
		SystemInfo: r.SystemInfo,
		DataDir:    r.DataDir,
	}
}

func (s *Store) persist(r *BenchmarkResult) {
	d := toDisk(r)
	data, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return
	}
	dir := s.jobDataDir(r.ID)
	_ = os.MkdirAll(dir, 0755)
	_ = os.WriteFile(filepath.Join(dir, "results.json"), data, 0644)
}

func (s *Store) loadFromDisk() {
	pattern := filepath.Join(s.dataDir, "jobs", "*", "results.json")
	matches, _ := filepath.Glob(pattern)
	for _, path := range matches {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var d diskResult
		if err := json.Unmarshal(data, &d); err != nil {
			continue
		}
		r := toMem(d)
		// Mark interrupted jobs as error
		if r.Status == StatusRunning || r.Status == StatusPending {
			r.Status = StatusError
			for i, run := range r.Runs {
				if run.TTIMs == nil && !run.TimedOut && run.Error == "" {
					r.Runs[i].Error = "interrupted by server restart"
				}
			}
		}
		s.jobs[r.ID] = r
	}
}

// notify signals all SSE listeners for the given job. Must be called with s.mu held.
func (s *Store) notify(id string) {
	for _, ch := range s.listeners[id] {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// Subscribe returns a channel that receives a signal whenever job id is updated.
// Call the returned function to unsubscribe.
func (s *Store) Subscribe(id string) (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	s.mu.Lock()
	s.listeners[id] = append(s.listeners[id], ch)
	s.mu.Unlock()
	return ch, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		chans := s.listeners[id]
		for i, c := range chans {
			if c == ch {
				s.listeners[id] = append(chans[:i], chans[i+1:]...)
				break
			}
		}
	}
}

func (s *Store) Create(cfg BenchmarkConfig) *BenchmarkResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seq++
	id := fmt.Sprintf("job-%d-%d", time.Now().UnixMilli(), s.seq)
	runs := make([]RunResult, cfg.Runs)
	for i := range runs {
		runs[i] = RunResult{RunIndex: i}
	}
	dataDir := s.jobDataDir(id)
	r := &BenchmarkResult{
		ID:        id,
		Config:    cfg,
		Runs:      runs,
		Status:    StatusPending,
		StartedAt: time.Now(),
		DataDir:   dataDir,
	}
	s.jobs[id] = r
	s.persist(r)
	return r
}

func (s *Store) Get(id string) (*BenchmarkResult, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.jobs[id]
	if !ok {
		return nil, false
	}
	copy := *r
	runs := make([]RunResult, len(r.Runs))
	for i, rr := range r.Runs {
		runs[i] = rr
	}
	copy.Runs = runs
	return &copy, true
}

func (s *Store) List() []*BenchmarkResult {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*BenchmarkResult, 0, len(s.jobs))
	for _, r := range s.jobs {
		cp := *r
		out = append(out, &cp)
	}
	return out
}

func (s *Store) SetRunning(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.jobs[id]; ok {
		r.Status = StatusRunning
		s.persist(r)
		s.notify(id)
	}
}

func (s *Store) UpdateRun(id string, run RunResult) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.jobs[id]; ok {
		r.Runs[run.RunIndex] = run
		s.persist(r)
		s.notify(id)
	}
}

func (s *Store) SetSystemInfo(id string, info *SystemInfo) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.jobs[id]; ok {
		r.SystemInfo = info
		s.persist(r)
	}
}

func (s *Store) Finish(id string, stats *Statistics, jobErr string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.jobs[id]
	if !ok {
		return
	}
	now := time.Now()
	r.FinishedAt = &now
	r.Stats = stats
	if jobErr != "" {
		r.Status = StatusError
	} else {
		r.Status = StatusDone
	}
	s.persist(r)
	s.notify(id)
}

func (s *Store) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.jobs[id]
	delete(s.jobs, id)
	return ok
}
