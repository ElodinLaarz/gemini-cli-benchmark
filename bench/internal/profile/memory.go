package profile

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

type MemSnapshot struct {
	Module    string  `json:"module"`
	RSS       int64   `json:"rss"`
	HeapUsed  int64   `json:"heapUsed"`
	HeapTotal int64   `json:"heapTotal"`
	External  int64   `json:"external"`
	Timestamp float64 `json:"timestamp"`
}

type TimePoint struct {
	TsMs      float64 `json:"tsMs"`
	RSS       int64   `json:"rss"`
	HeapUsed  int64   `json:"heapUsed"`
	HeapTotal int64   `json:"heapTotal"`
	External  int64   `json:"external"`
}

type ModuleMemory struct {
	Module  string `json:"module"`
	DeltaKB int64  `json:"deltaKB"`
}

type MemoryData struct {
	Timeline    []TimePoint    `json:"timeline"`
	Attribution []ModuleMemory `json:"attribution"`
}

// ParseMemTrace parses a mem_trace.json file and returns timeline + module attribution.
func ParseMemTrace(path string) (*MemoryData, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var snapshots []MemSnapshot
	if err := json.Unmarshal(data, &snapshots); err != nil {
		return nil, fmt.Errorf("parse mem trace: %w", err)
	}
	if len(snapshots) == 0 {
		return nil, fmt.Errorf("empty mem trace")
	}
	return buildMemoryData(snapshots), nil
}

// FindMemTrace looks for mem_trace.json in dir.
func FindMemTrace(dir string) (string, error) {
	path := filepath.Join(dir, "mem_trace.json")
	if _, err := os.Stat(path); err != nil {
		return "", fmt.Errorf("mem_trace.json not found in %s", dir)
	}
	return path, nil
}

func buildMemoryData(snapshots []MemSnapshot) *MemoryData {
	result := &MemoryData{}

	// Build timeline from all snapshots
	startTs := snapshots[0].Timestamp
	for _, s := range snapshots {
		result.Timeline = append(result.Timeline, TimePoint{
			TsMs:      (s.Timestamp - startTs) / 1e6, // ns -> ms (if nanoseconds)
			RSS:       s.RSS,
			HeapUsed:  s.HeapUsed,
			HeapTotal: s.HeapTotal,
			External:  s.External,
		})
	}

	// Build per-module heap attribution: delta heapUsed between consecutive snapshots
	// grouped by module name
	modDelta := make(map[string]int64)
	for i := 1; i < len(snapshots); i++ {
		prev, cur := snapshots[i-1], snapshots[i]
		delta := (cur.HeapUsed - prev.HeapUsed) / 1024 // bytes -> KB
		if delta > 0 && cur.Module != "" {
			modDelta[cur.Module] += delta
		}
	}

	for mod, delta := range modDelta {
		result.Attribution = append(result.Attribution, ModuleMemory{Module: mod, DeltaKB: delta})
	}
	sort.Slice(result.Attribution, func(i, j int) bool {
		return result.Attribution[i].DeltaKB > result.Attribution[j].DeltaKB
	})

	return result
}
