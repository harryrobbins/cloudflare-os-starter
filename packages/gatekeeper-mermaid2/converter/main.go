// This bridge only converts syntax. D2.js performs layout and rendering.
package main

import (
	"encoding/json"
	"fmt"
	"syscall/js"

	"github.com/noamsto/mermaid2d2"
)

func convert(_ js.Value, args []js.Value) (result any) {
	response := struct {
		Source string `json:"source,omitempty"`
		Error  string `json:"error,omitempty"`
	}{}
	defer func() {
		if recovered := recover(); recovered != nil {
			response.Source = ""
			response.Error = fmt.Sprintf("Mermaid conversion failed: %v", recovered)
		}
		encoded, _ := json.Marshal(response)
		result = string(encoded)
	}()
	if len(args) != 1 || args[0].Type() != js.TypeString {
		response.Error = "Expected Mermaid source text."
		return
	}
	var err error
	response.Source, err = mermaid2d2.MermaidToD2(args[0].String())
	if err != nil {
		response.Error = err.Error()
	}
	return
}

func main() {
	js.Global().Set("mermaidToD2", js.FuncOf(convert))
	select {}
}
