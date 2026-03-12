package benchmark

import "time"

type JobStatus string

const (
	StatusPending JobStatus = "pending"
	StatusRunning JobStatus = "running"
	StatusDone    JobStatus = "done"
	StatusError   JobStatus = "error"
)

type BenchmarkConfig struct {
	Binary         string
	Args           []string
	PromptPatterns []string
	Runs           int
	Timeout        time.Duration
	CooldownMs     int
}

type RunResult struct {
	RunIndex int
	TTIMs    *int64
	TimedOut bool
	Error    string
}

type Statistics struct {
	N        int64
	MinMs    int64
	MaxMs    int64
	AvgMs    int64
	MedianMs int64
	P95Ms    int64
}

type BenchmarkResult struct {
	ID         string
	Config     BenchmarkConfig
	Runs       []RunResult
	Status     JobStatus
	StartedAt  time.Time
	FinishedAt *time.Time
	Stats      *Statistics
}
