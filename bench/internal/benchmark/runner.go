package benchmark

import (
	"bufio"
	"context"
	"os/exec"
	"regexp"
	"sort"
	"syscall"
	"time"

	"github.com/creack/pty"
)

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

	// compute stats from completed runs
	job2, _ := r.store.Get(id)
	stats := computeStats(job2.Runs)
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

	// graceful shutdown
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
