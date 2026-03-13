package benchmark

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/creack/pty"
)

// scriptGracePeriod is extra time added to the overall timeout when invoking
// run-profile.sh, to account for report-generation and cleanup overhead.
const scriptGracePeriod = 60 * time.Second

type Runner struct {
	store *Store
}

func NewRunner(store *Store) *Runner {
	return &Runner{store: store}
}

func (r *Runner) RunAll(id string) {
	job, ok := r.store.Get(id)
	if !ok {
		return
	}
	r.store.SetRunning(id)

	// Capture system info once per job
	info := captureSystemInfo()
	r.store.SetSystemInfo(id, info)

	if job.Config.UseProfileScript {
		r.runAllWithScript(id, job)
		return
	}

	patterns := make([]*regexp.Regexp, 0, len(job.Config.PromptPatterns))
	for _, p := range job.Config.PromptPatterns {
		if re, err := regexp.Compile(p); err == nil {
			patterns = append(patterns, re)
		}
	}

	for i := 0; i < job.Config.Runs; i++ {
		if i > 0 && job.Config.CooldownMs > 0 {
			time.Sleep(time.Duration(job.Config.CooldownMs) * time.Millisecond)
		}
		result := r.runOne(i, job.Config, patterns)
		r.store.UpdateRun(id, result)
	}

	r.finishJob(id)
}

// runAllWithScript invokes run-profile.sh and reads tti_ms files from its output.
func (r *Runner) runAllWithScript(id string, job *BenchmarkResult) {
	scriptPath := job.Config.ProfileScriptPath
	if scriptPath == "" {
		scriptPath = "run-profile.sh"
	}

	// Resolve to absolute path so cmd.Dir and the script argument are consistent.
	absScript, err := filepath.Abs(scriptPath)
	if err != nil {
		r.store.Finish(id, nil, fmt.Sprintf("resolve script path: %v", err))
		return
	}

	profilesDir := filepath.Join(job.DataDir, "profiles")
	if err := os.MkdirAll(profilesDir, 0755); err != nil {
		r.store.Finish(id, nil, fmt.Sprintf("create profiles dir: %v", err))
		return
	}

	timeoutSec := int(job.Config.Timeout.Seconds())
	if timeoutSec <= 0 {
		timeoutSec = 120
	}

	args := []string{
		absScript,
		"--runs", strconv.Itoa(job.Config.Runs),
		"--timeout", strconv.Itoa(timeoutSec),
		"--output-dir", profilesDir,
		"--no-report",
	}
	if job.Config.Binary != "" {
		args = append(args, "--gemini-path", job.Config.Binary)
	}

	totalTimeout := time.Duration(timeoutSec*job.Config.Runs)*time.Second + scriptGracePeriod
	ctx, cancel := context.WithTimeout(context.Background(), totalTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "bash", args...)
	cmd.Dir = filepath.Dir(absScript)
	out, err := cmd.CombinedOutput()
	if err != nil {
		r.store.Finish(id, nil, fmt.Sprintf("script failed: %v\n%s", err, out))
		return
	}

	// Read tti_ms files from combined/run_N/tti_ms
	for i := 0; i < job.Config.Runs; i++ {
		runDir := filepath.Join(profilesDir, "combined", fmt.Sprintf("run_%d", i+1))
		ttiFile := filepath.Join(runDir, "tti_ms")
		run := RunResult{RunIndex: i, ProfileDir: runDir}

		data, err := os.ReadFile(ttiFile)
		if err != nil {
			run.Error = fmt.Sprintf("read tti_ms: %v", err)
		} else {
			ms, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
			if err != nil {
				run.Error = fmt.Sprintf("parse tti_ms: %v", err)
			} else {
				run.TTIMs = &ms
			}
		}
		r.store.UpdateRun(id, run)
	}

	r.finishJob(id)
}

// finishJob reads current run state, computes stats, and marks the job done.
func (r *Runner) finishJob(id string) {
	job, _ := r.store.Get(id)
	if job == nil {
		return
	}
	stats := computeStats(job.Runs)
	r.store.Finish(id, stats, "")
}

func (r *Runner) runOne(idx int, cfg BenchmarkConfig, patterns []*regexp.Regexp) RunResult {
	result := RunResult{RunIndex: idx}

	ctx, cancel := context.WithTimeout(context.Background(), cfg.Timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, cfg.Binary, cfg.Args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 24, Cols: 80})
	if err != nil {
		result.Error = err.Error()
		return result
	}
	defer ptmx.Close()

	start := time.Now()
	found := make(chan int64, 1)

	go func() {
		scanner := bufio.NewScanner(ptmx)
		for scanner.Scan() {
			line := scanner.Text()
			for _, re := range patterns {
				if re.MatchString(line) {
					ms := time.Since(start).Milliseconds()
					select {
					case found <- ms:
					default:
					}
					return
				}
			}
		}
	}()

	select {
	case ms := <-found:
		result.TTIMs = &ms
	case <-ctx.Done():
		result.TimedOut = true
	}

	if cmd.Process != nil {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		done := make(chan struct{})
		go func() {
			_ = cmd.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			_ = cmd.Process.Kill()
		}
	}

	return result
}

func computeStats(runs []RunResult) *Statistics {
	var vals []int64
	for _, r := range runs {
		if r.TTIMs != nil {
			vals = append(vals, *r.TTIMs)
		}
	}
	if len(vals) == 0 {
		return nil
	}
	sort.Slice(vals, func(i, j int) bool { return vals[i] < vals[j] })
	n := int64(len(vals))
	var sum int64
	for _, v := range vals {
		sum += v
	}
	p95idx := int(float64(n-1) * 0.95)
	return &Statistics{
		N:        n,
		MinMs:    vals[0],
		MaxMs:    vals[n-1],
		AvgMs:    sum / n,
		MedianMs: vals[n/2],
		P95Ms:    vals[p95idx],
	}
}

func captureSystemInfo() *SystemInfo {
	info := &SystemInfo{
		GoVersion: runtime.Version(),
	}

	if out, err := exec.Command("uname", "-s").Output(); err == nil {
		info.OS = strings.TrimSpace(string(out))
	}
	if out, err := exec.Command("uname", "-r").Output(); err == nil {
		info.KernelVersion = strings.TrimSpace(string(out))
	}

	// CPU info from /proc/cpuinfo (Linux only; silently skipped on other platforms)
	if data, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		lines := strings.Split(string(data), "\n")
		for _, line := range lines {
			if strings.HasPrefix(line, "model name") && info.CPUModel == "" {
				parts := strings.SplitN(line, ":", 2)
				if len(parts) == 2 {
					info.CPUModel = strings.TrimSpace(parts[1])
				}
			}
			if strings.HasPrefix(line, "processor") {
				info.CPUCores++
			}
		}
	}

	// RAM from /proc/meminfo (Linux only; silently skipped on other platforms)
	if data, err := os.ReadFile("/proc/meminfo"); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "MemTotal:") {
				fields := strings.Fields(line)
				if len(fields) >= 2 {
					if kb, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
						info.TotalRAMMB = kb / 1024
					}
				}
				break
			}
		}
	}

	if out, err := exec.Command("node", "--version").Output(); err == nil {
		info.NodeVersion = strings.TrimSpace(string(out))
	}

	return info
}
