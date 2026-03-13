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
	Binary            string
	Args              []string
	PromptPatterns    []string
	Runs              int
	Timeout           time.Duration
	CooldownMs        int
	UseProfileScript  bool
	ProfileScriptPath string // path to run-profile.sh; if empty defaults to run-profile.sh relative to CWD
}

type RunResult struct {
	RunIndex   int
	TTIMs      *int64
	TimedOut   bool
	Error      string
	ProfileDir string // path to per-run profile data (when UseProfileScript=true)
}

type Statistics struct {
	N        int64
	MinMs    int64
	MaxMs    int64
	AvgMs    int64
	MedianMs int64
	P95Ms    int64
}

type SystemInfo struct {
	OS            string `json:"os"`
	KernelVersion string `json:"kernel_version"`
	CPUModel      string `json:"cpu_model"`
	CPUCores      int    `json:"cpu_cores"`
	TotalRAMMB    int64  `json:"total_ram_mb"`
	NodeVersion   string `json:"node_version,omitempty"`
	GoVersion     string `json:"go_version"`
}

type BenchmarkResult struct {
	ID         string
	Config     BenchmarkConfig
	Runs       []RunResult
	Status     JobStatus
	StartedAt  time.Time
	FinishedAt *time.Time
	Stats      *Statistics
	SystemInfo *SystemInfo
	DataDir    string // path to on-disk data directory for this job
}
