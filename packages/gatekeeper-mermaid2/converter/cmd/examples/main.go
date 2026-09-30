// Generates D2 companions for the curated Mermaid examples during the build.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/noamsto/mermaid2d2"
)

func main() {
	var catalog map[string]map[string]string
	if err := json.NewDecoder(os.Stdin).Decode(&catalog); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for key, example := range catalog {
		if example["d2"] != "" || example["mermaid"] == "" {
			continue
		}
		source, err := mermaid2d2.MermaidToD2(example["mermaid"])
		if err != nil {
			fmt.Fprintf(os.Stderr, "example %s: %v\n", key, err)
			os.Exit(1)
		}
		example["d2"] = source
	}
	if err := json.NewEncoder(os.Stdout).Encode(catalog); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
