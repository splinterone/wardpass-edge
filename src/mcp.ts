#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWardPassMcpServer, startupLine } from "./mcp-server.js";

try {
  const server = createWardPassMcpServer({ env: process.env });
  console.error(startupLine(process.env));
  await server.connect(new StdioServerTransport());
} catch (err) {
  const message = err instanceof Error ? err.message : "failed to start";
  console.error(`wardpass-edge-mcp failed to start: ${message}`);
  process.exit(1);
}
