package profile

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// FlameNode is a node in the flame graph tree.
type FlameNode struct {
	Name     string       `json:"name"`
	TotalMs  float64      `json:"totalMs"`
	SelfMs   float64      `json:"selfMs"`
	Children []*FlameNode `json:"children,omitempty"`
}

type v8Profile struct {
	Nodes []struct {
		ID        int `json:"id"`
		CallFrame struct {
			FunctionName string `json:"functionName"`
			URL          string `json:"url"`
			LineNumber   int    `json:"lineNumber"`
		} `json:"callFrame"`
		Children []int `json:"children"`
	} `json:"nodes"`
	Samples    []int   `json:"samples"`
	TimeDeltas []int64 `json:"timeDeltas"`
}

// ParseCPUProfile parses a V8 .cpuprofile file and returns a flame graph tree.
func ParseCPUProfile(path string) (*FlameNode, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var p v8Profile
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, fmt.Errorf("parse cpuprofile: %w", err)
	}
	if len(p.Nodes) == 0 {
		return nil, fmt.Errorf("empty cpuprofile")
	}
	return buildCPUTree(&p), nil
}

// FindCPUProfile looks for a .cpuprofile file in dir and returns the first found.
func FindCPUProfile(dir string) (string, error) {
	matches, err := filepath.Glob(filepath.Join(dir, "*.cpuprofile"))
	if err != nil {
		return "", err
	}
	if len(matches) == 0 {
		return "", fmt.Errorf("no .cpuprofile found in %s", dir)
	}
	return matches[0], nil
}

func buildCPUTree(p *v8Profile) *FlameNode {
	// Build id->node map and parent map
	type nodeInfo struct {
		name     string
		url      string
		children []int
	}
	nodes := make(map[int]*nodeInfo, len(p.Nodes))
	for _, n := range p.Nodes {
		name := n.CallFrame.FunctionName
		if name == "" {
			name = "(anonymous)"
		}
		nodes[n.ID] = &nodeInfo{
			name:     name,
			url:      n.CallFrame.URL,
			children: n.Children,
		}
	}

	// Build parent map
	parent := make(map[int]int, len(p.Nodes))
	for _, n := range p.Nodes {
		for _, child := range n.Children {
			parent[child] = n.ID
		}
	}

	// Find root (node with no parent, usually id=1)
	var rootID int
	for _, n := range p.Nodes {
		if _, hasParent := parent[n.ID]; !hasParent {
			rootID = n.ID
			break
		}
	}

	// Accumulate self time per node from samples+timeDeltas
	selfTime := make(map[int]float64, len(p.Nodes))
	for i, sampleID := range p.Samples {
		var dt float64
		if i < len(p.TimeDeltas) {
			dt = float64(p.TimeDeltas[i]) / 1000.0 // μs -> ms
		}
		selfTime[sampleID] += dt
	}

	// Accumulate total time: for each sample, walk up the call stack
	totalTime := make(map[int]float64, len(p.Nodes))
	for i, sampleID := range p.Samples {
		var dt float64
		if i < len(p.TimeDeltas) {
			dt = float64(p.TimeDeltas[i]) / 1000.0
		}
		// Walk up from leaf to root, adding time to each ancestor
		visited := make(map[int]bool)
		cur := sampleID
		for cur != 0 {
			if visited[cur] {
				break
			}
			visited[cur] = true
			totalTime[cur] += dt
			cur = parent[cur]
		}
	}

	// Recursively build FlameNode tree
	var buildNode func(id int) *FlameNode
	buildNode = func(id int) *FlameNode {
		n, ok := nodes[id]
		if !ok {
			return nil
		}
		label := n.name
		if n.url != "" && !strings.HasPrefix(n.url, "node:") {
			// Show just the filename part of the URL
			parts := strings.Split(n.url, "/")
			label = fmt.Sprintf("%s (%s)", n.name, parts[len(parts)-1])
		}
		node := &FlameNode{
			Name:    label,
			TotalMs: totalTime[id],
			SelfMs:  selfTime[id],
		}
		for _, childID := range n.children {
			if child := buildNode(childID); child != nil {
				node.Children = append(node.Children, child)
			}
		}
		return node
	}

	return buildNode(rootID)
}
