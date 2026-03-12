package benchmark

import (
	"fmt"
	"sync"
	"time"
)

type Store struct {
	mu   sync.RWMutex
	jobs map[string]*BenchmarkResult
	seq  int
}

func NewStore() *Store {
	return &Store{jobs: make(map[string]*BenchmarkResult)}
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
	r := &BenchmarkResult{
		ID:        id,
		Config:    cfg,
		Runs:      runs,
		Status:    StatusPending,
		StartedAt: time.Now(),
	}
	s.jobs[id] = r
	return r
}

func (s *Store) Get(id string) (*BenchmarkResult, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.jobs[id]
	if !ok {
		return nil, false
	}
	// return a shallow copy
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
		copy := *r
		out = append(out, &copy)
	}
	return out
}

func (s *Store) SetRunning(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.jobs[id]; ok {
		r.Status = StatusRunning
	}
}

func (s *Store) UpdateRun(id string, run RunResult) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.jobs[id]; ok {
		r.Runs[run.RunIndex] = run
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
		return
	}
	r.Status = StatusDone
}

func (s *Store) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.jobs[id]
	delete(s.jobs, id)
	return ok
}
