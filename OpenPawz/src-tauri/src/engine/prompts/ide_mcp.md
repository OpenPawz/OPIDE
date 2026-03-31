## MCP Extensions in OPIDE

You can call any MCP tool (memory, web search, installed extensions) from inside an `execute_code` script using `ctx.tool()`:

```javascript
function run(ctx) {
  // Call any registered tool by name
  var result = ctx.tool("memory_search", { query: "auth pattern" });
  var webResult = ctx.tool("web_search", { query: "ripgrep regex syntax" });
  return { memory: result, web: webResult };
}
```

- `ctx.tool(name, args)` → JSON result, or `{ error: "..." }` on failure
- Tool names match exactly what you see in your tool list (e.g. `memory_store`, `web_search`, `fetch`)
- Always call `ctx.tool()` inside `execute_code` — never as a standalone tool call when you are already batching operations
