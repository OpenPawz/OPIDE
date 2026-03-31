// ── Type Graph ───────────────────────────────────────────────────────────────
// Maps type relationships: extends, implements, usages.
// Answers: what does X extend, what implements X, where is X used as a type.

use super::types::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ─── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TypeRelationKind {
    Extends,
    Implements,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypeRelation {
    pub name: String,
    pub file: String,
    pub line: usize,
    pub kind: TypeRelationKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypeUsage {
    pub file: String,
    pub line: usize,
    pub context: String, // "parameter", "return_type", "variable", "field"
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TypeGraph {
    /// type_name → [types it extends/implements]
    parents: HashMap<String, Vec<TypeRelation>>,
    /// type_name → [types that extend/implement it]
    children: HashMap<String, Vec<TypeRelation>>,
    /// type_name → [locations where this type is used]
    usages: HashMap<String, Vec<TypeUsage>>,
    /// type_name → file where it's defined
    definitions: HashMap<String, String>,
}

// ─── Build ──────────────────────────────────────────────────────────────────

impl TypeGraph {
    /// Build the type graph from a ProjectIndex.
    pub fn build(project: &ProjectIndex) -> Self {
        let mut graph = TypeGraph::default();

        // First pass: collect all type definitions
        for file in &project.files {
            for symbol in &file.symbols {
                match symbol.kind {
                    SymbolKind::Interface | SymbolKind::Type | SymbolKind::Class
                    | SymbolKind::Struct | SymbolKind::Enum => {
                        graph.definitions.insert(symbol.name.clone(), file.path.clone());
                    }
                    _ => {}
                }
            }
        }

        // Second pass: process type references
        for file in &project.files {
            for type_ref in &file.type_refs {
                match type_ref.kind {
                    TypeRefKind::Extends => {
                        // Find which type in this file extends type_ref.name
                        // The extending type is the one declared near this line
                        let extender = find_type_at_line(&file.symbols, type_ref.line);
                        if let Some(extender_name) = extender {
                            // extender extends type_ref.name
                            graph.parents.entry(extender_name.clone()).or_default().push(TypeRelation {
                                name: type_ref.name.clone(),
                                file: file.path.clone(),
                                line: type_ref.line,
                                kind: TypeRelationKind::Extends,
                            });
                            // type_ref.name is extended by extender
                            graph.children.entry(type_ref.name.clone()).or_default().push(TypeRelation {
                                name: extender_name,
                                file: file.path.clone(),
                                line: type_ref.line,
                                kind: TypeRelationKind::Extends,
                            });
                        }
                    }
                    TypeRefKind::Implements => {
                        let implementor = find_type_at_line(&file.symbols, type_ref.line);
                        if let Some(impl_name) = implementor {
                            graph.parents.entry(impl_name.clone()).or_default().push(TypeRelation {
                                name: type_ref.name.clone(),
                                file: file.path.clone(),
                                line: type_ref.line,
                                kind: TypeRelationKind::Implements,
                            });
                            graph.children.entry(type_ref.name.clone()).or_default().push(TypeRelation {
                                name: impl_name,
                                file: file.path.clone(),
                                line: type_ref.line,
                                kind: TypeRelationKind::Implements,
                            });
                        }
                    }
                    TypeRefKind::Parameter => {
                        graph.usages.entry(type_ref.name.clone()).or_default().push(TypeUsage {
                            file: file.path.clone(),
                            line: type_ref.line,
                            context: "parameter".to_string(),
                        });
                    }
                    TypeRefKind::ReturnType => {
                        graph.usages.entry(type_ref.name.clone()).or_default().push(TypeUsage {
                            file: file.path.clone(),
                            line: type_ref.line,
                            context: "return_type".to_string(),
                        });
                    }
                    TypeRefKind::Variable => {
                        graph.usages.entry(type_ref.name.clone()).or_default().push(TypeUsage {
                            file: file.path.clone(),
                            line: type_ref.line,
                            context: "variable".to_string(),
                        });
                    }
                    TypeRefKind::Field => {
                        graph.usages.entry(type_ref.name.clone()).or_default().push(TypeUsage {
                            file: file.path.clone(),
                            line: type_ref.line,
                            context: "field".to_string(),
                        });
                    }
                }
            }
        }

        graph
    }

    // ─── Queries ────────────────────────────────────────────────────────

    /// What does this type extend or implement?
    pub fn parents_of(&self, type_name: &str) -> Vec<&TypeRelation> {
        self.parents.get(type_name).map(|v| v.iter().collect()).unwrap_or_default()
    }

    /// What extends or implements this type?
    pub fn children_of(&self, type_name: &str) -> Vec<&TypeRelation> {
        self.children.get(type_name).map(|v| v.iter().collect()).unwrap_or_default()
    }

    /// Where is this type used (as parameter, return type, variable, field)?
    pub fn usages_of(&self, type_name: &str) -> Vec<&TypeUsage> {
        self.usages.get(type_name).map(|v| v.iter().collect()).unwrap_or_default()
    }

    /// Where is this type defined?
    pub fn definition_of(&self, type_name: &str) -> Option<&String> {
        self.definitions.get(type_name)
    }

    /// Is it safe to change this type? Returns files/locations that use it.
    pub fn impact_of_type_change(&self, type_name: &str) -> Vec<String> {
        let mut impact = Vec::new();

        // All usages
        for usage in self.usages_of(type_name) {
            impact.push(format!("{}:{} ({})", usage.file, usage.line, usage.context));
        }

        // All children (types that extend/implement this)
        for child in self.children_of(type_name) {
            impact.push(format!("{}:{} ({} {:?})", child.file, child.line, child.name, child.kind));
        }

        impact
    }

    /// Get the full inheritance chain for a type (walking up through parents).
    pub fn ancestry_of(&self, type_name: &str) -> Vec<String> {
        let mut chain = Vec::new();
        let mut current = type_name.to_string();
        let mut visited = std::collections::HashSet::new();

        loop {
            if !visited.insert(current.clone()) { break; } // cycle protection
            let parents = self.parents_of(&current);
            if parents.is_empty() { break; }
            // Take the first parent (extends, not implements)
            if let Some(parent) = parents.iter().find(|p| matches!(p.kind, TypeRelationKind::Extends)) {
                chain.push(parent.name.clone());
                current = parent.name.clone();
            } else {
                break;
            }
        }

        chain
    }

    /// Total types tracked.
    pub fn type_count(&self) -> usize {
        self.definitions.len()
    }

    /// Total relationships.
    pub fn relation_count(&self) -> usize {
        self.parents.values().map(|v| v.len()).sum::<usize>()
            + self.children.values().map(|v| v.len()).sum::<usize>()
            + self.usages.values().map(|v| v.len()).sum::<usize>()
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Find the type (class/interface/struct) that contains a given line.
fn find_type_at_line(symbols: &[Symbol], line: usize) -> Option<String> {
    symbols.iter()
        .filter(|s| matches!(s.kind, SymbolKind::Class | SymbolKind::Interface | SymbolKind::Struct))
        .filter(|s| s.start_line <= line && s.end_line >= line)
        .min_by_key(|s| s.end_line - s.start_line) // innermost type
        .map(|s| s.name.clone())
}
