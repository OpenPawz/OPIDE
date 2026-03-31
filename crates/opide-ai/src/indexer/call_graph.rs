// ── Call Graph ───────────────────────────────────────────────────────────────
// Bidirectional call graph built from AST call sites.
// Answers: who calls X, what does X call, what breaks if X changes.

use super::types::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};

// ─── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallEdge {
    pub from_file: String,
    pub from_function: String,
    pub from_line: usize,
    pub to_function: String,
    pub to_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CallGraph {
    /// function → [functions it calls]
    callees: HashMap<String, Vec<CallEdge>>,
    /// function → [functions that call it]
    callers: HashMap<String, Vec<CallEdge>>,
}

// ─── Build ──────────────────────────────────────────────────────────────────

impl CallGraph {
    /// Build the call graph from a ProjectIndex.
    pub fn build(project: &ProjectIndex) -> Self {
        let mut graph = CallGraph::default();

        // Build a map of exported symbols → file path for cross-file resolution
        let mut export_map: HashMap<String, String> = HashMap::new();
        for file in &project.files {
            for export in &file.exports {
                export_map.insert(export.name.clone(), file.path.clone());
            }
            // Also map function declarations
            for symbol in &file.symbols {
                if symbol.exported {
                    export_map.insert(symbol.name.clone(), file.path.clone());
                }
            }
        }

        // Build import resolution: file → { imported_name → source_file }
        let mut import_resolution: HashMap<String, HashMap<String, String>> = HashMap::new();
        for file in &project.files {
            let mut file_imports: HashMap<String, String> = HashMap::new();
            for imp in &file.imports {
                // Resolve the import source to a file path
                let resolved = if imp.source.starts_with('.') {
                    super::resolve_import_path(&file.path, &imp.source)
                } else {
                    imp.source.clone()
                };

                for name in &imp.names {
                    // Check if the resolved path has this export
                    let target_file = export_map.get(name).cloned().unwrap_or(resolved.clone());
                    file_imports.insert(name.clone(), target_file);
                }

                if imp.is_default {
                    for name in &imp.names {
                        let target_file = export_map.get(name).cloned().unwrap_or(resolved.clone());
                        file_imports.insert(name.clone(), target_file);
                    }
                }
            }
            import_resolution.insert(file.path.clone(), file_imports);
        }

        // Process all call sites
        for file in &project.files {
            let file_imports = import_resolution.get(&file.path);

            for call in &file.call_sites {
                // Resolve callee to a file
                let to_file = file_imports
                    .and_then(|imports| imports.get(&call.callee_name).cloned())
                    .or_else(|| {
                        // If the callee is defined in the same file, use this file
                        if file.symbols.iter().any(|s| s.name == call.callee_name) {
                            Some(file.path.clone())
                        } else {
                            None
                        }
                    });

                let edge = CallEdge {
                    from_file: file.path.clone(),
                    from_function: call.caller_function.clone(),
                    from_line: call.caller_line,
                    to_function: call.callee_name.clone(),
                    to_file: to_file.clone(),
                };

                // Forward: caller → callee
                let caller_key = if call.caller_function.is_empty() {
                    format!("{}:<module>", file.path)
                } else {
                    format!("{}:{}", file.path, call.caller_function)
                };
                graph.callees.entry(caller_key).or_default().push(edge.clone());

                // Reverse: callee → caller
                let callee_key = if let Some(ref tf) = to_file {
                    format!("{}:{}", tf, call.callee_name)
                } else {
                    call.callee_name.clone()
                };
                graph.callers.entry(callee_key).or_default().push(edge);
            }
        }

        graph
    }

    // ─── Queries ────────────────────────────────────────────────────────

    /// Who calls this function? Returns all call sites that invoke it.
    pub fn callers_of(&self, function: &str) -> Vec<&CallEdge> {
        // Try exact key first, then search by function name
        if let Some(edges) = self.callers.get(function) {
            return edges.iter().collect();
        }

        // Search by function name across all keys
        let mut results = Vec::new();
        for (key, edges) in &self.callers {
            if key.ends_with(&format!(":{}", function)) || key == function {
                results.extend(edges.iter());
            }
        }
        results
    }

    /// What does this function call?
    pub fn callees_of(&self, function: &str) -> Vec<&CallEdge> {
        if let Some(edges) = self.callees.get(function) {
            return edges.iter().collect();
        }

        let mut results = Vec::new();
        for (key, edges) in &self.callees {
            if key.ends_with(&format!(":{}", function)) || key == function {
                results.extend(edges.iter());
            }
        }
        results
    }

    /// Impact analysis: all functions transitively affected by changing this function.
    /// BFS through the callers graph.
    pub fn impact_of(&self, function: &str) -> Vec<String> {
        let mut visited: HashSet<String> = HashSet::new();
        let mut queue: VecDeque<String> = VecDeque::new();
        let mut impact: Vec<String> = Vec::new();

        // Seed with direct callers
        let direct = self.callers_of(function);
        for edge in &direct {
            let key = format!("{}:{}", edge.from_file, edge.from_function);
            if visited.insert(key.clone()) {
                queue.push_back(key.clone());
                impact.push(format!("{}:{} (line {})", edge.from_file, edge.from_function, edge.from_line));
            }
        }

        // BFS through transitive callers
        while let Some(current) = queue.pop_front() {
            let func_name = current.split(':').last().unwrap_or(&current);
            let callers = self.callers_of(func_name);
            for edge in callers {
                let key = format!("{}:{}", edge.from_file, edge.from_function);
                if visited.insert(key.clone()) {
                    queue.push_back(key.clone());
                    impact.push(format!("{}:{} (line {})", edge.from_file, edge.from_function, edge.from_line));
                }
            }
        }

        impact
    }

    /// Total number of edges in the graph.
    pub fn edge_count(&self) -> usize {
        self.callees.values().map(|v| v.len()).sum()
    }

    /// Total unique functions in the graph.
    pub fn function_count(&self) -> usize {
        let mut funcs: HashSet<&str> = HashSet::new();
        for key in self.callees.keys() {
            funcs.insert(key);
        }
        for key in self.callers.keys() {
            funcs.insert(key);
        }
        funcs.len()
    }

    /// Get the most-called functions (hot paths).
    pub fn hot_functions(&self, limit: usize) -> Vec<(String, usize)> {
        let mut counts: Vec<(String, usize)> = self.callers
            .iter()
            .map(|(k, v)| (k.clone(), v.len()))
            .collect();
        counts.sort_by(|a, b| b.1.cmp(&a.1));
        counts.truncate(limit);
        counts
    }
}
