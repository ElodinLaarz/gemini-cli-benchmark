package profile

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

type traceEvent struct {
	Name string                 `json:"name"`
	Ph   string                 `json:"ph"`
	Ts   float64                `json:"ts"`
	Dur  float64                `json:"dur"`
	Args map[string]interface{} `json:"args"`
}

type traceSpan struct {
	name  string
	ts    float64
	endTs float64
	dur   float64
}

// ParseWallTrace parses a wall_trace.json (Chrome trace format) and returns a flame graph tree.
func ParseWallTrace(path string) (*FlameNode, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	// The file may be a JSON array directly, or wrapped in {"traceEvents": [...]}
	var events []traceEvent
	if err := json.Unmarshal(data, &events); err != nil {
		var wrapped struct {
			TraceEvents []traceEvent `json:"traceEvents"`
		}
		if err2 := json.Unmarshal(data, &wrapped); err2 != nil {
			return nil, fmt.Errorf("parse wall trace: %w", err)
		}
		events = wrapped.TraceEvents
	}

	if len(events) == 0 {
		return nil, fmt.Errorf("empty wall trace")
	}

	return buildWallTree(events), nil
}

// FindWallTrace looks for wall_trace.json in dir.
func FindWallTrace(dir string) (string, error) {
	path := filepath.Join(dir, "wall_trace.json")
	if _, err := os.Stat(path); err != nil {
		return "", fmt.Errorf("wall_trace.json not found in %s", dir)
	}
	return path, nil
}

// buildWallTree builds a flame graph tree from Chrome trace events.
// Handles "X" (complete), "B" (begin), and "E" (end) phase events.
func buildWallTree(events []traceEvent) *FlameNode {
	root := &FlameNode{Name: "(root)"}

	var spans []traceSpan

	// Expand B/E pairs; collect X events
	beginStack := make([]traceEvent, 0)
	for _, e := range events {
		switch e.Ph {
		case "X":
			spans = append(spans, traceSpan{name: e.Name, ts: e.Ts, endTs: e.Ts + e.Dur, dur: e.Dur})
		case "B":
			beginStack = append(beginStack, e)
		case "E":
			if len(beginStack) > 0 {
				begin := beginStack[len(beginStack)-1]
				beginStack = beginStack[:len(beginStack)-1]
				dur := e.Ts - begin.Ts
				spans = append(spans, traceSpan{name: begin.Name, ts: begin.Ts, endTs: e.Ts, dur: dur})
			}
		}
	}

	if len(spans) == 0 {
		return root
	}

	// Sort by start time ascending, then by duration descending (parents before children).
	sort.Slice(spans, func(i, j int) bool {
		if spans[i].ts != spans[j].ts {
			return spans[i].ts < spans[j].ts
		}
		return spans[i].dur > spans[j].dur
	})

	type stackEntry struct {
		node  *FlameNode
		endTs float64
	}
	stack := []stackEntry{{node: root, endTs: 1e18}}

	for _, s := range spans {
		node := &FlameNode{
			Name:    s.name,
			TotalMs: s.dur / 1000.0, // μs -> ms
			SelfMs:  s.dur / 1000.0,
		}

		// Pop stack entries whose span ended before this span starts
		for len(stack) > 1 && stack[len(stack)-1].endTs <= s.ts {
			stack = stack[:len(stack)-1]
		}

		parent := stack[len(stack)-1].node
		parent.Children = append(parent.Children, node)
		parent.SelfMs -= node.TotalMs

		stack = append(stack, stackEntry{node: node, endTs: s.endTs})
	}

	return root
}
