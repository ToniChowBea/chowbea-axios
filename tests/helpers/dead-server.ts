import { createServer, type Server } from "node:http";

/**
 * Creates a local HTTP server that immediately returns 503 Service Unavailable.
 *
 * Windows TCP stack retries SYN to closed localhost ports (~2s per attempt),
 * causing tests with `http://127.0.0.1:1/...` to timeout. This server fails
 * deterministically and fast across all platforms.
 *
 * Returns the server instance and its URL. Caller must close the server when done.
 */
export function createDeadServer(): Promise<{ server: Server; url: string }> {
	return new Promise((resolve) => {
		const server = createServer((_req, res) => {
			res.writeHead(503, { "Content-Type": "text/plain" });
			res.end("Service Unavailable\n");
		});

		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				throw new Error("Server did not bind to a port");
			}

			const url = `http://127.0.0.1:${address.port}`;
			resolve({ server, url });
		});
	});
}
